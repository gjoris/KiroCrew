"""Gateway-owned guide runs: the state machine behind the ``kirocrew-guide`` tools.

A guide is an offer, made by an agent, to walk the human through an ordered list
of registered actions (:mod:`kiro_crew.guide_catalog`). The gateway owns every
piece of state; the MCP shim holds none, and a browser reload reads it back from
``GET /api/guide/pending``.

Lifecycle::

    offered --claim--> active --progress/commit--> ... --> completed
       ^                 |  \\--target missing--> target_missing --target found--> active
       |                 |
       +--lease lapses---+        any non-terminal --cancel--> cancelled
                                  any non-terminal --TTL-----> expired

* ``completed``, ``cancelled`` and ``expired`` are terminal and immutable.
* ``target_missing`` is recoverable: once the owning tab sees the SAME step's
  target again (the human came back to its page), it reports ``target_found``
  and the guide returns to ``active`` on that step, without advancing. When the
  page came back at an EARLIER step of the same action instead (a form that
  remounted starts over), the report names that ``resume_step_index`` and the
  guide moves back to it; never forward, and never while a save is pending. A
  ``target_found`` on an already active guide changes nothing; on a terminal
  one it is refused like any other write.
* Every mutation bumps ``revision``; a browser update names the revision it read,
  so a stale or foreign tab's write is refused rather than applied.
* One tab owns an active guide, on a lease renewed by heartbeat. A lapsed lease
  returns the guide to ``offered``; another tab takes it over only by an explicit
  claim (``take_over`` is an explicit human action in the UI).
* A ``ui`` step advances on the owning tab's report. A ``commit`` step advances
  ONLY through :meth:`GuideStore.begin_commit` / :meth:`GuideStore.finish_commit`,
  called by the real owner-only mutation route after IT succeeded, with the
  identity that route returned. A cancel or expiry between the two retires the
  association, so a save finishing late cannot revive a guide.

All methods are synchronous and called on the event loop, so no mutation can
interleave with another. Nothing here is persisted: a gateway restart drops every
guide, which is the conservative failure for a UI hint.

A guide that ended is kept for the same windows a change card's result is: the
newest one per slot is served by ``pending`` for ``TERMINAL_SHOWN_SECONDS`` (so a
page reload still shows its result line in that chat) until the owner dismisses
it, and it is pruned after ``TERMINAL_RETAIN_SECONDS``. ``MAX_STORED_GUIDES``
bounds the whole store either way.
"""

from __future__ import annotations

import copy
import secrets
import time
from collections import OrderedDict
from dataclasses import dataclass, field
from typing import Any, Callable

from kiro_crew import guide_catalog as catalog

GUIDE_TTL_SECONDS = 30 * 60
TAB_LEASE_SECONDS = 45
#: How long a terminal guide is kept at all (``guide_status`` reads it), as a
#: finished change card is (``change_cards.FINISHED_RETAIN_SECONDS``).
TERMINAL_RETAIN_SECONDS = 7 * 24 * 60 * 60
#: How long ``pending`` still serves a slot's newest ended guide, for its chat's
#: result line, as a finished change card is (``change_cards.CARD_TTL_SECONDS``).
TERMINAL_SHOWN_SECONDS = 24 * 60 * 60
#: Ceiling on live (non-terminal) guides across every caller.
MAX_LIVE_GUIDES = 64
#: Ceiling on stored guides of any status.
MAX_STORED_GUIDES = 256

STATUS_OFFERED = "offered"
STATUS_ACTIVE = "active"
STATUS_TARGET_MISSING = "target_missing"
STATUS_COMPLETED = "completed"
STATUS_CANCELLED = "cancelled"
STATUS_EXPIRED = "expired"

TERMINAL_STATUSES = frozenset({STATUS_COMPLETED, STATUS_CANCELLED, STATUS_EXPIRED})
LIVE_STATUSES = frozenset({STATUS_OFFERED, STATUS_ACTIVE, STATUS_TARGET_MISSING})

