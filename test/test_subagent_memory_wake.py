"""Starts waiting for memory wake on events, and each lane gets its memory share.

With count caps gone, memory is the pool every chat's subagents share, so one
chat's wave could still starve another's through memory, and a start the floor
deferred was re-checked only when its admit wait passed. Pinned here, against
the real ``SubagentManager`` pump and a real task store (``_run_inner`` is the
only stand-in, so a child's real terminal path runs):

* (i) two lanes on a host near the floor: lane A's wave does not take the next
  memory admission while lane B waits, and B starts as soon as memory allows;
* (ii) a start waiting for memory starts on one event -- a child reaching its
  terminal (its run's end or its reap), a warming row settling (the reaper's
  sweep), another lane's wait ending, a sampler tick -- with no admit wait
  passing, and the sampler runs only while a start waits; a wake that finds the
  host still short writes nothing;
* (iii) a nested child that shares its parent's runtime is admitted at the
  floor, so a parent waiting on its own child cannot deadlock on memory;
* (iv) a start the lane share holds still ends at the max wait in one delivered
  terminal, its parent's depth at 0;
* (v) the share follows a live ``agent.lane_weights`` reload, no restart;
* a wait is audited at its transitions (it begins, or its cause changes), not
  at every re-check.

The store runs on a virtual clock (``overload_fakes.Clock``) and the admit wait is
the production 30 s on it, so "no admit wait passed" means the clock never moved.
"""

from __future__ import annotations

import asyncio
import contextlib
from typing import Any
from unittest.mock import MagicMock

import pytest
from overload_fakes import Clock, mock_ctx, mock_sessions

import kiro_crew.subagent as subagent_mod
from kiro_crew import taskq
from kiro_crew.config.loader import KiroCrewConfig
from kiro_crew.config.schema import requires_restart
from kiro_crew.subagent import SubagentManager, _SharingPlan
from kiro_crew.subagent_manager.admission import SpawnAdmissionCoordinator
from kiro_crew.subagent_wait_reasons import QUEUED_REASON_LOW_MEMORY, QUEUED_WAIT_EXPIRED_TEXT

pytestmark = [pytest.mark.timeout(60), pytest.mark.usefixtures("healthy_host_memory")]

_A = "dash:lane-a"
_B = "dash:lane-b"
_C = "dash:lane-c"
_ADMIT = 30.0
# At defaults with nothing learned, a dedicated start is priced 1.0 GiB and the
# floor is 2.0 GiB, so a host with 2.5 GiB free fits no dedicated start and one
# with 3.0 GiB fits exactly one.
_NEAR_FLOOR = 2.5
_SAMPLER_SECS = "kiro_crew.subagent_manager.admission.memory_wake.MEMORY_SAMPLER_SECS"


def _cfg(*, bound: int = 1800, weights: dict[str, int] | None = None) -> KiroCrewConfig:
    cfg = KiroCrewConfig()
    cfg.agent.subagent_cost_gb = 0.5
    cfg.agent.subagent_queue_max_wait_secs = bound
    cfg.agent.lane_weights = dict(weights or {})
    return cfg


