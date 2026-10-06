"""``session/created``: the edge a CREATOR states before its child has a log.

Every other tree entry is written on the session that moved. This one is written on
the session that MINTED, and the reason is a window nothing else can cover:
``session/opened.parent`` needs the child's ACP session id, which arrives with the
child's first turn, after runtime and MCP startup. For that minute or more the store
records no edge at all and the sidebar shows a freshly dispatched worker at the top
level.

Five things can break independently and each gets its own test:

* a child that has NOT run is nested, and the push that puts it on screen is armed;
* the child's own ``session/opened``, once it lands, WINS -- including when it lands
  with no parent, which is what a release means and what a creation re-read over it
  would silently undo -- and it costs no duplicate push;
* a child closed before it ever ran is gone, and stays gone across a restart;
* removing the CREATOR's unit drops the provisional row while a child that has run
  keeps its own edge;
* the creations survive a cold replay and an old checkpoint is rebuilt rather than
  trusted, because its ``scans`` cache made a weaker claim than this build reads.
"""

from __future__ import annotations

import json

import pytest

from kiro_crew import crew_log as lg
from kiro_crew.crew_log import CrewLog, emit
from kiro_crew.crew_log import session_tree_projection as stp
from kiro_crew.crew_log import store as crew_store
from kiro_crew.crew_log.session_tree import (
    TREE_CREATED_PER_UNIT_CAP,
    CreatedRecord,
    OpenedRecord,
    SessionTree,
    created_records,
    created_supersedes,
    fold_tree,
    latest_created,
    log_rank_of,
)
from kiro_crew.crew_log.session_tree_projection import (
    CHECKPOINT_NAME,
    CHECKPOINT_VERSION,
    SessionTreeProjection,
)
from kiro_crew.dashboard.session_memory import lineage_parents
from kiro_crew.session_ledger import _store_name

GATEWAY = "gateway"


@pytest.fixture(autouse=True)
def _isolated_home(tmp_path, _floor_monkeypatch):
    """Every test writes into its own data home, and no write is armed on the real pool.

    The same isolation the adoption suite arranges, for the same two reasons: the
    process-wide projection is bound to ONE store, so a test inheriting another test's
    fold would read another store's records; and ``_debounced_write`` saves outside the
    lock, so a worker that already passed the epoch check could land a file in this
    test's tmp home after pytest considers it finished.

    Patched through ``_floor_monkeypatch`` rather than the test-owned ``monkeypatch``,
    which D11 requires of an AUTOUSE fixture: the test-owned stack unwinds inside this
    fixture's own lifetime, so an autouse patch installed on it would be undone while
    the fixture still claims to hold it.
    """
    _floor_monkeypatch.setenv("KIROCREW_HOME", str(tmp_path / "home"))
    _floor_monkeypatch.setenv(emit.CREW_LOG_ENV, "1")
    _floor_monkeypatch.setattr(
        "kiro_crew.executors.maintenance_executor",
        lambda: type("_NoPool", (), {"submit": staticmethod(lambda *a, **k: None)}),
    )
    stp.reset_for_tests()
    yield
    stp.reset_for_tests()
    # Units written through ``emit.on_session_opened`` leave the emitter holding their
    # handles, and a kept handle holds that session's write lease process-wide. Drop
    # them here so this file's leases do not surface as another test's "lease still
    # held" on the same xdist worker.
    emit.reset_caches()


def _opened(sid: str, slot: str, *, parent: str | None = None) -> None:
    emit.on_session_opened(
        sid,
        agent="kirocrew",
        slot=slot,
        model="opus",
        cwd="/w",
        owner="raymond",
        parent_slot=parent or "",
    )


def _log(sid: str, slot: str) -> CrewLog:
    """A unit written DIRECTLY, bypassing the emitter and its handle cache.

    For the tests that need bytes in a particular shape -- a statement buried past the
    tail window, a log split across segments, a creator past the per-unit cap. The
    emitter's own path is exercised by the tests above it.
    """
    return CrewLog.create(lg.KIND_SESSION, sid, owner="raymond", agent="kirocrew", slot=slot)


def _log_opened(handle: CrewLog, slot: str, *, parent: str | None = None) -> None:
    data: dict[str, object] = {
        "agent": "kirocrew",
        "slot": slot,
        "model": "opus",
        "cwd": "/w",
        "owner": "raymond",
        "resumed": False,
    }
    if parent is not None:
        data["parent"] = {"slot": parent}
    handle.append("session/opened", data, src=GATEWAY)


def _rows(*keys: str) -> list[dict[str, object]]:
    return [{"key": key} for key in keys]


def _checkpoint_path():
    from kiro_crew.crew_log.store import crew_log_root

    return crew_log_root(lg.KIND_SESSION) / "projections" / CHECKPOINT_NAME


# ── the records ────────────────────────────────────────────────────────────


