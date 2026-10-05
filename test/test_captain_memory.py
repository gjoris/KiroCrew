"""Captain's private memory, its read-only view of Global memory, and the migration.

Captain (the built-in ``kirocrew-captain`` member) keeps its working memory in its
own private V2 store. Three things are pinned here:

* the start-of-process upgrade moves a Captain created on Global onto a private
  store, idempotently, never touching Global data, and moves nobody else;
* only Captain's own authenticated execution reaches the Global recall and the
  Global preference line -- every ordinary private crewmate is refused;
* Captain's session context carries the user's Global ``preferences.md``
  read-only and nothing else from Global memory, while an ordinary private
  crewmate gets none of it.

Everything runs against the isolated data home and an in-process aiohttp app.
"""

from __future__ import annotations

import asyncio
import dataclasses
import json
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer

from kiro_crew.config.loader import KiroCrewConfig, config_path, update_config_locked
from kiro_crew.dashboard.handlers import _shared as shared_mod
from kiro_crew.dashboard.handlers import captain_memory
from kiro_crew.execution_context import MemoryStoreRef, resolve_member_execution
from kiro_crew.memory import MemoryStore
from kiro_crew.memory_stores import repair_legacy_member_stores

CAPTAIN = "kirocrew-captain"
OLD_CAPTAIN_ROW = {
    "kiro_agent": CAPTAIN,
    "workspace": "default",
    "memory_store": "default",
    "member_id": "",
    "source": "builtin",
    "display_name": "",
}


def _saved() -> dict:
    return json.loads(config_path().read_text(encoding="utf-8"))


def _tree_bytes(root: Path) -> dict[str, bytes]:
    return {
        str(p.relative_to(root)): p.read_bytes()
        for p in sorted(root.rglob("*"))
        if p.is_file() and not p.name.endswith(("-wal", "-shm", ".lock"))
    }


# ── migration ──


def test_a_captain_created_on_global_moves_to_a_private_store_at_start():
    from kiro_crew.config import config_dir
    from kiro_crew.members import member_slot_key, write_dm_binding

    update_config_locked(
        mutate=lambda _: {
            "agents": {
                "default": {"kiro_agent": "kirocrew", "memory_store": "default"},
                CAPTAIN: dict(OLD_CAPTAIN_ROW),
            }
        }
    )
    # The Global data an earlier Captain wrote must stay exactly where it is.
    global_memory = MemoryStore()
    global_memory.init()
    global_memory.write_preferences("# User Preferences\n\n- Address the user as Ray.\n")
    workspace = config_dir() / "workspace"
    before = _tree_bytes(workspace)
    # Captain's own DM thread binding must not push its id off its slug.
    write_dm_binding(CAPTAIN, member=CAPTAIN, slot_key=member_slot_key(CAPTAIN))

    upgraded = repair_legacy_member_stores()

    saved = _saved()
    row = saved["agents"][CAPTAIN]
    assert upgraded == [row["memory_store"]]
    assert row["member_id"] == CAPTAIN
    assert row["memory_store"].startswith("member-kirocrew-captain-")
    declared = saved["memory_stores"][row["memory_store"]]
    assert (declared["memory_version"], declared["owner_member_id"]) == (2, CAPTAIN)
    assert saved["agents"]["default"] == {"kiro_agent": "kirocrew", "memory_store": "default"}
    assert _tree_bytes(workspace) == before
    execution = resolve_member_execution(KiroCrewConfig.load(), CAPTAIN, validate_memory_files=True)
    assert execution.store.store_id == row["memory_store"]
    # Idempotent: a second start finds nothing to do and writes nothing.
    snapshot = config_path().read_bytes()
    assert repair_legacy_member_stores() == []
    assert config_path().read_bytes() == snapshot


@pytest.mark.parametrize(
    "rows",
    [
        # A user member keyed differently, on Captain's template: ordinary.
        {"assistant": {"kiro_agent": CAPTAIN, "memory_store": "default"}},
        # Captain's key bound to some other template: not Captain.
        {CAPTAIN: {"kiro_agent": "my-template", "memory_store": "default"}},
    ],
)
def test_only_captain_is_ever_moved_off_global(rows):
    update_config_locked(
        mutate=lambda _: {"agents": {"default": {"kiro_agent": "kirocrew"}, **rows}}
    )
    before = _saved()
    assert repair_legacy_member_stores() == []
    after = _saved()
    assert after["agents"] == before["agents"]
    assert after.get("memory_stores", {}) == before.get("memory_stores", {})