class _Host:
    """A real manager on a real store whose host memory is a dial the test turns."""

    def __init__(self, mgr: SubagentManager, clock: Clock, free: dict[str, float]) -> None:
        self.mgr = mgr
        self.clock = clock
        self.free = free
        self.finish: dict[str, asyncio.Future[None]] = {}
        self.started: list[str] = []
        self.done: list[tuple[str, dict[str, Any]]] = []
        self.queued: dict[str, list[dict[str, Any]]] = {}
        self.delivered: list[Any] = []
        self.cfgs: dict[str, KiroCrewConfig] = {}
        self.sel = MagicMock()

    async def on_event(self, etype: str, info: Any, extra: dict[str, Any]) -> None:
        if etype == "subagent_done":
            self.done.append((info.id, dict(extra)))
        elif etype == "subagent_queued":
            self.queued.setdefault(info.parent_session_key, []).append(dict(extra))

    async def on_done(self, info: Any) -> None:
        self.delivered.append(info)

    async def settle(self) -> None:
        """Every posted store write, scheduled callback and emit has landed."""
        for _ in range(4):
            await self.mgr._taskq.run(lambda: None)
            await asyncio.sleep(0.02)

    async def pump(self, passes: int = 4) -> None:
        """Run whole pump passes, each awaited to its end; the clock never moves."""
        for _ in range(passes):
            self.mgr._drain_queue()
            task = getattr(self.mgr, "_drain_task", None)
            if task is not None:
                await asyncio.wait_for(asyncio.shield(task), 5)
            await self.settle()

    async def spawn(self, parent: str, task: str = "work") -> Any:
        info = await self.mgr.spawn_async(task, parent_session_key=parent)
        assert info is not None and not info.done, info
        await self.pump(2)
        return info

    def running(self, info: Any) -> bool:
        return info.id in self.started

    async def quiesce(self) -> None:
        """Every wake's fit pass and the pump passes it started have finished."""
        for _ in range(500):
            fit = getattr(self.mgr, "_memory_fit_task", None)
            drain = getattr(self.mgr, "_drain_task", None)
            if (fit is None or fit.done()) and (drain is None or drain.done()):
                await self.settle()
                fit = getattr(self.mgr, "_memory_fit_task", None)
                drain = getattr(self.mgr, "_drain_task", None)
                if (fit is None or fit.done()) and (drain is None or drain.done()):
                    return
            await asyncio.sleep(0.02)
        raise AssertionError("the memory wake never went quiet")

    async def until_started(self, info: Any, deadline: float = 10.0) -> None:
        """Let the manager's own wake and pump passes run -- none driven here, and
        the clock never moves -- until *info* starts; fail at *deadline* (wall s)."""
        loop = asyncio.get_running_loop()
        end = loop.time() + deadline
        while not self.running(info):
            assert loop.time() < end, f"{info.id} did not start within {deadline}s"
            await asyncio.sleep(0.02)

    def deferred_events(self, info: Any) -> int:
        return sum(e.kind == "deferred" for e in self.mgr._taskq.events(info.id))

    def settle_row(self, info: Any) -> None:
        """The reaper's sweep measured this run twice: its memory is in the reading."""
        self.mgr._agents[info.id]._rss_samples = 2

    async def end(self, info: Any, *, frees_gb: float) -> None:
        """The run finishes and its process exits, giving back *frees_gb*."""
        self.free["gb"] += frees_gb
        fut = self.finish[info.id]
        fut.set_result(None)
        task = self.mgr._tasks.get(info.id)
        if task is not None:
            await asyncio.wait_for(asyncio.shield(task), 5)
        await self.settle()

    def deferred_audits(self) -> list[Any]:
        return [
            c
            for c in self.sel.return_value.log_tool_invocation.call_args_list
            if c.kwargs.get("outcome") == "deferred_low_memory"
        ]