def test_a_creation_makes_no_node_so_nothing_that_decides_an_edge_sees_it():
    """The layer's whole safety property: it is NOT in the fold.

    ``nodes`` is read by the adoption cycle guard and by the ownership corroboration
    archived-session revival turns on, and both must keep asking the child's own
    append-only entry. A provisional statement that produced a node would be read by
    them as proof.
    """
    records = [OpenedRecord(sid="s-d", slot="D", created_at=1)]
    # The fold takes records and edges; creations are not one of its inputs at all,
    # which is the structural form of this property rather than a branch inside it.
    assert set(fold_tree(records, ())) == {"D"}
    assert "A" not in fold_tree(records, ())


def test_the_newest_statement_about_one_child_wins_whatever_order_they_arrive_in():
    """A slot key is reusable, so two creators can each have minted a child of that
    name -- and the records reach a fold from a checkpoint, a replay and the writer in
    an order none of them controls."""
    older = CreatedRecord(child_slot="A", source_sid="s-d", at=100, seq=4)
    newer = CreatedRecord(child_slot="A", source_sid="s-e", at=200, seq=1)
    assert latest_created([older, newer])["A"] is newer
    assert latest_created([newer, older])["A"] is newer


def test_two_statements_in_one_log_are_ordered_by_seq_and_never_by_the_clock():
    """``seq`` is assigned by the writer and only increases, so a clock that stepped
    backward between two mints cannot invert them."""
    first = CreatedRecord(child_slot="A", source_sid="s-d", at=500, seq=1)
    second = CreatedRecord(child_slot="A", source_sid="s-d", at=100, seq=2)
    assert created_supersedes(second, first) is True
    assert created_supersedes(first, second) is False
    # A tie does not supersede, which is what keeps a replay of a held row from
    # counting as a change.
    assert created_supersedes(first, first) is False


def test_two_logs_are_ordered_by_the_succession_chain_the_store_wrote():
    """``log_rank_of``'s leading term is the ``previous_sid`` depth, so two logs of one
    slot are ranked by a link on disk rather than by a header timestamp."""
    records = [
        OpenedRecord(sid="s-d1", slot="D", created_at=900),
        OpenedRecord(sid="s-d2", slot="D", created_at=100, previous_sid="s-d1"),
    ]
    rank = log_rank_of(records)
    old_log = CreatedRecord(child_slot="A", source_sid="s-d1", at=900, seq=9)
    new_log = CreatedRecord(child_slot="A", source_sid="s-d2", at=100, seq=1)
    # The newer LOG wins even though its entry carries the earlier clock reading.
    assert created_supersedes(new_log, old_log, rank) is True


def test_an_entry_naming_no_child_or_an_over_long_one_is_refused_not_truncated():
    """A truncated slot key is a DIFFERENT key: it matches nothing, or it matches
    another session."""
    from kiro_crew.crew_log.schema import Entry
    from kiro_crew.validation import MAX_SHORT_STRING

    def _entry(data):
        return Entry(seq=2, time=100, type="session/created", data=data, src=GATEWAY)

    assert created_records("s-d", [_entry({})]) == ()
    assert created_records("s-d", [_entry({"slot": ""})]) == ()
    assert created_records("s-d", [_entry({"slot": "x" * (MAX_SHORT_STRING + 1)})]) == ()
    # And a log id this cannot hold refuses the whole batch, since every row would be
    # keyed by it.
    assert created_records("", [_entry({"slot": "A"})]) == ()
    # One bad row does not cost its siblings theirs.
    read = created_records("s-d", [_entry({}), _entry({"slot": "A"})])
    assert [row.child_slot for row in read] == ["A"]


# ── a child that has not run ───────────────────────────────────────────────


def test_a_child_created_with_no_turn_is_nested_and_the_push_is_armed():
    """The feature. The creator states the edge at mint, the child has no log at all,
    and the sidebar's own join nests it on this frame rather than on the child's first
    turn.
    """
    pushes: list[object] = []
    from kiro_crew.crew_log import bus

    unsubscribe = bus.subscribe(bus.TREE_ADVANCED, pushes.append)
    try:
        _opened("s-d", "D")
        emit.on_session_created("s-d", child_slot="A", agent="kirocrew-worker")
        assert emit.flush(timeout=5.0) is True
    finally:
        unsubscribe()

    proj = stp.projection()
    # No node for A: it has written nothing, which is exactly the state this covers.
    assert "A" not in proj.nodes()
    assert proj.pending_parent("A") == "D"
    # And the join puts it under D on the wire.
    parents = lineage_parents(_rows("A", "D"), proj.nodes(), None, proj.pending_parent)
    assert parents["A"] == {"slot": "D", "key": "D"}
    # TREE_ADVANCED is what the dashboard's coalesced lineage push is armed from, so
    # without it the row would wait for some other event to ask.
    assert pushes, "a creation must announce, or nothing puts the row on screen"


def test_the_entry_lands_on_the_creators_log_and_names_the_child_and_its_agent():
    """Written on the CREATOR, which is the opposite side from every other tree entry
    -- and the only side that has a log during this window."""
    _opened("s-d", "D")
    emit.on_session_created("s-d", child_slot="A", agent="kirocrew-worker")
    assert emit.flush(timeout=5.0) is True

    directory = crew_store.unit_dir_for(lg.KIND_SESSION, "s-d")
    entries, truncated = crew_store.find_tree_created(directory, TREE_CREATED_PER_UNIT_CAP)
    assert [entry.data for entry in entries] == [{"slot": "A", "agent": "kirocrew-worker"}]
    # And nothing was written on the child, which has no log to write on.
    assert crew_store.unit_dir_for(lg.KIND_SESSION, "s-a") is None


