"""HTTP routes and the route hook behind change cards (``card_*`` tools).

Two halves with deliberately different auth, like the guide surface:

* **Agent half** (``/api/cards/agent/*``) is MCP-only and strict-internal: the
  prefix sits in ``server._STRICT_INTERNAL_API_PATHS``, every handler re-asserts
  ``internal_auth``, and the caller's slot comes SOLELY from the verified
  ``X-Session-Key`` through the same checks the guide uses
  (:func:`kiro_crew.dashboard.handlers.guide._resolve_agent_caller`). An agent can
  propose and read; nothing here can apply.

* **Browser half** (``/api/cards/pending``, ``/api/cards/{id}/preview|cancel|dismiss``)
  is cookie-authed and OWNER-only. It edits and cancels proposals; it cannot apply
  either.

A card is applied only by the browser sending each plan step to the EXISTING
settings-page route with ``X-Card-Id`` / ``X-Card-Revision`` / ``X-Card-Op`` /
``X-Card-Step``. :func:`change_card_middleware` runs on exactly those routes
(``change_card_catalog.HOOKED_ROUTES``). With the headers it refuses anything but
the dashboard owner (an internal-secret caller, an app token or an agent is a 403
whatever it claims), requires the request to equal the plan step exactly, re-reads
the current state before the first write (``409 changed_since_preview``, or
``changed_since_apply`` for an undo), runs the real handler unchanged, and records
the step only from that handler's own 2xx response.

Every owner mutation through those routes -- with or without a card -- also
becomes one concise line in Global memory history (names only, never a secret,
token, env value or server spec), best-effort, never failing the request.

``card_update`` WebSocket frames go to owner sockets only.
"""

from __future__ import annotations

import asyncio
import json
import logging
import urllib.parse
from typing import Any, Awaitable, Callable

from aiohttp import web

from kiro_crew import change_card_catalog as catalog
from kiro_crew.dashboard import change_cards as cards
from kiro_crew.dashboard import chat_cards
from kiro_crew.dashboard.change_cards import CardError, CardStore, card_store_for
from kiro_crew.sel import sel

logger = logging.getLogger(__name__)

WS_CARD_UPDATE = "card_update"

HEADER_CARD_ID = "X-Card-Id"
HEADER_CARD_REVISION = "X-Card-Revision"
HEADER_CARD_OP = "X-Card-Op"
HEADER_CARD_STEP = "X-Card-Step"

_SLOT_QUERY_MAX = 256
_BODY_MAX = 1024 * 1024
_QUERY_MAX = 200
#: Routes whose memory line names the value before and after the change.
_VALUE_ROUTES = frozenset({("PATCH", "/api/config/kirocrew"), ("PUT", "/api/dashboard/config")})

#: Strong references to fire-and-forget memory writes, so none is collected mid-run.
_BACKGROUND: set[asyncio.Task[Any]] = set()


def _audit(caller: str, operation: str, outcome: str, error: str = "") -> None:
    try:
        sel().log_api_access(
            caller=caller or "unknown",
            operation=operation,
            outcome=outcome,
            source="dashboard",
            resources="/api/cards",
            error=error,
        )
    except Exception:  # pragma: no cover - an audit must never change the outcome
        logger.debug("SEL audit for %s failed", operation, exc_info=True)


def _refusal(exc: CardError | catalog.CardCatalogError) -> web.Response:
    if isinstance(exc, catalog.CardCatalogError):
        return web.json_response({"error": exc.message, "code": exc.code}, status=400)
    status = exc.status if exc.status in (400, 403, 404, 409, 429) else 400
    return web.json_response({"error": exc.message, "code": exc.code}, status=status)


def _store(request: web.Request) -> CardStore:
    return card_store_for(request.app["state"])


async def _broadcast(state: Any, card: dict[str, Any]) -> int:
    # Every public change of a card passes here, so this is where its row in the
    # conversation learns the new status (and the crew log the outcome).
    chat_cards.record_change_status(state, card)
    deliver = getattr(state, "deliver_ws_owners", None)
    if deliver is None:
        return 0
    try:
        return int(await deliver(WS_CARD_UPDATE, {"card": card}))
    except Exception:
        logger.debug("card_update delivery failed", exc_info=True)
        return 0