# ── who may use Global memory ──


def _config(*, persistence: bool = True) -> SimpleNamespace:
    return SimpleNamespace(
        memory=SimpleNamespace(persistence_enabled=persistence),
        agents={
            CAPTAIN: SimpleNamespace(
                kiro_agent=CAPTAIN, member_id=CAPTAIN, memory_store="captain-v2"
            ),
            "crew": SimpleNamespace(kiro_agent="kirocrew", member_id="m-crew", memory_store="crew"),
        },
        memory_stores={
            "captain-v2": SimpleNamespace(memory_version=2, owner_member_id=CAPTAIN),
            "crew": SimpleNamespace(memory_version=2, owner_member_id="m-crew"),
        },
    )


def _executions() -> dict[str, Any]:
    cfg = _config()
    captain = resolve_member_execution(cfg, CAPTAIN)
    return {
        "captain": captain,
        "captain-incognito": captain.with_mode("incognito"),
        "captain-temporary": captain.with_mode("temporary"),
        "captain-delegate": captain.with_template("kirocrew", "kirocrew"),
        "crewmate": resolve_member_execution(cfg, "crew"),
        "crewmate-claims-captain-id": dataclasses.replace(
            resolve_member_execution(cfg, "crew"),
            member_id=CAPTAIN,
            store=MemoryStoreRef("crew", CAPTAIN),
            template_id=CAPTAIN,
        ),
        "global": None,
    }


@web.middleware
async def _fake_auth(request: web.Request, handler):
    if request.headers.get("X-Test-Auth") == "internal":
        request["internal_auth"] = True
        request["app"] = ""
    return await handler(request)


@pytest.fixture
def world(monkeypatch, tmp_path):
    executions = _executions()

    async def scope(request):
        who = request.headers.get("X-Who", "")
        if who == "unverified":
            return shared_mod.MemberScope("dashboard:x", False, None)
        execution = executions[who]
        store = execution.store.legacy_name if execution is not None else ""
        return shared_mod.MemberScope("dashboard:x", True, store, execution)

    class _NullSel:
        def log_api_access(self, **_kw):
            return None

    monkeypatch.setattr(captain_memory, "member_request_scope", scope)
    monkeypatch.setattr(captain_memory.KiroCrewConfig, "load", staticmethod(lambda: _config()))
    monkeypatch.setattr(captain_memory, "_blocks_reads_session", lambda *_a: False)
    monkeypatch.setattr(captain_memory, "_is_restricted_session", lambda *_a: False)
    monkeypatch.setattr("kiro_crew.dashboard.handlers.sel", lambda: _NullSel())
    recalled: list[str] = []

    async def fake_recall(request, state, name):
        recalled.append(name)
        return web.json_response({"store": name, "retrieval": {"facts": [], "episodes": []}})

    monkeypatch.setattr(captain_memory, "recall_from_store", fake_recall)
    memory = MemoryStore(workspace=tmp_path / "global")
    memory.init()
    return SimpleNamespace(
        state=SimpleNamespace(context_builder=SimpleNamespace(memory=memory)),
        memory=memory,
        recalled=recalled,
    )


def _run(world, fn):
    async def main():
        app = web.Application(middlewares=[_fake_auth])
        app["state"] = world.state
        app.router.add_get(
            "/api/captain/agent/global-recall", captain_memory.api_captain_global_recall
        )
        app.router.add_post(
            "/api/captain/agent/global-preference", captain_memory.api_captain_global_preference
        )
        client = TestClient(TestServer(app))
        await client.start_server()
        try:
            return await fn(client)
        finally:
            await client.close()

    return asyncio.run(main())


def _headers(who: str, auth: str = "internal") -> dict[str, str]:
    return {"X-Test-Auth": auth, "X-Who": who, "X-Session-Key": "dashboard:x"}