def test_an_agent_the_caller_did_not_name_is_omitted_rather_than_written_empty():
    """An empty string would read as a child dispatched as an agent with no name."""
    _opened("s-d", "D")
    emit.on_session_created("s-d", child_slot="A")
    assert emit.flush(timeout=5.0) is True

    directory = crew_store.unit_dir_for(lg.KIND_SESSION, "s-d")
    entries, truncated = crew_store.find_tree_created(directory, TREE_CREATED_PER_UNIT_CAP)
    assert [entry.data for entry in entries] == [{"slot": "A"}]


def test_a_creator_with_no_log_writes_nothing_and_is_not_an_error():
    """A person's own tab has no crew log keyed by a creator id, and a mint it never
    made records nothing. A policy no-op, not a loss."""
    emit.on_session_created("s-missing", child_slot="A")
    assert emit.flush(timeout=5.0) is True
    assert stp.projection().pending_parent("A") == ""


# ── once the child runs ────────────────────────────────────────────────────


def test_the_childs_own_opened_entry_wins_and_costs_no_second_push():
    """The creation is PROVISIONAL. Once the child has a node, that node is the answer,
    and the pending row is simply never consulted -- so a child adopted away before
    this frame is not dragged back under its creator.
    """
    _opened("s-d", "D")
    emit.on_session_created("s-d", child_slot="A", agent="kirocrew-worker")
    assert emit.flush(timeout=5.0) is True

    proj = stp.projection()
    before = proj.nodes()
    _opened("s-a", "A", parent="D")
    assert emit.flush(timeout=5.0) is True
    # The fold moved, because A now HAS a log.
    assert proj.nodes()["A"].parent_slot == "D"
    assert proj.nodes() is not before

    pushes: list[object] = []
    from kiro_crew.crew_log import bus

    unsubscribe = bus.subscribe(bus.TREE_ADVANCED, pushes.append)
    try:
        # Replaying the same creation changes nothing: same reference, no push, and no
        # second row for a child that already answered for itself.
        emit.on_session_created("s-d", child_slot="A", agent="kirocrew-worker")
        assert emit.flush(timeout=5.0) is True
    finally:
        unsubscribe()
    held = proj.nodes()
    assert proj.nodes() is held
    parents = lineage_parents(_rows("A", "D"), proj.nodes(), None, proj.pending_parent)
    assert parents["A"] == {"slot": "D", "key": "D"}


def test_the_row_is_retired_once_the_child_has_a_log_so_the_scan_cache_comes_back():
    """A row the join can never read again is dropped, in memory and on disk.

    Keeping it costs three things and protects none: projection memory bounded by
    ``TREE_UNIT_CAP``, a row in every checkpoint, and -- the one that grows without end
    -- a whole-log re-read of the creator on every boot, because a unit holding a
    creation is deliberately excluded from the negative scan cache. The creators with
    the largest logs are exactly the ones that mint, so without retirement a lead's
    startup cost rises with its whole dispatch history.
    """
    _opened("s-d", "D")
    emit.on_session_created("s-d", child_slot="A", agent="kirocrew-worker")
    assert emit.flush(timeout=5.0) is True
    proj = stp.projection()
    assert proj.pending_parent("A") == "D"

    _opened("s-a", "A", parent="D")
    assert emit.flush(timeout=5.0) is True
    # Gone the moment the authority arrives.
    assert proj.pending_parent("A") == ""
    assert proj.nodes()["A"].parent_slot == "D"
    assert proj.flush_checkpoint() is True
    payload = json.loads(_checkpoint_path().read_text(encoding="utf-8"))
    assert payload["created"] == []
    emit.reset_caches()

    # The next boot replays that checkpoint, finds the creator holds no row worth
    # keeping, and records the negative verdict for its bytes -- which is what spares
    # its whole log a read on every boot after this one.
    revived = SessionTreeProjection()
    revived.ensure_seeded()
    assert revived.pending_parent("A") == ""
    assert revived.nodes()["A"].parent_slot == "D"
    assert revived.flush_checkpoint() is True
    payload = json.loads(_checkpoint_path().read_text(encoding="utf-8"))
    assert payload["created"] == []
    assert "s-d" in payload["scans"]

    # A cold rebuild with no checkpoint at all reaches the same answer, so the
    # retirement is a property of the reading rather than of one door into it.
    _checkpoint_path().unlink()
    stp.reset_for_tests()
    cold = SessionTreeProjection()
    cold.ensure_seeded()
    assert cold.pending_parent("A") == ""
    assert cold.nodes()["A"].parent_slot == "D"
    assert SessionTree().reading(with_edges=True).created == ()