async def _settle(request: web.Request) -> None:
    """Expire / prune, broadcast what changed, and persist."""
    state = request.app["state"]
    store = _store(request)
    await store.warm()
    changed = store.retire_closed_slots(lambda key: state.get_slot(key) is not None)
    for card in changed + store.sweep():
        await _broadcast(state, card)
    await store.flush()


async def _json_body(request: web.Request) -> dict[str, Any]:
    try:
        body = await request.json()
    except Exception:
        raise CardError(400, "invalid_json", "invalid JSON body") from None
    if not isinstance(body, dict):
        raise CardError(400, "invalid_body", "body must be a JSON object")
    return body


async def _publish(request: web.Request, rec: dict[str, Any]) -> dict[str, Any]:
    store = _store(request)
    public = store.public(rec)
    await store.flush()
    await _broadcast(request.app["state"], public)
    return public


# ── agent half ──


def _resolve_agent_caller(request: web.Request, operation: str) -> tuple[str, str]:
    from kiro_crew.dashboard.guide_runs import GuideError
    from kiro_crew.dashboard.handlers.guide import _resolve_agent_caller as resolve

    try:
        return resolve(request, operation)
    except GuideError as exc:
        raise CardError(exc.status, exc.code, exc.message.replace("guide", "propose")) from None


async def api_cards_agent_kinds(request: web.Request) -> web.Response:
    """GET /api/cards/agent/kinds — the registered card catalog."""
    try:
        _resolve_agent_caller(request, "cards.kinds")
    except CardError as exc:
        return _refusal(exc)
    return web.json_response({"kinds": catalog.list_kinds()})


async def api_cards_agent_settings(request: web.Request) -> web.Response:
    """GET /api/cards/agent/settings?q= — up to ten Settings matches for a card.

    Each row says whether a ``setting.change`` card can write it and, when it
    can, its current value and the values it accepts. A credential-like setting
    never has its value echoed.
    """
    try:
        _resolve_agent_caller(request, "cards.find_setting")
    except CardError as exc:
        return _refusal(exc)
    query = (request.query.get("q") or "").strip()
    if not query or len(query) > _QUERY_MAX:
        return web.json_response(
            {"error": "q must be 1-200 characters", "code": "invalid_query"}, status=400
        )
    rows = await asyncio.to_thread(cards.find_settings, query)
    return web.json_response({"settings": rows})


async def api_cards_agent_capabilities(request: web.Request) -> web.Response:
    """GET /api/cards/agent/capabilities?member= — a member's capability rows for a card."""
    try:
        _resolve_agent_caller(request, "cards.member_capabilities")
    except CardError as exc:
        return _refusal(exc)
    member = (request.query.get("member") or "").strip()
    if not member or len(member) > _QUERY_MAX:
        return web.json_response(
            {"error": "member is required", "code": "invalid_member"}, status=400
        )
    try:
        view = await asyncio.to_thread(cards.member_capabilities_view, request.app, member)
    except catalog.CardCatalogError as exc:
        return _refusal(exc)
    return web.json_response(view)


async def api_cards_agent_diagnose(request: web.Request) -> web.Response:
    """GET /api/cards/agent/diagnose[?topic=] — symptom findings and non-default settings.

    ``findings`` are the read-only probes of :mod:`kiro_crew.diagnose_probes`, each
    ``{id, status, summary, evidence, fix?}``, run against this gateway's state.
    ``non_default`` lists every config and dashboard-config key whose value is not
    the shipped default, joined to its Settings entry when one maps to it; a
    credential-like key reports only whether it is set. ``recent_changes`` is the
    newest ``Dashboard: ...`` lines from Global memory history. Read-only.
    """
    try:
        _resolve_agent_caller(request, "cards.diagnose")
    except CardError as exc:
        return _refusal(exc)
    topic = (request.query.get("topic") or "").strip()
    if len(topic) > _QUERY_MAX:
        return web.json_response(
            {"error": "topic must be at most 200 characters", "code": "invalid_query"}, status=400
        )
    try:
        result = await asyncio.to_thread(cards.diagnose_settings, topic, request.app)
    except Exception:
        logger.warning("settings diagnosis failed", exc_info=True)
        return web.json_response(
            {"error": "settings could not be read", "code": "diagnose_failed"}, status=500
        )
    return web.json_response(result)


