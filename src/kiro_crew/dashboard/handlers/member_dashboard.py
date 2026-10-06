"""HTTP for one crewmate's dynamic dashboard: the instance, the registry, share, snapshots.

``GET /api/members/{slug}/dashboard`` is the one route the Dashboard tab's frame reads,
and its body is the shape CONTRACT-v3 fixes between the two:
``{instance_version, template: {id, version}, html, manifest, state}``.

**``?member=`` is required**, exactly as the briefing and rules reads require it, and
for the reason those give: slugification is lossy, so two crew names can reach one slug.
A dashboard instance is ONE directory per slug, so for a colliding slug the instance
belongs to neither crewmate. The exact name must derive this
slug, exist in config, and be the only name that derives it.

**The read is owner-gated.** The fields this body carries are work-ledger and crew-log
data, and ``work_ledger_board`` answers a non-owner ``owner_only`` for the same values,
so arriving as rendered html does not make them a wider audience's.

**App tokens are denied outright.** An app token scoped to ``/api/members`` reaches
this by PREFIX, and a crewmate's dashboard is inside exactly what that isolation
withholds.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any, Callable, Mapping

from aiohttp import web

from kiro_crew import members as members_mod
from kiro_crew.config.loader import KiroCrewConfig
from kiro_crew.dashboard.handlers._shared import require_owner_dashboard_request
from kiro_crew.dashboard.handlers.members import (
    _deny_app_caller,
    _member_names_for_slug,
    _member_thread_slot,
)
from kiro_crew.dashboard_templates import catalog, instance
from kiro_crew.members import MemberSlugError
from kiro_crew.platform.context import redact_via_context

logger = logging.getLogger(__name__)

__all__ = ["register_member_dashboard_routes"]


def _bad(code: str, message: str, status: int = 400) -> web.Response:
    """One refusal shape for the whole module: a code a client branches on, and a sentence.

    Both halves, always. A client cannot branch on prose, and a person cannot act on a
    code -- a surface given only one of the two either hard-codes English or shows the
    user ``instance_refused``.
    """
    return web.json_response({"error": message, "code": code}, status=status)


async def _resolve(request: web.Request) -> tuple[str, str] | web.Response:
    """``(slug, member)`` for this request, or the refusal to return instead.

    The four questions the sibling member routes ask, in their order: is the slug a
    slug, is the member name one that can reach a model, does that name derive THIS
    slug and exist, and is it the only name that does.
    """
    denied = await _deny_app_caller(request, "members.dashboard")
    if denied is not None:
        return denied
    slug = request.match_info.get("slug", "")
    try:
        members_mod.validate_slug(slug)
    except MemberSlugError:
        return _bad("invalid_member_slug", "invalid member slug")
    member = request.query.get("member", "")
    if not members_mod.is_dispatchable_member_name(member):
        return _bad("missing_member", "member query parameter required")
    cfg = await asyncio.to_thread(KiroCrewConfig.load)
    try:
        if members_mod.member_slug(member, cfg) != slug:
            return _bad("member_slug_mismatch", "member does not match slug")
    except MemberSlugError:
        return _bad("member_slug_mismatch", "member does not match slug")
    if member not in cfg.agents:
        return _bad("member_not_found", "no crew member for this slug", status=404)
    if _member_names_for_slug(cfg, slug) != [member]:
        return _bad(
            "dashboard_slug_ambiguous",
            "multiple crews share this slug; their dashboards would be ambiguous",
            status=409,
        )
    return slug, member


def _dashboard_slot(member: str, slug: str) -> str:
    """The DM slot this crewmate's dashboard reads its fold values from.

    A V2 member's DM log lives on ``member_slot_key(slug, store)``, so the bare
    ``member_slot_key(slug)`` names a different, empty slot: the dashboard then reads no
    values and renders every field unresolved while the crewmate's thread is right there.
    :func:`_member_thread_slot` is the same derivation ``api_member_thread`` uses to
    CREATE the thread, so it names the slot the session actually runs under.

    Falls back to the V1 key when the store resolution refuses (``UnknownMemoryStore``) --
    an unknown member, or a V2 record that is missing or degraded. A degraded store record
    must read as "no values yet" rather than as a dashboard that cannot be served at all.
    """
    try:
        cfg = KiroCrewConfig.load()
        slot, _store = _member_thread_slot(cfg, member, slug)
    except Exception:
        logger.debug("dashboard: falling back to the V1 slot for %r", slug, exc_info=True)
        return members_mod.member_slot_key(slug)
    return slot


def _write_session(slug: str, member: str) -> str:
    """The session a dashboard change's history entry belongs to: the crewmate's DM log.

    Derived, not looked up, and empty when there is none. The instance record is a file
    and is already committed by the time this is used, so a crewmate whose DM thread has
    never run gets a working dashboard with no history row rather than a refused change.

    Resolved by the slot the member's DM thread runs under, then by the newest session
    unit on it: a slot owns one session id at a time, and the newest is the live one.
    """
    try:
        from kiro_crew.crew_log.store import session_units_for_slot

        slot = _dashboard_slot(member, slug)
        units = session_units_for_slot(slot)
        return units[-1] if units else ""
    except Exception:
        logger.debug("dashboard: no DM session for %r", member, exc_info=True)
        return ""


async def _owner_only(request: web.Request, operation: str) -> web.Response | None:
    return await require_owner_dashboard_request(request, operation)


async def _run(fn: Callable[[], Any]) -> Any:
    """Run a store call off the event loop. Every call here is file IO."""
    return await asyncio.to_thread(fn)


def _refusal(exc: Exception) -> web.Response:
    """Turn a store refusal into an answer. Separate codes, because they differ for a client.

    ``*_refused`` is the caller's input and a retry of the same request will be refused
    again; ``*_failed`` is this gateway's state and a retry may work. Collapsing them
    would make a client either retry forever or give up on a transient fault.
    """
    if isinstance(exc, instance.InstanceRefused):
        return _bad("dashboard_refused", str(exc), status=409)
    if isinstance(exc, catalog.UnknownTemplate):
        return _bad("template_not_found", str(exc), status=404)
    logger.warning("dashboard store call failed", exc_info=exc)
    return _bad("dashboard_failed", "the dashboard store could not serve this", status=500)


# --------------------------------------------------------------------------
# the instance
# --------------------------------------------------------------------------


async def api_member_dashboard(request: web.Request) -> web.Response:
    """GET /api/members/{slug}/dashboard?member=<name> — the crewmate's own dashboard.

    The body is CONTRACT-v3's fixed shape. ``state`` is one of ``empty``, ``live``,
    ``stale`` and ``error``, DERIVED at read time rather than stored: a stored flag
    would be a claim about the registry made when the instance was last written, and a
    template shipping a new version makes every copy of it stale without touching one
    instance file.

    A crewmate that never adopted a template answers 200 with ``state: "empty"``, never
    404: having no dashboard yet is the ordinary first state of every crewmate, and the
    frame's empty state IS that answer. A 404 here would make "nothing adopted" and "no
    such member" one reading for the tab.

    For that case the body also carries the DEFAULT template, rendered. An empty frame
    answers none of the questions a person opened the tab with, so what they see is the
    default page; ``state`` stays ``empty`` and ``instance_version`` stays 0, because
    nothing was adopted and nothing was written -- the snapshot route still refuses on
    that state, and the frame draws whatever ``rendered_html`` carries. ``template``
    names the default rather than staying blank, so a reader of this body can tell which
    page the html belongs to.

    OWNER-ONLY. The fields this body carries are work-ledger and crew-log data, and
    ``work_ledger_board`` answers a non-owner ``owner_only`` for the same values, so
    arriving as rendered html does not make them a wider audience's.
    """
    resolved = await _resolve(request)
    if isinstance(resolved, web.Response):
        return resolved
    # OWNER-ONLY, like every other route that serves this crewmate's fold values.
    # The page's fields ARE work-ledger and crew-log data -- task titles, summaries,
    # PR links -- and `work_ledger_board` answers the same caller `owner_only` for
    # exactly those. Serving them here because they arrive as rendered html rather
    # than as JSON would make the gate a property of the response format.
    #
    # Refused rather than rendered with an empty read: an empty read has no resolved
    # fold, which IS the stale condition, so the page would tell a non-owner its
    # numbers are older than the record when the truth is that they were withheld.
    owner_denied = await _owner_only(request, "members.dashboard")
    if owner_denied is not None:
        return owner_denied
    slug, _member = resolved
    try:
        record = await _run(lambda: instance.read(slug))
    except Exception as exc:
        return _refusal(exc)
    if record.state == instance.STATE_EMPTY:
        fallback = await _run(lambda: instance.default_instance(slug))
        if fallback is not None:
            record = fallback
    body = record.wire()
    # STALE belongs here with LIVE and EMPTY: `_state_of` calls a stale copy complete
    # and still renderable -- what it cannot do is be compared against or refreshed
    # from its source, which is what the frame's stale band says. A copy served
    # without composing carries no data island, no bootstrap, no band and no ready
    # beacon, so it shows no values at all. Only ERROR is excluded, because that is
    # the one state in which the copy does not parse.
    if record.state in (instance.STATE_LIVE, instance.STATE_EMPTY, instance.STATE_STALE):
        rendered = await _run(lambda: _render(slug, _member, record))
        if rendered is not None:
            body["rendered_html"] = rendered
    return web.json_response(body)


#: Any key whose VALUE is a worker's session key, dropped from a value on its way to a
#: page. Named for the whole repository's rule rather than for one fold: the conductor
#: ledger's is that no reader but the conductor sees a session key, and
#: ``work_ledger_board._MASKED_ITEM_FIELDS`` masks exactly this on the Crew page.
_MASKED_VALUE_KEYS = frozenset({"worker_session_key"})

#: Event kinds whose ``text`` IS a session key, so masking the item field alone leaves
#: the key on the page inside the event log. The line is kept for its ``kind`` and
#: ``ts``, which a timeline needs and which the key is not required to express.
_KEY_BEARING_EVENT_KINDS = frozenset({"bind"})


def _page_safe(value: Any) -> Any:
    """*value* made safe to put on a page: session keys removed, strings redacted.

    ONE traversal doing both, because both are the same question asked of the same
    bytes -- what must not reach a browser -- and two passes are two places for the
    rule to drift.

    Every string here is AGENT-AUTHORED and nothing between the write and this read
    inspects it. A fold value is whatever a conductor put in the crew log: a
    `session_ledger_record(goal=...)` carrying a pasted private key is rendered by any
    template that binds that fold. Dropping the one field known to be a secret says
    nothing about prose that happens to contain one.

    A mapping's KEYS are agent-authored on the same terms as its values -- an artifact
    name is a free string -- so keys are redacted too, and a key that redacts onto one
    already present is suffixed rather than dropped, so two distinct rows do not
    collapse into one.

    `redact_via_context` rather than a named pair of redactors: it is the canonical
    egress shim, so a host with a loaded companion applies that companion's patterns
    too, and it is fail-closed on a composition error. `work_ledger_board._redact_deep`
    applies the same rule to the same data for the Crew page; this is that rule at the
    dashboard's own chokepoint.

    RECURSIVE and shape-agnostic on purpose. This page is served by
    ``GET /api/members/{slug}/dashboard``, which has no owner check, and a template
    declares its own fold paths -- so which fold reaches a page, and how deep the key
    sits in it, is a decision the TEMPLATE makes. A mask written against one fold's
    item shape covers the template that exists today and not the one adopted tomorrow,
    which is how the same key reached a page twice already: once on a task row and
    once on a board id.

    Applied to the resolved values rather than inside a fold, because the fold is also
    read by the conductor itself, which is the one reader allowed to see the key.
    """
    if isinstance(value, str):
        return redact_via_context(value)
    if isinstance(value, Mapping):
        out: dict[Any, Any] = {}
        kind = value.get("kind")
        for key, item in value.items():
            if key in _MASKED_VALUE_KEYS:
                continue
            if key == "text" and isinstance(kind, str) and kind in _KEY_BEARING_EVENT_KINDS:
                out[key] = ""
                continue
            safe_key = redact_via_context(key) if isinstance(key, str) else key
            if safe_key in out:
                suffix = 2
                while f"{safe_key} ({suffix})" in out:
                    suffix += 1
                safe_key = f"{safe_key} ({suffix})"
            out[safe_key] = _page_safe(item)
        return out
    if isinstance(value, (list, tuple)):
        return [_page_safe(item) for item in value]
    return value


def _render(slug: str, member: str, record: Any) -> str | None:
    """The live page with its values filled in: the frame's half of contract v3 part 5.

    Fold values come through :class:`~kiro_crew.dashboard_feed.DashboardFeed`, which
    subscribes with a baseline -- the bus hands the CURRENT fold value through the
    projection read path, so nothing refolds a log here. Agentic values come from the
    slot's ``agentic`` fold. The result is :func:`dashboard_frame.compose_body`, the one
    builder that also composes a refill, so the page's ``window.kirocrew`` is the same
    shape on first paint and after.

    DEMO SCOPE: the feed is opened and closed per request. The contract wants one
    long-lived feed per open dashboard pushing refills over the WS exporter; until
    that lands, a re-read (focus, the tab's own refetch) is how the page moves.
    ``None`` on any failure, so the raw page still renders under the frame's own
    stale band rather than the tab erroring.
    """
    try:
        from kiro_crew import dashboard_frame
        from kiro_crew.crew_log import projection
        from kiro_crew.dashboard_feed import DashboardFeed
        from kiro_crew.dashboard_templates.manifest import parse_manifest

        manifest = parse_manifest(dict(record.manifest))
        if manifest.source not in instance.RENDERABLE_SOURCES:
            # Already refused at adopt. Checked again on the way OUT because this is the
            # step that hands fold values to a page's own script, and a record written
            # before that refusal existed -- or edited on disk by hand -- reaches here
            # without passing it. The tab shows its unavailable state, which is the
            # truthful rendering of a page this gateway will not run.
            logger.warning("dashboard: refusing to render %r's %r template", slug, manifest.source)
            return None
        slot = _dashboard_slot(member, slug)
        feed = DashboardFeed(slot, _write_session(slug, member))
        try:
            feed.subscribe(manifest)
            agentic: Any = {}
            if any(spec.agentic for spec in manifest.fields.values()):
                agentic = projection.read_slot_projection(slot, "agentic").value
            read = feed.read(manifest, agentic if isinstance(agentic, dict) else {})
        finally:
            feed.unsubscribe()
        payload = dashboard_frame.read_payload(
            # MASKED AND REDACTED on the way out, at the one step that hands fold
            # values to a page's own script. A snapshot is taken from what the page
            # holds, so it inherits this rather than needing its own pass.
            {name: _page_safe(value) for name, value in read.fields.items()},
            agentic=[name for name, spec in manifest.fields.items() if spec.agentic],
            seq=read.seq,
            stale=read.stale,
            missing=read.missing,
            # Masked like the values beside them: a stamp is not a secret, but this is
            # the one chokepoint and a field added here later would otherwise skip it.
            written_at={name: str(_page_safe(at)) for name, at in read.written_at.items()},
        )
        return dashboard_frame.compose_body(record.html, payload)
    except Exception:
        logger.warning("dashboard: could not fill %r's page", slug, exc_info=True)
        return None


def register_member_dashboard_routes(app: web.Application) -> None:
    """Register the dynamic dashboard's read route.

    One route, so there is no ordering question here yet. ``server.py`` duplicates the
    path through its deferred binder rather than calling this function, because calling
    it would import this module at boot and the boot-path rule forbids that for an
    optional subsystem; ``test_member_dashboard_routes`` pins the two spellings against
    each other.
    """
    app.router.add_get("/api/members/{slug}/dashboard", api_member_dashboard)