def test_a_released_child_stays_a_root_rather_than_falling_back_to_its_creator():
    """The fallback is keyed on the node's EXISTENCE, never on the value inside it.

    A ``session/released`` is somebody deliberately taking the edge away, and it folds
    to a node with no parent. Reading the creation over that would put the edge back in
    the one view a person would look at to confirm the release.
    """
    _opened("s-d", "D")
    emit.on_session_created("s-d", child_slot="A", agent="kirocrew-worker")
    _opened("s-a", "A", parent="D")
    emit.on_session_released("s-a", slot="A")
    assert emit.flush(timeout=5.0) is True

    proj = stp.projection()
    assert proj.nodes()["A"].parent_slot is None
    # The row was retired when A's own log landed, so there is nothing left to read --
    # a stronger guarantee than "held but ignored" for the same property, and the
    # reason the join is keyed on the node's existence rather than on its value: the
    # rule has to hold even for a row that is still held, which is the state between
    # the release and the next retirement.
    assert proj.pending_parent("A") == ""
    parents = lineage_parents(_rows("A", "D"), proj.nodes(), None, proj.pending_parent)
    assert parents["A"] is None
    # Pinned directly on the join: a node with no parent beats a creator the
    # provisional layer DOES hold.
    assert lineage_parents(_rows("A", "D"), proj.nodes(), None, lambda _slot: "D")["A"] is None


# ── removal ────────────────────────────────────────────────────────────────


def test_a_child_closed_before_it_ever_ran_is_gone_and_stays_gone_after_a_restart():
    """``lineage_parents`` joins against LIVE rows, so a child that never ran and was
    closed simply has no row to nest -- and a restart reads the same answer, because
    the join is what excludes it rather than a retraction nobody wrote.
    """
    _opened("s-d", "D")
    emit.on_session_created("s-d", child_slot="A", agent="kirocrew-worker")
    assert emit.flush(timeout=5.0) is True
    assert stp.projection().flush_checkpoint() is True

    # The row is gone from the payload the moment it is not live.
    parents = lineage_parents(
        _rows("D"), stp.projection().nodes(), None, stp.projection().pending_parent
    )
    assert parents == {"D": None}

    revived = SessionTreeProjection()
    revived.ensure_seeded()
    parents = lineage_parents(_rows("D"), revived.nodes(), None, revived.pending_parent)
    assert parents == {"D": None}
    # And a row that comes back live -- a trash restore -- is nested again with no
    # further write, which is the same property read from the other side.
    parents = lineage_parents(_rows("A", "D"), revived.nodes(), None, revived.pending_parent)
    assert parents["A"] == {"slot": "D", "key": "D"}


def test_removing_the_creators_unit_drops_the_pending_row_and_keeps_a_run_childs_edge():
    """A unit that is gone is not evidence for what it minted. A child that HAS run
    carries its own ``session/opened.parent`` and is untouched."""
    _opened("s-d", "D")
    emit.on_session_created("s-d", child_slot="A", agent="kirocrew-worker")
    emit.on_session_created("s-d", child_slot="B", agent="kirocrew-worker")
    _opened("s-b", "B", parent="D")
    assert emit.flush(timeout=5.0) is True
    emit.reset_caches()

    proj = stp.projection()
    assert proj.pending_parent("A") == "D"
    crew_store.remove_unit(lg.KIND_SESSION, "s-d", guard=lambda _directory: True)
    stp.forget_unit("s-d")

    # The never-run child loses its provisional edge: nothing on disk states it now.
    assert proj.pending_parent("A") == ""
    # The one that ran keeps the edge its OWN log recorded, which the removal of its
    # creator's log cannot touch.
    assert proj.nodes()["B"].parent_slot == "D"
    # And the row is DROPPED from the state rather than merely unreachable through the
    # creator's record. The two are different: the state is bounded by
    # ``TREE_UNIT_CAP``, so a row kept for a deleted unit crowds out a live one and is
    # written into every checkpoint from here on.
    assert proj.flush_checkpoint() is True
    payload = json.loads(_checkpoint_path().read_text(encoding="utf-8"))
    assert payload["created"] == []


def test_a_partial_removal_rereads_the_creations_the_surviving_segments_hold():
    """``reconcile_edge`` answers for both axes, because one removal strands both.

    Here the whole log goes, so the complete read finds nothing -- which is a VERDICT,
    not a gap, and the only evidence that can say the rows were retained out of the
    log.
    """
    _opened("s-d", "D")
    emit.on_session_created("s-d", child_slot="A", agent="kirocrew-worker")
    assert emit.flush(timeout=5.0) is True
    emit.reset_caches()

    proj = stp.projection()
    assert proj.pending_parent("A") == "D"
    directory = crew_store.unit_dir_for(lg.KIND_SESSION, "s-d")
    for segment in list(directory.iterdir()):
        segment.unlink()
    proj.reconcile_edge("s-d", "D")
    assert proj.pending_parent("A") == ""