async def api_cards_agent_propose(request: web.Request) -> web.Response:
    """POST /api/cards/agent/propose — ``{kind, params, reason?}`` → Card.

    The card lands in the CALLER's own slot. ``delivered_clients`` 0 means no tab
    is showing it yet; it waits for ``GET /api/cards/pending``.
    """
    try:
        slot_key, sk = _resolve_agent_caller(request, "cards.propose")
        body = await _json_body(request)
        unknown = sorted(set(body) - {"kind", "params", "reason"})
        if unknown:
            raise CardError(400, "invalid_body", f"unknown field '{unknown[0][:64]}'")
        kind = body.get("kind")
        params = catalog.validate_params(str(kind or ""), body.get("params"))
        reason = cards.clean_reason(body.get("reason"))
        state = request.app["state"]
        preview, before, context = await cards.build(
            str(kind), params, state=state, app=request.app
        )
        await _settle(request)
        rec = _store(request).propose(
            slot_key=slot_key,
            session_key=sk,
            kind=str(kind),
            params=params,
            reason=reason,
            preview=preview,
            before=before,
            context=context,
        )
    except (CardError, catalog.CardCatalogError) as exc:
        return _refusal(exc)
    store = _store(request)
    public = store.public(rec)
    await store.flush()
    # The card is part of the conversation from here on: its row lands at this
    # point of the transcript, before the frame that makes it live.
    chat_cards.record_change_proposed(request.app["state"], public)
    delivered = await _broadcast(request.app["state"], public)
    _audit(sk, "cards.propose", "ok")
    return web.json_response({**public, "delivered_clients": delivered})


async def api_cards_agent_status(request: web.Request) -> web.Response:
    """GET /api/cards/agent/status[?card_id=] — the caller's own card."""
    try:
        slot_key, _sk = _resolve_agent_caller(request, "cards.status")
        await _settle(request)
        store = _store(request)
        rec = store.status_for_caller(slot_key, request.query.get("card_id") or None)
    except CardError as exc:
        return _refusal(exc)
    return web.json_response(store.public(rec))


# ── browser half ──


async def _require_owner(request: web.Request, operation: str) -> web.Response | None:
    from kiro_crew.dashboard.handlers._shared import require_owner_dashboard_request

    if request.get("internal_auth") is True:
        return web.json_response({"error": "owner only", "code": "owner_only"}, status=403)
    return await require_owner_dashboard_request(request, operation)


async def api_cards_pending(request: web.Request) -> web.Response:
    """GET /api/cards/pending[?slot=] — live cards plus those finished in the last 24h."""
    denied = await _require_owner(request, "cards.pending")
    if denied is not None:
        return denied
    slot = request.query.get("slot") or None
    if slot is not None and len(slot) > _SLOT_QUERY_MAX:
        return web.json_response({"error": "slot is too long", "code": "invalid_slot"}, status=400)
    await _settle(request)
    return web.json_response({"cards": _store(request).pending(slot)})


async def api_cards_preview(request: web.Request) -> web.Response:
    """POST /api/cards/{id}/preview — ``{params, revision}`` → Card at a new revision."""
    denied = await _require_owner(request, "cards.preview")
    if denied is not None:
        return denied
    await _store(request).warm()
    try:
        body = await _json_body(request)
        store = _store(request)
        rec = store.get(request.match_info["card_id"])
        params = catalog.validate_params(rec["kind"], body.get("params"))
        catalog.check_editable(rec["kind"], rec["params"], params)
        preview, before, context = await cards.build(
            rec["kind"], params, state=request.app["state"], app=request.app
        )
        store.revise(
            rec,
            revision=body.get("revision"),
            params=params,
            preview=preview,
            before=before,
            context=context,
        )
    except (CardError, catalog.CardCatalogError) as exc:
        return _refusal(exc)
    return web.json_response(await _publish(request, rec))


async def api_cards_cancel(request: web.Request) -> web.Response:
    """POST /api/cards/{id}/cancel — ``{revision}``."""
    denied = await _require_owner(request, "cards.cancel")
    if denied is not None:
        return denied
    await _store(request).warm()
    try:
        body = await _json_body(request)
        store = _store(request)
        rec = store.cancel(store.get(request.match_info["card_id"]), body.get("revision"))
    except CardError as exc:
        return _refusal(exc)
    return web.json_response(await _publish(request, rec))