@pytest.mark.parametrize(
    "who, auth",
    [
        ("captain", "browser"),
        ("unverified", "internal"),
        ("crewmate", "internal"),
        ("crewmate-claims-captain-id", "internal"),
        ("captain-delegate", "internal"),
        ("global", "internal"),
    ],
)
def test_nobody_but_captain_reaches_global_memory(world, who, auth):
    async def go(client):
        read = await client.get(
            "/api/captain/agent/global-recall?q=deploy", headers=_headers(who, auth)
        )
        write = await client.post(
            "/api/captain/agent/global-preference",
            json={"preference": "Address the user as Mallory."},
            headers=_headers(who, auth),
        )
        return read.status, (await read.json())["code"], write.status, (await write.json())["code"]

    assert _run(world, go) == (403, "captain_only", 403, "captain_only")
    assert world.recalled == []
    assert "Mallory" not in world.memory.read_preferences()


def test_captain_reads_global_and_appends_one_preference_line(world):
    async def go(client):
        read = await client.get("/api/captain/agent/global-recall?q=x", headers=_headers("captain"))
        first = await client.post(
            "/api/captain/agent/global-preference",
            json={"preference": "Address the user as Ray."},
            headers=_headers("captain"),
        )
        again = await client.post(
            "/api/captain/agent/global-preference",
            json={"preference": "- Address the user as Ray."},
            headers=_headers("captain"),
        )
        bad = await client.post(
            "/api/captain/agent/global-preference",
            json={"preference": "one\n# Heading"},
            headers=_headers("captain"),
        )
        return (
            read.status,
            (await first.json())["status"],
            (await again.json())["status"],
            bad.status,
        )

    assert _run(world, go) == (200, "added", "unchanged", 400)
    assert world.recalled == [""]
    prefs = world.memory.read_preferences()
    assert prefs.count("- Address the user as Ray.") == 1
    assert "Heading" not in prefs


def test_captain_preference_honours_the_persistence_switch(world, monkeypatch):
    """With persistent memory off, global_preference_add saves nothing and says so."""
    monkeypatch.setattr(
        captain_memory.KiroCrewConfig, "load", staticmethod(lambda: _config(persistence=False))
    )

    async def go(client):
        r = await client.post(
            "/api/captain/agent/global-preference",
            json={"preference": "Keep replies short."},
            headers=_headers("captain"),
        )
        return r.status, (await r.json())["code"]

    assert _run(world, go) == (409, "persistence_disabled")
    assert "Keep replies short." not in world.memory.read_preferences()


def test_captain_privacy_modes_hold(world):
    async def go(client):
        out = {}
        for who in ("captain-incognito", "captain-temporary"):
            read = await client.get("/api/captain/agent/global-recall?q=x", headers=_headers(who))
            write = await client.post(
                "/api/captain/agent/global-preference",
                json={"preference": "Keep replies short."},
                headers=_headers(who),
            )
            out[who] = (read.status, write.status, (await write.json())["code"])
        return out

    assert _run(world, go) == {
        "captain-incognito": (200, 403, "restricted_session"),
        "captain-temporary": (403, 403, "memory_reads_disabled"),
    }
    assert "Keep replies short." not in world.memory.read_preferences()


# ── what reaches Captain's context ──


@pytest.fixture
def captain_env(tmp_path, monkeypatch):
    from kiro_crew import context as context_module
    from kiro_crew.config.loader import KiroCrewAgentConfig
    from kiro_crew.context import ContextBuilder
    from kiro_crew.learn import Lesson, LessonStore
    from kiro_crew.memory_stores import (
        give_assistant_private_memory,
        persist_member_config,
        provision_member_memory,
    )
    from kiro_crew.skills import SkillsLoader

    home = tmp_path / "host-home"
    home.mkdir()
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setattr(Path, "home", classmethod(lambda cls: home))
    agents = home / ".kiro" / "agents"
    agents.mkdir(parents=True)
    monkeypatch.setattr("kiro_crew.agent.KIRO_AGENTS_DIR", agents)
    monkeypatch.setattr("kiro_crew.agent_discovery._KIRO_AGENTS_DIR", agents)
    for template in (CAPTAIN, "writer-template"):
        (agents / f"{template}.json").write_text(
            json.dumps({"name": template, "prompt": f"Role of {template}."}), encoding="utf-8"
        )
    cfg = KiroCrewConfig.load()
    cfg.agents[CAPTAIN] = KiroCrewAgentConfig(kiro_agent=CAPTAIN, source="builtin")
    persist_member_config(cfg, CAPTAIN, create=True)
    give_assistant_private_memory(cfg)
    cfg.agents["writer"] = KiroCrewAgentConfig(kiro_agent="writer-template")
    provision_member_memory(cfg, "writer")
    persist_member_config(cfg, "writer", create=True)
    monkeypatch.setattr(context_module, "_memory_stores", {})
    monkeypatch.setattr(context_module, "_vector_stores", {})
    global_memory = MemoryStore(workspace=tmp_path / "global")
    global_memory.init()
    global_memory.write_preferences("# User Preferences\n\n- Address the user as Ray.\n")
    lessons = LessonStore(base_dir=tmp_path / "lessons")
    lessons.save(
        Lesson(
            ts="2026-01-01T00:00:00",
            rule="Global lesson: always cite the runbook.",
            category="knowledge",
        )
    )
    builder = ContextBuilder(
        memory=global_memory,
        skills=SkillsLoader(skills_path=tmp_path / "skills", install_builtins=False),
        lessons=lessons,
    )
    cfg = KiroCrewConfig.load()
    yield SimpleNamespace(builder=builder, cfg=cfg, project=tmp_path)
    builder.skills.close()