@contextlib.asynccontextmanager
async def _host(
    monkeypatch,
    *,
    free_gb: float = 8.0,
    cfg: KiroCrewConfig | None = None,
    sampler_secs: float = 3600.0,
):
    # The sampler is off the clock of every test but its own: an event's wake
    # is then the only thing that can start a waiting spawn in time.
    monkeypatch.setattr(_SAMPLER_SECS, sampler_secs)
    cfgs = {"cfg": cfg or _cfg()}
    monkeypatch.setattr(KiroCrewConfig, "load", lambda: cfgs["cfg"])
    monkeypatch.setattr(subagent_mod, "Stats", MagicMock())
    monkeypatch.setattr(SpawnAdmissionCoordinator, "open_store_off_loop", True)
    monkeypatch.setattr(SpawnAdmissionCoordinator, "pump_off_loop", True)
    free = {"gb": free_gb}

    def memory_check(*, min_gb, **_kw):
        return free["gb"] >= min_gb, free["gb"]

    monkeypatch.setattr(subagent_mod, "check_memory_available", memory_check)
    mgr = SubagentManager(sessions=mock_sessions(), ctx_builder=mock_ctx(), max_concurrent=20)
    await asyncio.wait_for(mgr.wait_taskq_ready(), 5)
    clock = Clock(1000.0)
    mgr._taskq._clock = clock
    mgr._spawn_stagger_secs = 0.0
    mgr._taskq_admit_wait_secs = _ADMIT
    h = _Host(mgr, clock, free)
    h.cfgs = cfgs
    monkeypatch.setattr(subagent_mod, "sel", h.sel)
    mgr._on_event = h.on_event
    mgr._on_done = h.on_done
    loop = asyncio.get_running_loop()

    async def run_inner(info: Any, _session_key: str) -> None:
        h.started.append(info.id)
        await h.finish.setdefault(info.id, loop.create_future())
        info.result = "ok"

    monkeypatch.setattr(mgr, "_run_inner", run_inner)
    monkeypatch.setattr(mgr, "_record_cost", lambda _info: None)
    monkeypatch.setattr(mgr, "_write_tombstone", lambda *_a, **_k: None)
    try:
        yield h
    finally:
        mgr._shutting_down = True
        for fut in h.finish.values():
            if not fut.done():
                fut.cancel()
        tasks = [task for task in mgr._tasks.values() if not task.done()]
        tasks += [task for task in mgr._report_tasks if not task.done()]
        for task in tasks:
            task.cancel()
        await asyncio.wait_for(asyncio.gather(*tasks, return_exceptions=True), 5)
        for task in (
            getattr(mgr, "_drain_task", None),
            getattr(mgr, "_memory_sample_task", None),
            getattr(mgr, "_memory_fit_task", None),
        ):
            if task is not None and not task.done():
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)
        handle = getattr(mgr, "_memory_sampler_handle", None)
        if handle is not None:
            handle.cancel()
        mgr._taskq.close()


async def _wave_near_the_floor(h: _Host) -> tuple[Any, Any]:
    """Lane A runs two dedicated children that took the host to just above the floor."""
    a1 = await h.spawn(_A, "a1")
    a2 = await h.spawn(_A, "a2")
    assert h.running(a1) and h.running(a2)
    h.settle_row(a1)
    h.settle_row(a2)
    h.free["gb"] = _NEAR_FLOOR
    return a1, a2


# ── (i) F4: two lanes near the floor ────────────────────────────────────────