async def api_cards_dismiss(request: web.Request) -> web.Response:
    """POST /api/cards/{id}/dismiss — hide a finished card."""
    denied = await _require_owner(request, "cards.dismiss")
    if denied is not None:
        return denied
    await _store(request).warm()
    try:
        store = _store(request)
        rec = store.dismiss(store.get(request.match_info["card_id"]))
    except CardError as exc:
        return _refusal(exc)
    return web.json_response(await _publish(request, rec))


# ── the route hook ──


def route_key(request: web.Request) -> tuple[str, str] | None:
    """``(method, route template)`` when *request* hit a hooked route."""
    try:
        resource = request.match_info.route.resource
    except AttributeError:
        return None
    template = getattr(resource, "canonical", None) if resource is not None else None
    if not isinstance(template, str):
        return None
    key = (request.method.upper(), template)
    return key if key in catalog.HOOKED_ROUTES else None


async def _read_body(request: web.Request) -> tuple[Any, bool]:
    """``(parsed JSON or None, ok)``, leaving the body readable for the handler.

    Handlers on the hooked routes read their body two ways: ``request.json()``
    (served from aiohttp's cache once ``read()`` ran) and
    ``_shared.read_bounded_json``, which iterates ``request.content`` and would
    find it at EOF. So the bytes read here are fed into a fresh stream that
    replaces the request's payload, and the handler sees exactly the body the
    client sent. A body sent without a declared length (a proxy or tunnel
    re-framing it as chunked) is read in chunks up to the same cap; one longer
    than the cap is refused.
    """
    if not request.can_read_body:
        return None, True
    length = request.content_length
    if length is not None and length > _BODY_MAX:
        return None, False
    parts: list[bytes] = []
    size = 0
    # The raw payload, not ``request.content``: that property is cached on first
    # access, so touching it here would pin the handler to the drained stream.
    async for chunk in request._payload.iter_chunked(2**16):  # noqa: SLF001
        size += len(chunk)
        if size > _BODY_MAX:
            return None, False
        parts.append(chunk)
    raw = b"".join(parts)
    _replay_payload(request, raw)
    if not raw:
        return None, True
    try:
        return json.loads(raw.decode("utf-8")), True
    except (ValueError, UnicodeDecodeError):
        return None, False


def _replay_payload(request: web.Request, raw: bytes) -> None:
    """Give *request* a payload stream that yields *raw* again from the start."""
    from aiohttp.streams import StreamReader

    # A limit above the body's size keeps feed_data from pausing the real
    # connection's transport, which a handler that never reads would not resume.
    limit = max(2**16, len(raw) + 1)
    stream = StreamReader(request.protocol, limit=limit, loop=asyncio.get_running_loop())
    if raw:
        stream.feed_data(raw)
    stream.feed_eof()
    request._payload = stream  # noqa: SLF001 - aiohttp keeps no public setter