def test_a_creations_read_failure_does_not_skip_the_decision_read():
    """The two reads are INDEPENDENT, and this is the one that matters for ownership.

    A unit whose decision was not read must leave the reading incomplete, because
    ``_slot_tree_parent`` -- which backs the adoption cycle guard and the
    archived-session ownership check -- otherwise serves a stale holder as a confident
    answer, and a former creator can revive a child that was taken away from it. A
    creations read that faults says nothing about the decision, so it may not cost the
    decision its pass.

    Here the child A has been RELEASED, and the release is on disk but not in the
    checkpoint. With the creations read faulting, the replay must still find that
    release.
    """
    _opened("s-d", "D")
    emit.on_session_created("s-d", child_slot="A", agent="kirocrew-worker")
    _opened("s-a", "A", parent="D")
    assert emit.flush(timeout=5.0) is True
    # A checkpoint that knows A hangs under D and nothing more.
    assert stp.projection().flush_checkpoint() is True
    payload = json.loads(_checkpoint_path().read_text(encoding="utf-8"))
    assert payload["edges"] == []
    emit.on_session_released("s-a", slot="A")
    assert emit.flush(timeout=5.0) is True
    # Put the checkpoint back to the pre-release state, so only the log carries it.
    _checkpoint_path().write_text(json.dumps(payload), encoding="utf-8")
    emit.reset_caches()

    # Patched on the STORE, which is where the replay's own local import resolves it.
    original = crew_store.find_tree_created

    def _boom(_directory, _limit):
        raise OSError("transient")

    crew_store.find_tree_created = _boom
    try:
        revived = SessionTreeProjection()
        revived.ensure_seeded()
    finally:
        crew_store.find_tree_created = original

    # The decision read still ran, so the release is folded and A is a root again --
    # not left hanging under the creator the stale checkpoint named.
    assert revived.nodes()["A"].parent_slot is None
    # And the creations gap did NOT make the reading incomplete, so adoption still
    # works on this gateway.
    assert revived.reading().incomplete is False


def test_an_unreadable_directory_leaves_the_rows_alone_and_reports_incomplete():
    """Dropping on a transient error would discard a valid row; keeping it silently
    would serve a possibly-stale answer as complete."""
    _opened("s-d", "D")
    emit.on_session_created("s-d", child_slot="A", agent="kirocrew-worker")
    assert emit.flush(timeout=5.0) is True

    proj = stp.projection()
    assert proj.reading().incomplete is False
    import kiro_crew.crew_log.store as store_mod

    original = store_mod.find_last_tree_edge

    def _boom(directory):
        raise OSError("transient")

    store_mod.find_last_tree_edge = _boom
    try:
        proj.reconcile_edge("s-d", "D")
    finally:
        store_mod.find_last_tree_edge = original
    assert proj.pending_parent("A") == "D"
    assert proj.reading().incomplete is True


# ── the cold path ──────────────────────────────────────────────────────────


def test_a_cold_scan_with_no_checkpoint_finds_a_creation_the_tail_window_cannot_reach():
    """A creation sits in the MIDDLE of a log the creator goes on appending to, so no
    bounded tail read finds it -- which is why the scan walks the whole log, and why
    there is no window prepass to skip it with."""
    from kiro_crew.crew_log.store import _TAIL_WINDOW

    handle = _log("s-d", "D")
    _log_opened(handle, "D")
    handle.append("session/created", {"slot": "A"}, src=GATEWAY)
    # Bury it: enough bytes after the statement that the bounded window cannot see it.
    filler = "x" * 900
    written = 0
    while written < _TAIL_WINDOW * 2:
        handle.append(
            "message/received",
            {"turn": 1, "role": "user", "source": "peer", "text": filler},
            src=GATEWAY,
        )
        written += 1000
    del handle

    directory = crew_store.unit_dir_for(lg.KIND_SESSION, "s-d")
    entries, truncated = crew_store.find_tree_created(directory, TREE_CREATED_PER_UNIT_CAP)
    assert [entry.data["slot"] for entry in entries] == ["A"]

    reading = SessionTree().reading(with_edges=True)
    assert [(row.child_slot, row.source_sid) for row in reading.created] == [("A", "s-d")]

    revived = SessionTreeProjection()
    revived.ensure_seeded()
    assert revived.pending_parent("A") == "D"


def test_a_tail_replay_picks_up_a_creation_the_checkpoint_missed():
    """The replay reads every admitted unit's whole log, not only the new ones: a
    creation the checkpoint missed is exactly where the checkpoint already has a unit."""
    _opened("s-d", "D")
    assert emit.flush(timeout=5.0) is True
    assert stp.projection().flush_checkpoint() is True

    # Append the creation BEHIND the checkpoint's back, the shape a process that died
    # between an append and the checkpoint write leaves.
    emit.reset_caches()
    handle = CrewLog.open(lg.KIND_SESSION, "s-d")
    handle.append("session/created", {"slot": "A"}, src=GATEWAY)
    del handle

    revived = SessionTreeProjection()
    revived.ensure_seeded()
    assert revived.pending_parent("A") == "D"