def _first_message(env, member: str) -> str:
    execution = resolve_member_execution(env.cfg, member)
    message, _ = env.builder.build_message(
        "Hello",
        True,
        f"dashboard:{member}-thread",
        member=execution.member_id,
        memory_store=execution.store.legacy_name,
        execution_context=execution,
        project=str(env.project),
    )
    return message


def test_captain_context_carries_global_preferences_and_nothing_else_global(captain_env):
    message = _first_message(captain_env, CAPTAIN)
    # Captain's own identity holds on its private store.
    assert "Introduce yourself to the user as Captain" in message
    assert "Address the user as Ray." in message
    assert "read-only here" in message
    assert "global_memory_recall" in message and "global_preference_add" in message
    assert "Global lesson: always cite the runbook." not in message


def test_another_template_on_captains_store_is_not_told_it_is_captain(captain_env):
    # A delegated run on Captain's memory with another template selected: the
    # identity is built inside the V2 essentials, which must hear that too.
    execution = resolve_member_execution(captain_env.cfg, CAPTAIN).with_template(
        "kirocrew", "kirocrew"
    )
    message, _ = captain_env.builder.build_message(
        "Hello",
        True,
        f"dashboard:{CAPTAIN}-thread",
        member=execution.member_id,
        memory_store=execution.store.legacy_name,
        execution_context=execution,
        project=str(captain_env.project),
    )
    assert "[MEMBER IDENTITY]" in message
    assert "Introduce yourself to the user as Captain" not in message


def test_an_ordinary_private_crewmate_gets_nothing_from_global(captain_env):
    message = _first_message(captain_env, "writer")
    assert "Your long-term memory is scoped to this member." in message
    assert "Introduce yourself to the user as Captain" not in message
    assert "Address the user as Ray." not in message
    assert "global_memory_recall" not in message
    assert "Global lesson: always cite the runbook." not in message


# ── the MCP shim ──


def test_shim_sends_the_verified_key_and_honours_the_memory_write_switch(monkeypatch):
    from kiro_crew import mcp_guide

    sent: list[tuple[str, str, Any]] = []
    monkeypatch.setattr(mcp_guide, "_strict_session_key", lambda: ("dashboard:c", ""))
    monkeypatch.setattr(
        mcp_guide,
        "_get",
        lambda path, session_key: sent.append((path, session_key, None))
        or {"store": "", "retrieval": {"facts": [], "episodes": []}},
    )
    monkeypatch.setattr(
        mcp_guide,
        "_post",
        lambda path, body, session_key: sent.append((path, session_key, body))
        or {"status": "added"},
    )
    monkeypatch.setattr(mcp_guide, "_vet_memory_writes_governance", lambda _sk: None)
    mcp_guide._call_tool_inner("global_memory_recall", {"query": " deploy plan "})
    mcp_guide._call_tool_inner("global_preference_add", {"preference": "Keep replies short."})
    assert sent == [
        ("/api/captain/agent/global-recall?q=deploy+plan", "dashboard:c", None),
        (
            "/api/captain/agent/global-preference",
            "dashboard:c",
            {"preference": "Keep replies short."},
        ),
    ]
    monkeypatch.setattr(mcp_guide, "_vet_memory_writes_governance", lambda _sk: "disabled")
    out = mcp_guide._call_tool_inner("global_preference_add", {"preference": "x"})
    assert out == "Error: disabled" and len(sent) == 2