class TestTwoLanesNearTheFloor:
    @pytest.mark.asyncio
    async def test_a_wave_does_not_take_the_next_admission_while_another_lane_waits(
        self, monkeypatch
    ) -> None:
        async with _host(monkeypatch) as h:
            a1, _a2 = await _wave_near_the_floor(h)
            b1 = await h.spawn(_B, "b1")
            a3 = await h.spawn(_A, "a3")
            assert not h.running(b1) and not h.running(a3)
            # Held by the share, not by a reading: a memory wait with no figures.
            held = h.queued[_A][-1]
            assert held["reason"] == QUEUED_REASON_LOW_MEMORY and "required_gb" not in held, held
            # One of A's children ends and gives back one start's worth: the
            # next admission is B's, not the third of A's wave, and it happens
            # on that event -- the clock never reaches the admit wait.
            await h.end(a1, frees_gb=1.0)
            await h.until_started(b1)
            assert h.running(b1), "lane B still waits while memory allows its start"
            await h.quiesce()
            assert not h.running(a3), "lane A's wave took the memory lane B waited for"
            assert h.mgr._taskq.state_of(a3.id) == taskq.QUEUED

    @pytest.mark.asyncio
    async def test_three_lanes_a_lane_at_its_share_does_not_take_the_starved_lanes_start(
        self, monkeypatch
    ) -> None:
        """A lane at exactly its share is held too, not only one above it."""
        async with _host(monkeypatch) as h:
            a1 = await h.spawn(_A, "a1")
            a2 = await h.spawn(_A, "a2")
            b1 = await h.spawn(_B, "b1")
            for row in (a1, a2, b1):
                assert h.running(row)
                h.settle_row(row)
            h.free["gb"] = _NEAR_FLOOR
            # B queues first, then C; both wait on the floor.
            b2 = await h.spawn(_B, "b2")
            c1 = await h.spawn(_C, "c1")
            assert not h.running(b2) and not h.running(c1)
            # Three running across three equal lanes: B's one IS its share, and
            # C, at none, is below its own.
            assert h.mgr._admission.lane_share_holds(_B, b2.id) is True
            # One of A's children ends and frees one start's worth: C's start
            # takes it, although B's was queued first.
            await h.end(a1, frees_gb=1.0)
            await h.until_started(c1)
            await h.quiesce()
            assert not h.running(b2), "a lane at its share took the starved lane's memory"

    @pytest.mark.asyncio
    async def test_a_lane_below_its_share_is_not_held(self, monkeypatch) -> None:
        """The hold only ever falls on a lane at or above its share."""
        async with _host(monkeypatch) as h:
            a1, a2 = await _wave_near_the_floor(h)
            b1 = await h.spawn(_B, "b1")
            assert not h.running(b1)
            adm = h.mgr._admission
            # B waits with nothing running: it is the starved lane, never held.
            assert adm.lane_share_holds(_B, "probe") is False
            assert adm.lane_share_holds(_A, "probe") is True
            # With A down to nothing running, A is not above any share either.
            await h.end(a1, frees_gb=0.0)
            await h.end(a2, frees_gb=0.0)
            assert adm.lane_share_holds(_A, "probe") is False

    @pytest.mark.asyncio
    async def test_a_nested_start_of_a_held_lane_is_not_held(self, monkeypatch) -> None:
        """A running tree must be able to finish: its own child is never held by the share."""
        async with _host(monkeypatch) as h:
            a1, _a2 = await _wave_near_the_floor(h)
            b1 = await h.spawn(_B, "b1")
            a3 = await h.spawn(_A, "a3")
            assert not h.running(b1) and not h.running(a3)
            assert h.mgr._memory_waits[a3.id].held_by_share
            monkeypatch.setattr(
                h.mgr, "_sharing_plan", lambda *_a, **_k: _SharingPlan("", "", True)
            )
            # Lane A is held for its roots, but a1's own child fits the floor.
            child = await h.spawn(f"subagent:{a1.id}", "child")
            assert h.running(child), "the share held a running tree's own child"

    @pytest.mark.asyncio
    async def test_a_claim_re_entry_is_not_held(self, monkeypatch) -> None:
        """A start that passed the first half is registered, whatever the share says after."""
        async with _host(monkeypatch) as h:
            asked: list[bool] = []

            def holds_once_claimed(_self: Any, parent: str, agent_id: str) -> bool:
                # A share that would hold the start once its row is claimed.
                asked.append(h.mgr._taskq.state_of(agent_id) == taskq.ADMITTED)
                return asked[-1]

            monkeypatch.setattr(SpawnAdmissionCoordinator, "lane_share_holds", holds_once_claimed)
            a1 = await h.spawn(_A, "a1")
            assert h.running(a1), "the claim re-entry was held by the share"
            assert asked and not any(asked)


# ── (ii) one event, no poll interval; the sampler only while a start waits ──