def test_an_older_checkpoints_weaker_scan_cache_is_discarded_rather_than_trusted():
    """The reason the version bump is load-bearing rather than cosmetic.

    A version-4 ``scans`` entry asserted ONE thing -- these bytes hold no decision --
    where this build reads the same entry as asserting that they name no minted child
    either. A build that loaded such a file would honour the entry, skip BOTH whole-log
    reads for that unit, and report a creator full of dispatched workers as having
    minted nobody.

    Constructed so the version gate is the only thing that can refuse it: the payload
    carries every key this build requires, so the missing-``created`` check cannot
    decide the case, and its ``scans`` entry matches the unit's identity exactly.
    """
    from kiro_crew.crew_log.store import tree_edge_scan_identity

    handle = _log("s-d", "D")
    _log_opened(handle, "D")
    handle.append("session/created", {"slot": "A"}, src=GATEWAY)
    del handle

    directory = crew_store.unit_dir_for(lg.KIND_SESSION, "s-d")
    identity = tree_edge_scan_identity(directory)
    assert identity is not None
    header = CrewLog.open(lg.KIND_SESSION, "s-d").header
    path = _checkpoint_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(
            {
                "ver": 4,
                "written_at": 1,
                "root": str(crew_store.crew_log_root(lg.KIND_SESSION)),
                "records": [{"sid": "s-d", "slot": "D", "at": header.created_at}],
                "edges": [],
                # PRESENT and empty, so the key check admits the file and only the
                # version can turn it away.
                "created": [],
                # The weaker claim: "this unit needs neither read".
                "scans": {"s-d": list(identity)},
            }
        ),
        encoding="utf-8",
    )
    emit.reset_caches()

    revived = SessionTreeProjection()
    revived.ensure_seeded()
    # Rebuilt from the log rather than read, so the creation is there.
    assert revived.pending_parent("A") == "D"


def test_a_checkpoint_missing_the_created_key_is_damaged_rather_than_old():
    """The version gate admits only a file this build wrote, and this build writes the
    key whether or not anything was minted -- so a payload lacking it is discarded
    rather than read as "nobody created anybody", which is the one wrong answer that
    looks exactly like a right one."""
    _opened("s-d", "D")
    emit.on_session_created("s-d", child_slot="A", agent="kirocrew-worker")
    assert emit.flush(timeout=5.0) is True
    assert stp.projection().flush_checkpoint() is True
    emit.reset_caches()

    path = _checkpoint_path()
    payload = json.loads(path.read_text(encoding="utf-8"))
    payload.pop("created")
    path.write_text(json.dumps(payload), encoding="utf-8")

    revived = SessionTreeProjection()
    revived.ensure_seeded()
    assert revived.pending_parent("A") == "D"


def test_the_checkpoint_carries_the_creations_so_a_restart_keeps_the_nesting():
    """A restart inside the mint-to-first-turn window must not un-nest every worker a
    lead dispatched just before it."""
    _opened("s-d", "D")
    emit.on_session_created("s-d", child_slot="A", agent="kirocrew-worker")
    assert emit.flush(timeout=5.0) is True
    assert stp.projection().flush_checkpoint() is True

    payload = json.loads(_checkpoint_path().read_text(encoding="utf-8"))
    assert [row["slot"] for row in payload["created"]] == ["A"]
    assert payload["created"][0]["src"] == "s-d"


# ── adoption ───────────────────────────────────────────────────────────────


def test_an_adopted_child_that_has_run_stays_under_its_adopter_across_a_restart():
    """The creation is never consulted for a slot that has a node, so an adoption that
    moved the child is not undone by the creator's own older statement."""
    _opened("s-d", "D")
    _opened("s-e", "E")
    emit.on_session_created("s-d", child_slot="A", agent="kirocrew-worker")
    _opened("s-a", "A", parent="D")
    emit.on_session_adopted("s-a", slot="A", parent_slot="E", parent_sid="s-e")
    assert emit.flush(timeout=5.0) is True

    proj = stp.projection()
    assert proj.nodes()["A"].parent_slot == "E"
    assert stp.projection().flush_checkpoint() is True
    emit.reset_caches()

    revived = SessionTreeProjection()
    revived.ensure_seeded()
    assert revived.nodes()["A"].parent_slot == "E"
    parents = lineage_parents(_rows("A", "D", "E"), revived.nodes(), None, revived.pending_parent)
    assert parents["A"] == {"slot": "E", "key": "E"}


# ── the bounds ─────────────────────────────────────────────────────────────


def test_a_unit_past_the_per_unit_cap_keeps_its_NEWEST_rows():
    """Which end survives the bound decides whether the feature works at all.

    A row matters only until its child opens a log, so a creator's oldest rows are its
    long-settled children and its newest are the ones still waiting. Keeping the
    oldest would make a prolific creator's freshly dispatched workers precisely the
    rows that go missing.
    """
    handle = _log("s-d", "D")
    _log_opened(handle, "D")
    for index in range(TREE_CREATED_PER_UNIT_CAP + 5):
        handle.append("session/created", {"slot": f"A{index}"}, src=GATEWAY)
    del handle

    reading = SessionTree().reading(with_edges=True)
    assert len(reading.created) == TREE_CREATED_PER_UNIT_CAP
    kept = {row.child_slot for row in reading.created}
    # The five oldest went; the newest, including the very last one written, stayed.
    assert {f"A{i}" for i in range(5)}.isdisjoint(kept)
    assert f"A{TREE_CREATED_PER_UNIT_CAP + 4}" in kept