OUTCOME_OBSERVED = "observed"
OUTCOME_TARGET_MISSING = "target_missing"
OUTCOME_TARGET_FOUND = "target_found"
_OUTCOMES = (OUTCOME_OBSERVED, OUTCOME_TARGET_MISSING, OUTCOME_TARGET_FOUND)

REASON_CANCELLED_BY_USER = "cancelled_by_user"
REASON_SAVED_WITHOUT_GUIDE = "saved_without_guide"
#: The reasons a browser may give when it ends a guide.
TAB_CANCEL_REASONS = frozenset({REASON_CANCELLED_BY_USER, REASON_SAVED_WITHOUT_GUIDE})

_TAB_ID_MAX = 128
_GUIDE_ID_MAX = 64


class GuideError(Exception):
    """A refused guide operation, carrying its HTTP status and stable code."""

    def __init__(self, status: int, code: str, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message


@dataclass
class _Guide:
    guide_id: str
    slot_key: str
    session_key: str
    actions: list[dict[str, Any]]
    created_at: float
    expires_at: float
    status: str = STATUS_OFFERED
    revision: int = 1
    owner_tab: str | None = None
    lease_expires_at: float | None = None
    action_index: int = 0
    step_index: int = 0
    reason: str = ""
    finished_at: float | None = None
    pending_commit: str | None = None
    pending_kind: str = ""
    dismissed: bool = False
    extra: dict[str, Any] = field(default_factory=dict)

    def to_public(self) -> dict[str, Any]:
        return {
            "guide_id": self.guide_id,
            "slot_key": self.slot_key,
            "status": self.status,
            "revision": self.revision,
            "owner_tab": self.owner_tab,
            "action_index": self.action_index,
            "step_index": self.step_index,
            "actions": copy.deepcopy(self.actions),
            "reason": self.reason,
            "expires_at": self.expires_at,
            "lease_expires_at": self.lease_expires_at,
            "finished_at": self.finished_at,
            "dismissed": self.dismissed,
        }


def _clean_tab(tab_id: object) -> str:
    if not isinstance(tab_id, str) or not tab_id or len(tab_id) > _TAB_ID_MAX:
        raise GuideError(400, "invalid_tab_id", "tab_id is required")
    if any(ord(ch) < 0x21 or ch == "\x7f" for ch in tab_id):
        raise GuideError(400, "invalid_tab_id", "tab_id has invalid characters")
    return tab_id


def _clean_revision(revision: object) -> int:
    if isinstance(revision, bool) or not isinstance(revision, int) or revision < 1:
        raise GuideError(400, "invalid_revision", "revision must be a positive integer")
    return revision


def _clean_index(value: object, name: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise GuideError(400, f"invalid_{name}", f"{name} must be a non-negative integer")
    return value


class GuideStore:
    """Every guide this gateway holds, bounded and in memory."""

    def __init__(self, clock: Callable[[], float] = time.time) -> None:
        self._clock = clock
        self._guides: OrderedDict[str, _Guide] = OrderedDict()
        # Commit token -> guide id, for the in-flight mutation association.
        self._commits: dict[str, str] = {}

    # ── housekeeping ──

    def _touch(self, g: _Guide, *, reason: str | None = None) -> None:
        g.revision += 1
        if reason is not None:
            g.reason = reason

    def _finish(self, g: _Guide, status: str, reason: str) -> None:
        g.status = status
        g.reason = reason
        g.finished_at = self._clock()
        g.owner_tab = None
        g.lease_expires_at = None
        self._drop_commit(g)
        self._touch(g)

    def _drop_commit(self, g: _Guide) -> None:
        if g.pending_commit is not None:
            self._commits.pop(g.pending_commit, None)
        g.pending_commit = None
        g.pending_kind = ""

    def _refresh(self, g: _Guide) -> bool:
        """Apply TTL and lease lapse to *g*. Returns True when it changed."""
        if g.status in TERMINAL_STATUSES:
            return False
        now = self._clock()
        if now >= g.expires_at:
            self._finish(g, STATUS_EXPIRED, "expired")
            return True
        if g.owner_tab is not None and g.lease_expires_at is not None and now >= g.lease_expires_at:
            # The owning tab went quiet. Release it so another tab (or the same one
            # after a reload) can claim; the revision bump makes the lapsed tab's
            # next write stale. An in-flight commit stays associated: the save it
            # belongs to was submitted under a valid lease.
            g.owner_tab = None
            g.lease_expires_at = None
            if g.status == STATUS_ACTIVE:
                g.status = STATUS_OFFERED
            self._touch(g, reason="lease_lapsed")
            return True
        return False

    def sweep(self) -> list[dict[str, Any]]:
        """Refresh every guide and prune old terminal ones. Returns changed guides."""
        changed = []
        now = self._clock()
        for g in list(self._guides.values()):
            if self._refresh(g):
                changed.append(g.to_public())
        for gid, g in list(self._guides.items()):
            if (
                g.status in TERMINAL_STATUSES
                and g.finished_at is not None
                and now - g.finished_at >= TERMINAL_RETAIN_SECONDS
            ):
                del self._guides[gid]
        while len(self._guides) > MAX_STORED_GUIDES:
            victim = next(
                (gid for gid, g in self._guides.items() if g.status in TERMINAL_STATUSES), None
            )
            if victim is None:
                break
            del self._guides[victim]
        return changed

    def _get(self, guide_id: object) -> _Guide:
        if not isinstance(guide_id, str) or not guide_id or len(guide_id) > _GUIDE_ID_MAX:
            raise GuideError(400, "invalid_guide_id", "guide_id is required")
        g = self._guides.get(guide_id)
        if g is None:
            raise GuideError(404, "guide_not_found", "no such guide")
        self._refresh(g)
        return g

    # ── agent side (caller already verified; slot derived from its session) ──

    def start(self, *, slot_key: str, session_key: str, actions: object) -> dict[str, Any]:
        self.sweep()
        if any(g.slot_key == slot_key and g.status in LIVE_STATUSES for g in self._guides.values()):
            raise GuideError(
                409,
                "guide_active",
                "this session already has a guide in progress; cancel it first",
            )
        if sum(1 for g in self._guides.values() if g.status in LIVE_STATUSES) >= MAX_LIVE_GUIDES:
            raise GuideError(429, "too_many_guides", "too many guides are in progress")
        try:
            records = catalog.validate_actions(actions)
        except catalog.GuideCatalogError as exc:
            raise GuideError(400, exc.code, exc.message) from None
        now = self._clock()
        g = _Guide(
            guide_id=f"g_{secrets.token_urlsafe(12)}",
            slot_key=slot_key,
            session_key=session_key,
            actions=records,
            created_at=now,
            expires_at=now + GUIDE_TTL_SECONDS,
        )
        self._guides[g.guide_id] = g
        return g.to_public()

    def _owned_by_caller(self, guide_id: object, slot_key: str) -> _Guide:
        g = self._get(guide_id)
        if g.slot_key != slot_key:
            # Indistinguishable from absence: a caller learns nothing about
            # another session's guides.
            raise GuideError(404, "guide_not_found", "no such guide")
        return g

    def status_for_caller(self, *, slot_key: str, guide_id: object = None) -> dict[str, Any]:
        self.sweep()
        if guide_id not in (None, ""):
            return self._owned_by_caller(guide_id, slot_key).to_public()
        mine = [g for g in self._guides.values() if g.slot_key == slot_key]
        if not mine:
            raise GuideError(404, "guide_not_found", "this session has no guide")
        live = [g for g in mine if g.status in LIVE_STATUSES]
        return (live or mine)[-1].to_public()

    def cancel_by_caller(self, *, slot_key: str, guide_id: object) -> dict[str, Any]:
        g = self._owned_by_caller(guide_id, slot_key)
        if g.status in TERMINAL_STATUSES:
            raise GuideError(409, "guide_finished", f"guide is already {g.status}")
        self._finish(g, STATUS_CANCELLED, "cancelled_by_agent")
        return g.to_public()

    # ── browser side (owner cookie already verified) ──

    def retire_closed_slots(self, has_slot: Callable[[str], bool]) -> list[dict[str, Any]]:
        """Retire hints whose originating conversation was closed."""
        retired = []
        for guide in self._guides.values():
            if guide.status in LIVE_STATUSES and not has_slot(guide.slot_key):
                self._finish(guide, STATUS_CANCELLED, "slot_closed")
                retired.append(guide.to_public())
        return retired

    def pending(self, slot_key: str | None = None) -> list[dict[str, Any]]:
        """Live guides, plus each slot's newest recently ended, undismissed one.

        The ended one is what that slot's chat shows as a result line, so a page
        reload keeps it; one per slot keeps the answer bounded by the slot count.
        """
        self.sweep()
        now = self._clock()
        newest_ended: dict[str, _Guide] = {}
        for g in self._guides.values():
            if g.status in TERMINAL_STATUSES and g.finished_at is not None:
                held = newest_ended.get(g.slot_key)
                if held is None or (held.finished_at or 0.0) <= g.finished_at:
                    newest_ended[g.slot_key] = g
        live_slots = {g.slot_key for g in self._guides.values() if g.status in LIVE_STATUSES}
        shown = {
            g.guide_id
            for g in newest_ended.values()
            # A newer guide in progress supersedes the line, and a closed
            # conversation has no chat left to show one in.
            if g.slot_key not in live_slots
            and not g.dismissed
            and g.reason != "slot_closed"
            and now - (g.finished_at or 0.0) < TERMINAL_SHOWN_SECONDS
        }
        return [
            g.to_public()
            for g in self._guides.values()
            if (g.status in LIVE_STATUSES or g.guide_id in shown)
            and (not slot_key or g.slot_key == slot_key)
        ]

    def dismiss(self, *, guide_id: object) -> dict[str, Any]:
        """Hide an ended guide's result line. A live guide is cancelled, not dismissed."""
        g = self._get(guide_id)
        if g.status not in TERMINAL_STATUSES:
            raise GuideError(409, "guide_live", "a guide in progress is cancelled, not dismissed")
        if not g.dismissed:
            g.dismissed = True
            self._touch(g)
        return g.to_public()

    def replay(self, *, guide_id: object, revision: object) -> dict[str, Any]:
        """Offer a completed show-me guide again, from its first step.

        Only a guide whose every step is a UI step: replaying one that saved a
        change would walk the user into making it twice.
        """
        self.sweep()
        g = self._get(guide_id)
        self._check_revision(g, revision)
        if g.status != STATUS_COMPLETED:
            raise GuideError(409, "guide_not_completed", "only a finished guide can be shown again")
        if any(catalog.commit_step_index(a["id"]) is not None for a in g.actions):
            raise GuideError(409, "guide_not_replayable", "this guide made a change; ask again")
        if any(
            o.slot_key == g.slot_key and o.status in LIVE_STATUSES for o in self._guides.values()
        ):
            raise GuideError(
                409, "guide_active", "this session already has a guide in progress; cancel it first"
            )
        now = self._clock()
        g.status = STATUS_OFFERED
        g.action_index = 0
        g.step_index = 0
        g.finished_at = None
        g.dismissed = False
        g.expires_at = now + GUIDE_TTL_SECONDS
        self._touch(g, reason="")
        return g.to_public()

    def _check_revision(self, g: _Guide, revision: object) -> None:
        rev = _clean_revision(revision)
        if rev != g.revision:
            raise GuideError(409, "stale_revision", "the guide changed; reload it")

    def _require_live(self, g: _Guide) -> None:
        if g.status in TERMINAL_STATUSES:
            raise GuideError(409, "guide_finished", f"guide is already {g.status}")

    def _require_owner_tab(self, g: _Guide, tab: str) -> None:
        if g.owner_tab != tab:
            raise GuideError(409, "not_owner_tab", "another tab owns this guide")

    def claim(
        self, *, guide_id: object, tab_id: object, revision: object, take_over: object = False
    ) -> dict[str, Any]:
        g = self._get(guide_id)
        tab = _clean_tab(tab_id)
        self._require_live(g)
        self._check_revision(g, revision)
        if take_over is not True and take_over is not False:
            raise GuideError(400, "invalid_take_over", "take_over must be a boolean")
        if g.owner_tab is not None and g.owner_tab != tab and not take_over:
            raise GuideError(409, "owned_elsewhere", "another tab is showing this guide")
        g.owner_tab = tab
        g.lease_expires_at = self._clock() + TAB_LEASE_SECONDS
        if g.status == STATUS_OFFERED:
            g.status = STATUS_ACTIVE
        self._touch(g, reason="")
        return g.to_public()

    def heartbeat(self, *, guide_id: object, tab_id: object, revision: object) -> dict[str, Any]:
        g = self._get(guide_id)
        tab = _clean_tab(tab_id)
        self._require_live(g)
        self._check_revision(g, revision)
        self._require_owner_tab(g, tab)
        # A lease renewal only; no revision bump, so it never makes the owner's own
        # in-flight progress report stale.
        g.lease_expires_at = self._clock() + TAB_LEASE_SECONDS
        return g.to_public()

    def progress(
        self,
        *,
        guide_id: object,
        tab_id: object,
        revision: object,
        action_index: object,
        step_index: object,
        outcome: object,
        resume_step_index: object = None,
    ) -> dict[str, Any]:
        g = self._get(guide_id)
        tab = _clean_tab(tab_id)
        self._require_live(g)
        self._check_revision(g, revision)
        self._require_owner_tab(g, tab)
        ai = _clean_index(action_index, "action_index")
        si = _clean_index(step_index, "step_index")
        if (ai, si) != (g.action_index, g.step_index):
            raise GuideError(409, "wrong_step", "that is not the guide's current step")
        if outcome not in _OUTCOMES:
            raise GuideError(
                400, "invalid_outcome", "outcome must be observed, target_missing or target_found"
            )
        action_id = g.actions[ai]["id"]
        if outcome == OUTCOME_TARGET_FOUND:
            # Recovery, not progress: the same step is shown again, so nothing is
            # completed and any step kind may recover. Only a missing guide moves;
            # an active one is answered as it is, with no revision bump, so a
            # repeated report never makes the owner's next write stale.
            if g.status == STATUS_TARGET_MISSING:
                if resume_step_index is not None:
                    # The page came back at an EARLIER step of this action (a
                    # remounted form starts over): the guide follows the page
                    # back, never forward and never across a pending save.
                    rs = _clean_index(resume_step_index, "resume_step_index")
                    if rs > si or g.pending_commit is not None:
                        raise GuideError(
                            409, "invalid_resume_step", "the guide cannot resume at that step"
                        )
                    g.step_index = rs
                g.status = STATUS_ACTIVE
                self._touch(g, reason="target_found")
            return g.to_public()
        if outcome == OUTCOME_TARGET_MISSING:
            g.status = STATUS_TARGET_MISSING
            self._touch(g, reason="target_missing")
            return g.to_public()
        if catalog.step_kind(action_id, si) != catalog.STEP_UI:
            # The mutation step is proven by the gateway's own route, never by the
            # browser saying so.
            raise GuideError(
                409,
                "commit_step_requires_server_evidence",
                "this step completes only when the change is actually saved",
            )
        g.status = STATUS_ACTIVE
        self._advance(g)
        return g.to_public()

    def cancel_by_tab(
        self, *, guide_id: object, tab_id: object, revision: object, reason: object = None
    ) -> dict[str, Any]:
        """End the guide. ``reason`` is one of :data:`TAB_CANCEL_REASONS`.

        ``saved_without_guide``: the action's own save went through without the
        guide's association (the tab had not caught up), so the guide has no
        evidence to complete on and ends saying the change was made outside it.
        """
        g = self._get(guide_id)
        tab = _clean_tab(tab_id)
        self._require_live(g)
        self._check_revision(g, revision)
        if g.owner_tab is not None:
            self._require_owner_tab(g, tab)
        if reason is None:
            reason = REASON_CANCELLED_BY_USER
        if not isinstance(reason, str) or reason not in TAB_CANCEL_REASONS:
            raise GuideError(400, "invalid_reason", "unknown cancel reason")
        self._finish(g, STATUS_CANCELLED, str(reason))
        return g.to_public()

    def _advance(self, g: _Guide) -> None:
        count = int(g.actions[g.action_index]["step_count"])
        if g.step_index + 1 < count:
            g.step_index += 1
            self._touch(g, reason="")
            return
        if g.action_index + 1 < len(g.actions):
            g.action_index += 1
            g.step_index = 0
            self._touch(g, reason="")
            return
        self._finish(g, STATUS_COMPLETED, "completed")

    # ── mutation association (called only by the owner-only mutation routes) ──

    def begin_commit(
        self, *, guide_id: object, tab_id: object, revision: object, kind: str
    ) -> str | None:
        """Associate one in-flight owner request with the guide's commit step.

        Returns an opaque token, or ``None`` when the headers do not name a guide
        currently waiting on exactly this kind of commit from exactly this tab at
        exactly this revision. ``None`` never blocks the mutation itself: the
        human's save always proceeds; it just does not count for the guide.
        """
        try:
            g = self._get(guide_id)
            tab = _clean_tab(tab_id)
            self._check_revision(g, _coerce_header_int(revision))
        except GuideError:
            return None
        if g.status not in (STATUS_ACTIVE, STATUS_TARGET_MISSING) or g.owner_tab != tab:
            return None
        if g.pending_commit is not None:
            return None
        action_id = g.actions[g.action_index]["id"]
        if action_id != kind or catalog.commit_step_index(action_id) != g.step_index:
            return None
        token = secrets.token_urlsafe(16)
        g.pending_commit = token
        g.pending_kind = kind
        self._commits[token] = g.guide_id
        return token

    def abort_commit(self, token: str | None) -> None:
        if not token:
            return
        gid = self._commits.pop(token, None)
        g = self._guides.get(gid) if gid else None
        if g is not None and g.pending_commit == token:
            g.pending_commit = None
            g.pending_kind = ""

    def finish_commit(self, token: str | None, evidence: dict[str, Any]) -> dict[str, Any] | None:
        """Record the mutation route's own result and advance. ``None`` if retired.

        Revalidates everything: the guide still exists, is not terminal (a cancel
        or expiry in the meantime wins), still holds THIS token, and is still on
        the commit step of the action the token was issued for.
        """
        if not token:
            return None
        gid = self._commits.pop(token, None)
        g = self._guides.get(gid) if gid else None
        if g is None:
            return None
        self._refresh(g)
        if g.pending_commit != token or g.status in TERMINAL_STATUSES:
            return None
        kind = g.pending_kind
        g.pending_commit = None
        g.pending_kind = ""
        action = g.actions[g.action_index]
        if action["id"] != kind or catalog.commit_step_index(kind) != g.step_index:
            return None
        action["result"] = dict(evidence)
        g.status = STATUS_ACTIVE
        self._advance(g)
        return g.to_public()


def _coerce_header_int(value: object) -> object:
    """A header revision arrives as text; anything but plain digits stays invalid."""
    if isinstance(value, str) and value.isdigit() and len(value) <= 12:
        return int(value)
    return value


def guide_store_for(state: Any) -> GuideStore:
    """The one store attached to this gateway's dashboard state."""
    store = getattr(state, "_guide_store", None)
    if not isinstance(store, GuideStore):
        store = GuideStore()
        state._guide_store = store
    return store