class TestOneEventStartsAWaitingSpawn:
    @pytest.mark.asyncio
    async def test_a_child_terminal_starts_it(self, monkeypatch) -> None:
        async with _host(monkeypatch) as h:
            a1 = await h.spawn(_A, "a1")
            h.settle_row(a1)
            h.free["gb"] = _NEAR_FLOOR
            a2 = await h.spawn(_A, "a2")
            assert not h.running(a2)
            await h.end(a1, frees_gb=1.0)
            await h.until_started(a2)
            assert h.running(a2)

    @pytest.mark.asyncio
    async def test_a_reap_of_a_run_that_never_ends_starts_it(self, monkeypatch) -> None:
        """The reap's own wake: the run's ``finally`` never comes, the reap is the terminal."""
        async with _host(monkeypatch) as h:
            a1 = await h.spawn(_A, "a1")
            h.settle_row(a1)
            h.free["gb"] = _NEAR_FLOOR
            a2 = await h.spawn(_A, "a2")
            assert not h.running(a2)
            # Only the reap path's wake can start a2: the run's own finally
            # (the other terminal wake) is kept from running.
            monkeypatch.setattr(h.mgr, "_tasks", {})
            h.free["gb"] += 1.0
            await h.mgr._reap_once(a1.id, h.mgr._agents[a1.id], 1.0, reason="test")
            await h.until_started(a2)

    @pytest.mark.asyncio
    async def test_the_reaper_sweep_settling_a_row_starts_it(self, monkeypatch) -> None:
        """The reaper's own settle wake, after its RSS sweep -- not a hand-made call."""
        from unittest.mock import AsyncMock

        async with _host(monkeypatch) as h:
            a1 = await h.spawn(_A, "a1")
            h.free["gb"] = 3.5
            a2 = await h.spawn(_A, "a2")
            assert not h.running(a2)
            mgr = h.mgr
            # The sweep measures a1 twice: what settles it.
            monkeypatch.setattr(mgr, "_sample_live_costs", lambda: h.settle_row(a1))
            for name in (
                "_rebuild_conversation_registry",
                "_sweep_stuck_waves_async",
                "_sweep_digest_holds_async",
                "_maybe_flag_stall",
            ):
                monkeypatch.setattr(mgr, name, AsyncMock())
            monkeypatch.setattr(mgr, "_sweep_conversations", MagicMock())
            monkeypatch.setattr(mgr, "_refresh_learned_settled", lambda: None)
            monkeypatch.setattr(subagent_mod, "_REAPER_INTERVAL", 0.01)
            monkeypatch.setattr(subagent_mod, "compact_cost_log", lambda: None)
            reaper = asyncio.ensure_future(mgr._reaper_loop())
            try:
                await h.until_started(a2)
            finally:
                reaper.cancel()
                await asyncio.gather(reaper, return_exceptions=True)

    @pytest.mark.asyncio
    async def test_another_lanes_wait_ending_releases_the_start_the_share_held(
        self, monkeypatch
    ) -> None:
        async with _host(monkeypatch) as h:
            a1, _a2 = await _wave_near_the_floor(h)
            b1 = await h.spawn(_B, "b1")
            a3 = await h.spawn(_A, "a3")
            assert not h.running(b1) and not h.running(a3)
            # Enough memory comes back for both, but the share gives it to B
            # first; B's wait ending is the only event left to release A's.
            await h.end(a1, frees_gb=5.5)
            await h.until_started(b1)
            await h.until_started(a3)

    @pytest.mark.asyncio
    async def test_a_warming_row_settling_starts_it(self, monkeypatch) -> None:
        async with _host(monkeypatch) as h:
            a1 = await h.spawn(_A, "a1")
            # a1 still warms, so it owes its 1.0 GiB price: 3.5 GiB free fits a
            # second start only once a1 has settled.
            h.free["gb"] = 3.5
            a2 = await h.spawn(_A, "a2")
            assert not h.running(a2)
            h.settle_row(a1)
            # What the reaper calls after each RSS sweep.
            h.mgr._admission.note_settled_rows()
            await h.until_started(a2)
            assert h.running(a2)

    @pytest.mark.asyncio
    async def test_a_sampler_tick_starts_it_and_runs_only_while_a_start_waits(
        self, monkeypatch
    ) -> None:
        async with _host(monkeypatch, sampler_secs=0.05) as h:
            adm = h.mgr._admission
            a1 = await h.spawn(_A, "a1")
            assert h.running(a1)
            assert adm.memory_sampler_active() is False, "the sampler polls with nothing waiting"
            h.settle_row(a1)
            h.free["gb"] = _NEAR_FLOOR
            a2 = await h.spawn(_A, "a2")
            assert not h.running(a2)
            assert adm.memory_sampler_active() is True
            # Another program frees memory: no child of ours ends, nothing
            # settles, only the sampler can see it.
            h.free["gb"] = 8.0
            await h.until_started(a2)
            assert h.running(a2)
            assert adm.memory_sampler_active() is False, "the sampler outlived the last wait"

    @pytest.mark.asyncio
    async def test_a_wait_whose_row_left_behind_its_back_stops_the_sampler(
        self, monkeypatch
    ) -> None:
        """A record no exit forgot is pruned by the next tick, never polled forever."""
        async with _host(monkeypatch, sampler_secs=0.05) as h:
            adm = h.mgr._admission
            a1 = await h.spawn(_A, "a1")
            h.settle_row(a1)
            h.free["gb"] = _NEAR_FLOOR
            a2 = await h.spawn(_A, "a2")
            assert adm.memory_sampler_active() is True
            # The row ends in the store with no exit through the manager.
            assert await h.mgr._taskq.run(h.mgr._taskq.cancel, a2.id)
            for _ in range(200):
                if not adm.memory_sampler_active():
                    break
                await asyncio.sleep(0.02)
            assert a2.id not in h.mgr._memory_waits
            assert adm.memory_sampler_active() is False
            assert adm.lane_share_holds(_B, "probe") is False