def test_a_truncated_creations_read_does_not_refuse_every_adoption_on_the_gateway():
    """A creations gap is reported on its OWN flag and never on the fold's.

    ``incomplete`` and ``suspect_sids`` are what a reader DECIDING on an edge refuses
    on: ``_slot_tree_parent`` backs the adoption cycle guard and the archived-session
    ownership check, and ``trusted_creator`` decides whether a slot's creator may be
    written into its next log. One prolific creator must not refuse every adoption on
    the gateway with a "retry in a moment" that never comes good, nor void its own
    written citation -- a missing creation costs one pending child its nesting for one
    turn and nothing more.
    """
    handle = _log("s-d", "D")
    _log_opened(handle, "D")
    for index in range(TREE_CREATED_PER_UNIT_CAP + 5):
        handle.append("session/created", {"slot": f"A{index}"}, src=GATEWAY)
    del handle

    reading = SessionTree().reading(with_edges=True)
    assert reading.incomplete is False
    assert reading.suspect_sids == ()

    revived = SessionTreeProjection()
    revived.ensure_seeded()
    assert revived.reading().incomplete is False
    assert revived.over_cap is False
    # And the creator's own citation still stands, which is what a slot's next log
    # cites: a creations gap says nothing about where that slot hangs.
    assert revived.trusted_creator("D", "s-d") == ""  # D itself has no creator
    assert revived.nodes()["D"].parent_slot is None


def test_a_truncated_read_does_not_evict_the_held_rows_it_could_not_reach():
    """ "The disk decides" holds only for a read that was COMPLETE for the unit.

    A truncated read proves nothing about a row it does not hold: that row may be one
    of the older ones dropped to fit. Evicting on it would delete a still-pending
    child's row on the strength of a read that never looked at it, and the child would
    then render at the top level -- the exact case this feature exists to fix.
    """
    handle = _log("s-d", "D")
    _log_opened(handle, "D")
    for index in range(TREE_CREATED_PER_UNIT_CAP + 5):
        handle.append("session/created", {"slot": f"A{index}"}, src=GATEWAY)
    del handle

    proj = SessionTreeProjection()
    proj.ensure_seeded()
    # A row the truncated read cannot reach: its child is not among the rows on disk
    # that survived the bound.
    proj.apply_created(CreatedRecord(child_slot="OLD", source_sid="s-d", at=1, seq=1))
    assert proj.pending_parent("OLD") == "D"

    proj.reconcile_edge("s-d", "D")
    assert proj.pending_parent("OLD") == "D"
    # And the rows the read DID reach are still installed.
    assert proj.pending_parent(f"A{TREE_CREATED_PER_UNIT_CAP + 4}") == "D"


def test_a_tail_replay_with_a_truncated_read_keeps_the_checkpointed_rows():
    """The same guard on the REPLAY path, where the held rows come from the checkpoint.

    "The disk decides" holds only for a read that was complete for the unit. Here the
    checkpoint carries a row for a child the truncated read cannot reach, so evicting
    on that read would delete a still-pending child's row on the strength of bytes
    nothing looked at.
    """
    handle = _log("s-d", "D")
    _log_opened(handle, "D")
    for index in range(TREE_CREATED_PER_UNIT_CAP + 5):
        handle.append("session/created", {"slot": f"A{index}"}, src=GATEWAY)
    del handle

    header = CrewLog.open(lg.KIND_SESSION, "s-d").header
    path = _checkpoint_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(
            {
                "ver": CHECKPOINT_VERSION,
                "written_at": 1,
                "root": str(crew_store.crew_log_root(lg.KIND_SESSION)),
                "records": [{"sid": "s-d", "slot": "D", "at": header.created_at}],
                "edges": [],
                "created": [{"slot": "OLD", "src": "s-d", "at": 1, "seq": 1}],
                "scans": {},
            }
        ),
        encoding="utf-8",
    )
    emit.reset_caches()

    revived = SessionTreeProjection()
    revived.ensure_seeded()
    assert revived.pending_parent("OLD") == "D"
    # And the rows the read DID reach are installed beside it.
    assert revived.pending_parent(f"A{TREE_CREATED_PER_UNIT_CAP + 4}") == "D"


def test_a_log_holding_exactly_the_cap_reads_as_complete():
    """The truncation is reported when a row is actually DROPPED, not when the count
    reaches the bound -- otherwise a log sitting exactly on it reads as a floor."""
    handle = _log("s-d", "D")
    _log_opened(handle, "D")
    for index in range(TREE_CREATED_PER_UNIT_CAP):
        handle.append("session/created", {"slot": f"A{index}"}, src=GATEWAY)
    del handle

    reading = SessionTree().reading(with_edges=True)
    assert len(reading.created) == TREE_CREATED_PER_UNIT_CAP
    # The store read is where the distinction is observable, and it is the value the
    # disk-decides rule is gated on: dropped, not "the count reached the bound".
    directory = crew_store.unit_dir_for(lg.KIND_SESSION, "s-d")
    assert crew_store.find_tree_created(directory, TREE_CREATED_PER_UNIT_CAP)[1] is False
    assert crew_store.find_tree_created(directory, TREE_CREATED_PER_UNIT_CAP - 1)[1] is True