def _response_json(resp: web.StreamResponse) -> Any:
    if not isinstance(resp, web.Response):
        return None
    body = resp.body
    if not isinstance(body, (bytes, bytearray)):
        return None
    try:
        return json.loads(bytes(body).decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        return None


def match_step(
    plan_step: dict[str, Any],
    *,
    method: str,
    path: str,
    query: dict[str, str],
    body: Any,
    evidence: list[dict[str, Any]],
) -> str | None:
    """Why the request differs from *plan_step*, or ``None`` when it is exactly it.

    The path is compared decoded, the query as a mapping, and the body through
    :func:`kiro_crew.dashboard.change_cards.canonical`. A ``fill`` field is the
    only allowed difference: a ``user`` fill must be a non-empty string (and is
    never read further), a ``step`` fill must equal what that earlier step's
    real response returned.
    """
    if plan_step["method"] != method:
        return "method"
    plan_path, _, plan_query = plan_step["path"].partition("?")
    if urllib.parse.unquote(plan_path) != path:
        return "path"
    if dict(urllib.parse.parse_qsl(plan_query)) != query:
        return "query"
    expected = plan_step.get("body")
    if expected is None:
        return None if body in (None, {}) else "body"
    if not isinstance(body, dict) or not isinstance(expected, dict):
        return "body"
    got = dict(body)
    want = dict(expected)
    for fill in plan_step.get("fill") or []:
        field = fill["field"]
        value = got.pop(field, None)
        want.pop(field, None)
        if fill["source"] == "user":
            if not isinstance(value, str) or not value.strip():
                return f"fill:{field}"
        else:
            idx = int(fill["step"])
            source = evidence[idx] if idx < len(evidence) else {}
            if value is None or value != source.get(fill["key"]):
                return f"fill:{field}"
    return None if cards.canonical(got) == cards.canonical(want) else "body"


def _strip_user_fills(plan_step: dict[str, Any] | None, body: Any) -> Any:
    """*body* without any value only the person typed, for memory description."""
    if not isinstance(body, dict) or not plan_step:
        return body
    out = dict(body)
    for fill in plan_step.get("fill") or []:
        if fill["source"] == "user":
            out.pop(fill["field"], None)
    return out


def _memory_body(route: tuple[str, str], body: Any) -> Any:
    if route == ("POST", "/api/secrets") and isinstance(body, dict):
        return {"name": body.get("name")}
    return body


def _record_memory(
    route: tuple[str, str], match_info: dict[str, str], body: Any, before: Any, via: str
) -> None:
    """Queue one Global memory history line for an owner mutation. Never raises."""
    try:
        text = catalog.describe_manual_change(route, match_info, _memory_body(route, body), before)
    except Exception:
        logger.debug("describing dashboard change failed", exc_info=True)
        return
    if not text:
        return
    entry = f"Dashboard: {text} ({via})"

    def _write() -> None:
        from kiro_crew.config.loader import KiroCrewConfig
        from kiro_crew.context import ContextBuilder
        from kiro_crew.memory_stores import DEFAULT_MEMORY_STORE

        # An automatic writer: with persistent memory switched off, the
        # change still happens but leaves no history line.
        if not KiroCrewConfig.load().memory.persistence_enabled:
            return
        ContextBuilder.get_memory_for(memory_store=DEFAULT_MEMORY_STORE).append_history(entry)

    async def _run() -> None:
        try:
            await asyncio.to_thread(_write)
        except Exception:
            logger.debug("dashboard memory event failed", exc_info=True)

    try:
        task = asyncio.get_running_loop().create_task(_run())
    except RuntimeError:
        return
    _BACKGROUND.add(task)
    task.add_done_callback(_BACKGROUND.discard)


async def _before_value(route: tuple[str, str], body: Any, match_info: dict[str, str]) -> Any:
    """What a memory line needs from before the change: an old value, or a display name."""
    if route in _VALUE_ROUTES:
        return await asyncio.to_thread(_config_before, route, body)
    if route == ("DELETE", "/api/agents/{name}"):
        return await asyncio.to_thread(_crewmate_display_name, match_info.get("name", ""))
    return None


def _crewmate_display_name(key: str) -> str | None:
    """The name a person sees for crewmate *key* (the create line used it too)."""
    try:
        from kiro_crew.config.loader import KiroCrewConfig

        agent = KiroCrewConfig.load().agents.get(key)
    except Exception:
        return None
    name = getattr(agent, "display_name", "") if agent is not None else ""
    return name.strip() if isinstance(name, str) and name.strip() else None


def _config_before(route: tuple[str, str], body: Any) -> Any:
    if route == ("PUT", "/api/dashboard/config") and isinstance(body, dict):
        out = {}
        for key in body:
            if key in catalog.DASHBOARD_KEYS:
                try:
                    out[key] = cards._config_value(f"dashboard.{key}")
                except Exception:
                    out[key] = None
        return out
    if route != ("PATCH", "/api/config/kirocrew") or not isinstance(body, dict):
        return None
    path = body.get("path")
    if not isinstance(path, str) or not catalog._CONFIG_PATH_RE.fullmatch(path):
        return None
    try:
        return cards._config_value(path)
    except Exception:
        return None


def _deny(status: int, code: str, message: str) -> web.Response:
    return web.json_response({"error": message, "code": code}, status=status)


def _is_owner_browser(request: web.Request) -> bool:
    from kiro_crew.dashboard.handlers.source_providers import is_owner_dashboard_request

    if request.get("internal_auth") is True:
        return False
    return is_owner_dashboard_request(request)


@web.middleware  # type: ignore[misc]
async def change_card_middleware(
    request: web.Request, handler: Callable[[web.Request], Awaitable[web.StreamResponse]]
) -> web.StreamResponse:
    """Verify and record card steps on the hooked routes; log owner mutations."""
    route = route_key(request)
    if route is None:
        return await handler(request)
    card_id = request.headers.get(HEADER_CARD_ID)
    if not card_id:
        if route not in catalog.MEMORY_ROUTES or not _is_owner_browser(request):
            return await handler(request)
        body, _ok = await _read_body(request)
        before = await _before_value(route, body, dict(request.match_info))
        resp = await handler(request)
        if 200 <= resp.status < 300:
            _record_memory(route, dict(request.match_info), body, before, "via settings page")
        return resp
    return await _run_card_step(request, handler, route, card_id)


async def _run_card_step(
    request: web.Request,
    handler: Callable[[web.Request], Awaitable[web.StreamResponse]],
    route: tuple[str, str],
    card_id: str,
) -> web.StreamResponse:
    if not _is_owner_browser(request):
        _audit(str(request.get("user") or "unknown"), "cards.apply", "denied", "not the owner")
        return _deny(403, "owner_only", "only the dashboard owner can confirm a change card")
    state = request.app["state"]
    store = card_store_for(state)
    op = (request.headers.get(HEADER_CARD_OP) or "").strip().lower()
    body, ok = await _read_body(request)
    if not ok:
        return _deny(400, "invalid_body", "the request body is not JSON")
    await store.warm()
    try:
        rec = store.get(card_id)
        admitted = store.begin_step(
            rec,
            revision=request.headers.get(HEADER_CARD_REVISION),
            op=op,
            index=request.headers.get(HEADER_CARD_STEP),
        )
    except CardError as exc:
        return _refusal(exc)
    if admitted["replay"]:
        return web.json_response({"ok": True, "card_replay": True, "card": store.public(rec)})
    plan_step = admitted["step"]
    index = (rec.get("inflight") or {}).get("step", 0)
    mismatch = match_step(
        plan_step,
        method=request.method.upper(),
        path=request.path,
        query=dict(request.query),
        body=body,
        evidence=store.step_evidence(rec, op),
    )
    if mismatch is not None:
        store.abort_step(rec)
        await store.flush()
        _audit(str(request.get("user") or "owner"), "cards.apply", "denied", f"mismatch:{mismatch}")
        return _deny(409, "plan_mismatch", f"this request does not match the card ({mismatch})")
    try:
        if index == 0:
            if op == catalog.OP_APPLY:
                current = await cards.read_state(
                    rec["kind"], rec["params"], [], state=state, app=request.app
                )
                if cards.canonical(current) != cards.canonical(rec["before"]):
                    store.abort_step(rec)
                    await _publish(request, rec)
                    return _deny(
                        409,
                        "changed_since_preview",
                        "this changed since the card was shown; preview it again",
                    )
            else:
                current = await cards.read_state(
                    rec["kind"], rec["params"], rec["evidence"], state=state, app=request.app
                )
                if cards.undo_snapshot_changed(rec["kind"], current, rec.get("after")):
                    store.abort_step(rec)
                    rec["error"] = {
                        "code": "changed_since_apply",
                        "message": "changed after it was applied",
                    }
                    await _publish(request, rec)
                    return _deny(
                        409,
                        "changed_since_apply",
                        "this changed after the card was applied; undo refused",
                    )
        elif op == catalog.OP_UNDO and await cards.resumed_undo_is_stale(
            rec, index, state=state, app=request.app
        ):
            store.abort_step(rec)
            rec["error"] = {
                "code": "changed_since_apply",
                "message": "changed after it was applied",
            }
            await _publish(request, rec)
            return _deny(
                409,
                "changed_since_apply",
                "this changed after the card was applied; undo refused",
            )
        before = await _before_value(route, body, dict(request.match_info))
        resp = await handler(request)
    except BaseException:
        store.abort_step(rec)
        await store.flush()
        raise
    data = _response_json(resp)
    if not 200 <= resp.status < 300:
        store.record_failure(rec, op=op, index=index, status=resp.status, body=data)
        if rec["status"] == cards.STATUS_PARTIAL:
            await _complete(request, rec, partial=True)
        await _publish(request, rec)
        return resp
    evidence = catalog.extract_evidence(
        rec["kind"], op, index, data if isinstance(data, dict) else None
    )
    outcome = store.record_success(rec, op=op, index=index, evidence=evidence)
    survivors: list[str] = []
    if outcome == "done" and op == catalog.OP_UNDO:
        survivors = await cards.undo_survivors(
            rec, state=request.app["state"], app=request.app, response=data
        )
    memory_body = _strip_user_fills(plan_step, body)
    if survivors and isinstance(memory_body, dict) and "changes" in memory_body:
        # History names what was actually removed, never a requested removal
        # that did not happen. Only a body that lists its removals can be
        # narrowed; any other partial Undo records nothing (below).
        memory_body = {
            **memory_body,
            "changes": [
                c
                for c in memory_body.get("changes") or []
                if not (isinstance(c, dict) and c.get("name") in survivors)
            ],
        }
    # An Undo whose removal is only partial and whose body cannot be narrowed
    # to what was removed records nothing, rather than a removal that did not
    # fully happen.
    partial_unnamed = bool(survivors) and not (
        isinstance(memory_body, dict) and "changes" in memory_body
    )
    if route in catalog.MEMORY_ROUTES and not partial_unnamed:
        _record_memory(
            route,
            dict(request.match_info),
            memory_body,
            before,
            "via Captain card" if op == catalog.OP_APPLY else "via Captain card undo",
        )
    if outcome == "done":
        if op == catalog.OP_APPLY and rec["status"] == cards.STATUS_APPLYING:
            await _complete(request, rec, partial=False)
        elif op == catalog.OP_UNDO:
            if survivors:
                # The route answered 2xx but the thing is still installed: the
                # card must not say it was undone, and Undo can be pressed again.
                rec["undo_evidence"] = []
                if rec["kind"] == catalog.KIND_CONNECTION_CONNECT:
                    # A half-removed grant is the state the retry reverses: a
                    # retry may finish this cleanup, while a grant re-established
                    # since then reads differently and is still refused.
                    rec["after"] = await cards.read_state(
                        rec["kind"],
                        rec["params"],
                        rec["evidence"],
                        state=request.app["state"],
                        app=request.app,
                    )
                store.record_failure(
                    rec,
                    op=op,
                    index=index,
                    status=500,
                    body={
                        "code": "undo_incomplete",
                        "error": f"not removed: {', '.join(survivors)[:200]}",
                    },
                )
            else:
                store.complete_undo(rec)
    await _publish(request, rec)
    return resp


async def _complete(request: web.Request, rec: dict[str, Any], *, partial: bool) -> None:
    """Read what the change made and derive the undo plan from it."""
    store = card_store_for(request.app["state"])
    applied = len(rec["evidence"])
    try:
        after = await cards.read_state(
            rec["kind"], rec["params"], rec["evidence"], state=request.app["state"], app=request.app
        )
    except Exception:
        logger.debug("post-apply read failed for card %s", rec["id"], exc_info=True)
        after = {}
    context = {"after_revision": after.get("revision"), "rule_id": after.get("id")}
    try:
        undo, reason = catalog.build_undo(
            rec["kind"], rec["params"], rec["before"], rec["evidence"], applied, context
        )
    except Exception:
        logger.debug("undo plan failed for card %s", rec["id"], exc_info=True)
        undo, reason = None, "undo_unavailable"
    if rec.get("undo_unavailable_reason") and undo is None:
        reason = rec["undo_unavailable_reason"]
    store.complete_apply(
        rec,
        after=after,
        undo=undo,
        undo_reason=reason,
        status=cards.STATUS_PARTIAL if partial else cards.STATUS_APPLIED,
    )


def register_change_card_routes(app: web.Application) -> None:
    """Mount both halves. The agent half's prefix must stay strict-internal."""
    app.router.add_get("/api/cards/agent/kinds", api_cards_agent_kinds)
    app.router.add_get("/api/cards/agent/settings", api_cards_agent_settings)
    app.router.add_get("/api/cards/agent/capabilities", api_cards_agent_capabilities)
    app.router.add_get("/api/cards/agent/diagnose", api_cards_agent_diagnose)
    app.router.add_post("/api/cards/agent/propose", api_cards_agent_propose)
    app.router.add_get("/api/cards/agent/status", api_cards_agent_status)
    app.router.add_get("/api/cards/pending", api_cards_pending)
    app.router.add_post("/api/cards/{card_id}/preview", api_cards_preview)
    app.router.add_post("/api/cards/{card_id}/cancel", api_cards_cancel)
    app.router.add_post("/api/cards/{card_id}/dismiss", api_cards_dismiss)