# ── (iii) D4: a shared nested child at the floor ────────────────────────────


class TestASharedNestedChildAtTheFloor:
    @pytest.mark.asyncio
    async def test_it_is_admitted_while_its_parent_waits(self, monkeypatch) -> None:
        async with _host(monkeypatch) as h:
            parent = await h.spawn(_A, "parent")
            assert h.running(parent)
            h.settle_row(parent)
            monkeypatch.setattr(
                h.mgr, "_sharing_plan", lambda *_a, **_k: _SharingPlan("", "", True)
            )
            # The parent waits on its child with the host exactly at the floor:
            # the parent's runtime is already paid for, so the child that shares
            # it is admitted rather than left to the max wait.
            h.free["gb"] = 2.0
            child = await h.spawn(f"subagent:{parent.id}", "child")
            assert h.running(child), "the parent's own child waited on memory at the floor"
            # It still carries its shared price, so a second such child is
            # charged for the first while it warms: the floor gives way by one
            # shared start, not by a whole fan-out.
            assert h.mgr._agents[child.id]._start_price_gb == pytest.approx(0.65)
            sibling = await h.spawn(f"subagent:{parent.id}", "sibling")
            assert not h.running(sibling)

    @pytest.mark.asyncio
    async def test_a_dedicated_nested_child_still_waits_at_the_floor(self, monkeypatch) -> None:
        async with _host(monkeypatch) as h:
            parent = await h.spawn(_A, "parent")
            h.settle_row(parent)
            h.free["gb"] = 2.0
            child = await h.spawn(f"subagent:{parent.id}", "child")
            assert not h.running(child)


# ── (iv) the max wait still ends a held start ───────────────────────────────


class TestTheMaxWaitStillEndsAHeldStart:
    @pytest.mark.asyncio
    async def test_a_start_the_share_holds_expires_with_one_terminal_at_depth_zero(
        self, monkeypatch
    ) -> None:
        async with _host(monkeypatch, cfg=_cfg(bound=60)) as h:
            h.mgr._subagent_queue_max_wait_secs = 60
            await _wave_near_the_floor(h)
            b1 = await h.spawn(_B, "b1")
            a3 = await h.spawn(_A, "a3")
            for _ in range(3):
                h.clock.advance(_ADMIT)
                await h.pump()
            for row in (a3, b1):
                assert h.mgr._taskq.state_of(row.id) == taskq.FAILED
                reports = [extra for aid, extra in h.done if aid == row.id]
                assert len(reports) == 1 and reports[0]["error"] == QUEUED_WAIT_EXPIRED_TEXT
            assert await h.mgr.queued_count_for_async(_A) == 0
            assert await h.mgr.queued_count_for_async(_B) == 0
            assert not getattr(h.mgr, "_memory_waits", {})


# ── (v) the share follows a live lane_weights reload ────────────────────────