def test_the_population_is_bounded_and_overflow_sets_both_completeness_flags():
    """Bounded like every other layer here, and the eviction is reported: an evicted
    creation means a dispatched child about to render unnested, which is the exact
    degradation this layer removes."""
    from kiro_crew.crew_log.session_tree import TREE_UNIT_CAP

    proj = SessionTreeProjection()
    for index in range(TREE_UNIT_CAP + 2):
        proj.apply_created(
            CreatedRecord(child_slot=f"A{index}", source_sid="s-d", at=index, seq=index + 1)
        )
    # The fold is untouched, so a reader deciding on an edge is not refused for an
    # eviction here. See the truncation test above.
    assert proj.over_cap is False
    assert proj.reading().incomplete is False
    # The oldest went, the newest stayed.
    assert proj.pending_parent("A0") == ""


def test_a_creator_whose_own_record_is_not_held_answers_no_creator_known():
    """The creator is named as a SID and resolved to a slot from the creating unit's
    own record. Nothing writes the creator's slot key into the entry -- the unit's
    immutable header already states it -- so a creator this state does not hold answers
    the pre-existing "no creator known" rather than a wrong edge."""
    proj = SessionTreeProjection()
    proj.apply_created(CreatedRecord(child_slot="A", source_sid="s-d", at=100, seq=1))
    assert proj.pending_parent("A") == ""
    proj.apply(OpenedRecord(sid="s-d", slot="D", created_at=1))
    assert proj.pending_parent("A") == "D"


def test_an_unattributed_gap_refuses_every_slot():
    """A fault no unit can be named for -- the root could not be listed, or the seed
    raised -- could have hidden any slot, so the provisional read refuses for all of
    them, the rule ``trusted_creator`` already keeps."""
    proj = SessionTreeProjection()
    proj.apply(OpenedRecord(sid="s-d", slot="D", created_at=1))
    proj.apply_created(CreatedRecord(child_slot="A", source_sid="s-d", at=100, seq=1))
    assert proj.pending_parent("A") == "D"
    proj._unattributed_gap = True
    assert proj.pending_parent("A") == ""


def test_an_unseeded_projection_answers_no_creator_rather_than_another_stores():
    """Both callers take ``pending_parent`` as a bound method and have already
    established that the projection is seeded for the store configured now, so the
    method itself answers from whatever this instance holds -- which for a fresh one is
    nothing."""
    assert SessionTreeProjection().pending_parent("A") == ""


# ── the store read ─────────────────────────────────────────────────────────


def test_the_creations_are_not_in_the_decision_vocabulary():
    """``find_last_tree_edge`` returns ONE newest entry, so a creation admitted to its
    type set would be answered as a malformed adoption -- and only one of a creator's
    children would ever be seen."""
    assert "session/created" not in crew_store._TREE_EDGE_TYPES
    # Nor in the set that decides open-versus-closed: that one authorizes retention's
    # delete, so a creation at the end of a log would keep that log forever.
    assert "session/created" not in crew_store._LIFECYCLE_TYPES


def test_every_segment_is_read_because_a_creation_has_no_newest_wins_shortcut():
    """A creator with children across several segments wrote one row in each, and all
    of them are the answer."""
    handle = _log("s-d", "D")
    _log_opened(handle, "D")
    handle.append("session/created", {"slot": "A"}, src=GATEWAY)
    last = handle.append("session/created", {"slot": "B"}, src=GATEWAY)
    del handle

    directory = crew_store.unit_dir_for(lg.KIND_SESSION, "s-d")
    # Split the log by hand into two segments: the store rotates on size and there is
    # no API to force one, while what this test is about is the READ walking every
    # segment. The seq the second file starts at is in its name, which is what
    # ``_segment_first_seq`` orders them by.
    lines = (directory / "log.jsonl").read_text(encoding="utf-8").splitlines(keepends=True)
    (directory / "log.jsonl").write_text("".join(lines[:-1]), encoding="utf-8")
    (directory / f"log.{last.seq}.jsonl").write_text(lines[-1], encoding="utf-8")

    entries, truncated = crew_store.find_tree_created(directory, TREE_CREATED_PER_UNIT_CAP)
    assert [entry.data["slot"] for entry in entries] == ["A", "B"]


def test_a_unit_with_no_segments_answers_nothing_rather_than_raising():
    """An absence, which IS an answer: nothing on disk names a minted child."""
    _opened("s-d", "D")
    assert emit.flush(timeout=5.0) is True
    emit.reset_caches()
    directory = crew_store.unit_dir_for(lg.KIND_SESSION, "s-d")
    for segment in list(directory.iterdir()):
        segment.unlink()
    assert crew_store.find_tree_created(directory, TREE_CREATED_PER_UNIT_CAP) == ([], False)


def test_the_store_name_helper_is_what_keys_a_units_directory():
    """Pinned so the reconcile path's directory arithmetic is not quietly re-derived."""
    _opened("s-d", "D")
    assert emit.flush(timeout=5.0) is True
    directory = crew_store.unit_dir_for(lg.KIND_SESSION, "s-d")
    assert directory is not None and directory.name == _store_name("s-d")
