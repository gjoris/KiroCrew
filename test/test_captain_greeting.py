"""Captain's first greeting: once-only, Captain-only, and a hidden kickoff.

Each guard in :mod:`kiro_crew.dashboard.captain_greeting` has a test here that
fails when the guard is removed: the marker claim (two calls start one turn),
the Captain identity check (another crewmate never greets), the emptiness and
busy checks, and the "no transcript row" property of the dispatch itself.
"""

from __future__ import annotations

import asyncio
from unittest.mock import patch

import pytest
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer
from chat_test_helpers import _make_state

from kiro_crew.agent_files import ASSISTANT_MEMBER_NAME
from kiro_crew.dashboard import captain_greeting as cg
from kiro_crew.members import DM_SLOT_MODE, member_slot_key, write_dm_binding

CAPTAIN_SLUG = "kirocrew-captain"
OTHER_SLUG = "code-reviewer"


def _bind_thread(state, slug: str, member: str):
    key = member_slot_key(slug)
    write_dm_binding(slug, member=member, slot_key=key)
    return state.get_or_create_slot(key, agent=member, mode=DM_SLOT_MODE)


class _Dispatched:
    """Stand-in for ``_dispatch_greeting`` that records each dispatch."""

    def __init__(self) -> None:
        self.slots: list[str] = []

    def __call__(self, state, slot) -> None:
        self.slots.append(slot.key)


@pytest.fixture
def dispatched():
    recorder = _Dispatched()
    with patch.object(cg, "_dispatch_greeting", recorder):
        yield recorder


class TestGreetingGuards:
    @pytest.mark.asyncio
    async def test_empty_captain_thread_greets_once(self, tmp_path, dispatched):
        state = _make_state(tmp_path)
        slot = _bind_thread(state, CAPTAIN_SLUG, ASSISTANT_MEMBER_NAME)
        assert await cg.maybe_start_captain_greeting(state, CAPTAIN_SLUG) == cg.STARTED
        assert dispatched.slots == [slot.key]
        assert cg.greeting_marker_path(CAPTAIN_SLUG).is_file()
        # Reload / second tab / retry after a failed turn: the thread is still
        # empty, but the persisted marker refuses a second greeting.
        assert await cg.maybe_start_captain_greeting(state, CAPTAIN_SLUG) == cg.ALREADY_GREETED
        assert dispatched.slots == [slot.key]

    @pytest.mark.asyncio
    async def test_concurrent_opens_start_exactly_one_turn(self, tmp_path, dispatched):
        state = _make_state(tmp_path)
        _bind_thread(state, CAPTAIN_SLUG, ASSISTANT_MEMBER_NAME)
        outcomes = await asyncio.gather(
            *(cg.maybe_start_captain_greeting(state, CAPTAIN_SLUG) for _ in range(5))
        )
        assert outcomes.count(cg.STARTED) == 1
        assert len(dispatched.slots) == 1

    @pytest.mark.asyncio
    async def test_other_crewmates_never_greet(self, tmp_path, dispatched):
        state = _make_state(tmp_path)
        _bind_thread(state, OTHER_SLUG, "code-reviewer")
        assert await cg.maybe_start_captain_greeting(state, OTHER_SLUG) == cg.NOT_CAPTAIN
        assert dispatched.slots == []
        assert not cg.greeting_marker_path(OTHER_SLUG).exists()

    @pytest.mark.asyncio
    async def test_a_slot_not_pinned_to_captain_never_greets(self, tmp_path, dispatched):
        """The binding says Captain, but the live slot runs as someone else."""
        state = _make_state(tmp_path)
        key = member_slot_key(CAPTAIN_SLUG)
        write_dm_binding(CAPTAIN_SLUG, member=ASSISTANT_MEMBER_NAME, slot_key=key)
        state.get_or_create_slot(key, agent="code-reviewer", mode=DM_SLOT_MODE)
        assert await cg.maybe_start_captain_greeting(state, CAPTAIN_SLUG) == cg.NO_THREAD
        assert dispatched.slots == []

    @pytest.mark.asyncio
    async def test_a_thread_with_messages_never_greets(self, tmp_path, dispatched):
        state = _make_state(tmp_path)
        slot = _bind_thread(state, CAPTAIN_SLUG, ASSISTANT_MEMBER_NAME)
        slot.append("user", "hi", "msg msg-u")
        assert await cg.maybe_start_captain_greeting(state, CAPTAIN_SLUG) == cg.NOT_EMPTY
        assert dispatched.slots == []
        # Declining does not spend the once-only marker.
        assert not cg.greeting_marker_path(CAPTAIN_SLUG).exists()

    @pytest.mark.asyncio
    async def test_a_running_thread_never_greets(self, tmp_path, dispatched):
        state = _make_state(tmp_path)
        slot = _bind_thread(state, CAPTAIN_SLUG, ASSISTANT_MEMBER_NAME)
        never = asyncio.get_running_loop().create_future()
        slot.task = asyncio.ensure_future(never)
        try:
            assert await cg.maybe_start_captain_greeting(state, CAPTAIN_SLUG) == cg.BUSY
        finally:
            slot.task.cancel()
        assert dispatched.slots == []
        assert not cg.greeting_marker_path(CAPTAIN_SLUG).exists()

    @pytest.mark.asyncio
    async def test_no_live_thread_never_greets(self, tmp_path, dispatched):
        state = _make_state(tmp_path)
        write_dm_binding(
            CAPTAIN_SLUG, member=ASSISTANT_MEMBER_NAME, slot_key=member_slot_key(CAPTAIN_SLUG)
        )
        assert await cg.maybe_start_captain_greeting(state, CAPTAIN_SLUG) == cg.NO_THREAD
        assert dispatched.slots == []