class TestTheShareIsLive:
    @pytest.mark.asyncio
    async def test_a_lane_weights_reload_moves_the_share_without_a_restart(
        self, monkeypatch
    ) -> None:
        assert requires_restart("agent.lane_weights") is False
        # The share reads the weights through the pump's TTL'd config read; with
        # the TTL at 0 a changed config is what the very next read sees.
        monkeypatch.setattr(
            "kiro_crew.subagent_manager.admission.fairness.FAIRNESS_SETTINGS_TTL_SECS", 0.0
        )
        async with _host(monkeypatch) as h:
            a1 = await h.spawn(_A, "a1")
            a2 = await h.spawn(_A, "a2")
            b1 = await h.spawn(_B, "b1")
            for row in (a1, a2, b1):
                h.settle_row(row)
            h.free["gb"] = _NEAR_FLOOR
            b2 = await h.spawn(_B, "b2")
            assert not h.running(b2)
            adm = h.mgr._admission
            # Equal weights: three running, a share of 1.5 each; A's two are
            # above it while B, at one, waits below it.
            assert adm.lane_share_holds(_A, "probe") is True
            # Lane A weighted 3: A's share is 2.25 and B's 0.75, so neither A
            # is above its share nor B below its own. Only the config changed.
            h.cfgs["cfg"] = _cfg(weights={adm.lane_for_session(_A): 3})
            assert adm.lane_share_holds(_A, "probe") is False


# ── a wait is audited when it begins ────────────────────────────────────────


class TestAWaitIsAuditedOnce:
    @pytest.mark.asyncio
    async def test_re_checks_write_no_further_audit_row(self, monkeypatch) -> None:
        async with _host(monkeypatch) as h:
            a1 = await h.spawn(_A, "a1")
            h.settle_row(a1)
            h.free["gb"] = _NEAR_FLOOR
            a2 = await h.spawn(_A, "a2")
            assert len(h.deferred_audits()) == 1
            for _ in range(3):
                h.clock.advance(_ADMIT)
                await h.pump()
            assert not h.running(a2)
            assert len(h.deferred_audits()) == 1, "every re-check wrote another audit row"
            # It ends the wait when it fits: a later wait is a new one.
            h.free["gb"] = 8.0
            h.clock.advance(_ADMIT)
            await h.pump()
            assert h.running(a2)
            assert a2.id not in h.mgr._memory_waits

    @pytest.mark.asyncio
    async def test_a_hundred_wakes_while_still_short_write_nothing(self, monkeypatch) -> None:
        """A wake re-checks a wait with one reading; a start that still does not
        fit is left parked: no tasks.db event, no depth frame, no audit row."""
        async with _host(monkeypatch) as h:
            a1 = await h.spawn(_A, "a1")
            h.settle_row(a1)
            h.free["gb"] = _NEAR_FLOOR
            a2 = await h.spawn(_A, "a2")
            await h.quiesce()
            events, frames = h.deferred_events(a2), len(h.queued[_A])
            assert events == 1 and len(h.deferred_audits()) == 1
            adm = h.mgr._admission
            for n in range(100):
                adm.wake_memory_waits(("child_terminal", "rss_settle", "sampler")[n % 3])
                fit = h.mgr._memory_fit_task
                assert fit is not None
                await asyncio.wait_for(asyncio.shield(fit), 5)
            await h.quiesce()
            assert not h.running(a2)
            assert h.deferred_events(a2) == events, "a wake that found no room re-parked it"
            assert len(h.queued[_A]) == frames, "a wake that found no room re-published depth"
            assert len(h.deferred_audits()) == 1
            # The wake that finds room starts it.
            h.free["gb"] = 8.0
            adm.wake_memory_waits("sampler")
            await h.until_started(a2)
            assert h.deferred_events(a2) == events

    @pytest.mark.asyncio
    async def test_a_wait_whose_cause_changes_is_audited_again(self, monkeypatch) -> None:
        """Held by the share, then by the floor: one audit row for each cause."""
        async with _host(monkeypatch) as h:
            a1, _a2 = await _wave_near_the_floor(h)
            b1 = await h.spawn(_B, "b1")
            a3 = await h.spawn(_A, "a3")

            def a3_causes() -> list[Any]:
                return [
                    c.kwargs["metadata"].get("cause")
                    for c in h.deferred_audits()
                    if c.kwargs["session_key"] == _A
                ]

            assert a3_causes() == ["lane_share"]
            await h.end(a1, frees_gb=1.0)
            await h.until_started(b1)
            # B started, so the share no longer holds A; the floor still does
            # (b1 warms), and the re-check at its admit wait says so once.
            for _ in range(2):
                h.clock.advance(_ADMIT)
                await h.pump()
            assert not h.running(a3)
            assert a3_causes() == ["lane_share", None]