class TestHiddenKickoff:
    @pytest.mark.asyncio
    async def test_dispatch_runs_the_kickoff_without_a_transcript_row(self, tmp_path):
        state = _make_state(tmp_path)
        slot = _bind_thread(state, CAPTAIN_SLUG, ASSISTANT_MEMBER_NAME)
        seen: list[tuple[str, dict]] = []

        async def fake_run_chat(_state, _slot, message, **kwargs):
            seen.append((message, kwargs))
            _slot.append("assistant", "Hi, I'm Captain. What should I call you?", "msg")

        with patch("kiro_crew.dashboard.chat._run_chat", fake_run_chat):
            assert await cg.maybe_start_captain_greeting(state, CAPTAIN_SLUG) == cg.STARTED
            assert slot.task is not None
            await slot.task
        assert seen == [
            (cg.CAPTAIN_GREETING_KICKOFF, {"_synthetic_payload": True, "_turn_actor": "gateway"})
        ]
        # The kickoff is never written to the transcript: the only row is
        # Captain's own greeting.
        roles = [(m["role"], m["content"]) for m in slot.messages]
        assert roles == [("assistant", "Hi, I'm Captain. What should I call you?")]
        assert all(cg.CAPTAIN_GREETING_KICKOFF not in m["content"] for m in slot.messages)

    def test_kickoff_carries_the_tag_the_role_prompt_names(self):
        from kiro_crew.agent import _ASSISTANT_SYSTEM_PROMPT

        tag = "[Captain first greeting]"
        assert cg.CAPTAIN_GREETING_KICKOFF.startswith(tag)
        assert tag in _ASSISTANT_SYSTEM_PROMPT
        assert "learn_add" in _ASSISTANT_SYSTEM_PROMPT
        # The kickoff repeats the naming rule so the greeting turn cannot read a
        # name off the home path the session context shows.
        assert "do not welcome them back" in cg.CAPTAIN_GREETING_KICKOFF
        assert "never one taken from a username" in cg.CAPTAIN_GREETING_KICKOFF
        # ...and the self-introduction comes before the address question.
        assert "introduce yourself by your name" in cg.CAPTAIN_GREETING_KICKOFF
        # Length and content live in ONE place, the role rule; the kickoff never
        # restates a sentence count that could drift from it.
        assert "sentence" not in cg.CAPTAIN_GREETING_KICKOFF
        assert '"First greeting and names"' in cg.CAPTAIN_GREETING_KICKOFF
        assert "### First greeting and names" in _ASSISTANT_SYSTEM_PROMPT


def _greet_app(state) -> web.Application:
    from kiro_crew.dashboard.handlers.members import api_member_greet

    @web.middleware
    async def _auth(request: web.Request, handler):
        request["app"] = request.headers.get("X-Test-App", "")
        request["user"] = request.headers.get("X-Test-User", "local-app")
        return await handler(request)

    app = web.Application(middlewares=[_auth])
    app["state"] = state
    app.router.add_post("/api/members/{slug}/greet", api_member_greet)
    return app


class TestGreetRoute:
    @pytest.mark.asyncio
    async def test_owner_gets_the_outcome(self, tmp_path, dispatched):
        state = _make_state(tmp_path)
        _bind_thread(state, CAPTAIN_SLUG, ASSISTANT_MEMBER_NAME)
        async with TestClient(TestServer(_greet_app(state))) as client:
            first = await client.post(f"/api/members/{CAPTAIN_SLUG}/greet")
            second = await client.post(f"/api/members/{CAPTAIN_SLUG}/greet")
            assert first.status == 200 and (await first.json()) == {"outcome": cg.STARTED}
            assert (await second.json()) == {"outcome": cg.ALREADY_GREETED}
        assert len(dispatched.slots) == 1

    @pytest.mark.asyncio
    async def test_app_token_is_refused(self, tmp_path, dispatched):
        state = _make_state(tmp_path)
        _bind_thread(state, CAPTAIN_SLUG, ASSISTANT_MEMBER_NAME)
        async with TestClient(TestServer(_greet_app(state))) as client:
            resp = await client.post(
                f"/api/members/{CAPTAIN_SLUG}/greet", headers={"X-Test-App": "some-app"}
            )
            assert resp.status == 404
        assert dispatched.slots == []

    @pytest.mark.asyncio
    async def test_bad_slug_is_400(self, tmp_path, dispatched):
        state = _make_state(tmp_path)
        async with TestClient(TestServer(_greet_app(state))) as client:
            resp = await client.post("/api/members/Not_A_Slug/greet")
            assert resp.status == 400
        assert dispatched.slots == []
