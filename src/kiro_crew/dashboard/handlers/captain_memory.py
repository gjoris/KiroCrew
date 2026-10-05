"""Captain's two doors into Global memory: a read-only recall and a preference line.

Captain (the built-in ``kirocrew-captain`` member) keeps its own working memory in
a private member store, like any crewmate. Two things still belong to the user's
Global memory, and only Captain is given them:

* ``GET /api/captain/agent/global-recall?q=`` -- the same recall ``memory_recall``
  runs, answered from Global memory instead of the caller's store. Read-only.
* ``POST /api/captain/agent/global-preference`` -- append one line to Global
  ``preferences.md``, the document every ordinary chat and Captain itself receive
  as the user's preferences ("Address the user as Ray.").

Who may call is decided HERE, from the authenticated execution record the internal
transport vouches for (:func:`kiro_crew.execution_context.is_assistant_execution`),
never from a prompt, a header the caller chose or a slot name. Every other member,
private or not, an ordinary chat, a delegate on Captain's store under another
template and a browser token are refused, so no private crewmate gains a path to
Global memory. Both routes sit under the strict ``/api/captain/agent`` prefix
(``dashboard.server._STRICT_INTERNAL_API_PATHS``): there is no browser caller.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

from aiohttp import web

from kiro_crew.config.loader import KiroCrewConfig

from ._shared import (
    _blocks_reads_session,
    _is_restricted_session,
    member_request_scope,
    read_bounded_json,
)
from .memory import memory_recall_deadline
from .memory_member import recall_from_store

logger = logging.getLogger(__name__)

#: Longest preference line Captain may add, the same bound a lesson rule carries.
MAX_PREFERENCE_CHARS = 500
#: Compare-and-swap attempts against a concurrent writer (a consolidation pass or
#: the dashboard's own Save) before the write is reported as busy.
_PREFERENCE_CAS_ATTEMPTS = 3


def _refuse(message: str, code: str, status: int = 403) -> web.Response:
    return web.json_response({"error": message, "code": code}, status=status)


def _audit(operation: str, outcome: str, session: str, error: str = "") -> None:
    try:
        import kiro_crew.dashboard.handlers as _pkg

        _pkg.sel().log_api_access(
            caller=session or "internal",
            operation=operation,
            outcome=outcome,
            source="captain_memory",
            error=error,
        )
    except Exception:  # pragma: no cover - audit must never change the outcome
        logger.debug("SEL audit for %s failed", operation, exc_info=True)


async def require_assistant_caller(
    request: web.Request, operation: str, *, write: bool
) -> web.Response | None:
    """Refuse every caller that is not Captain's own authenticated turn.

    Order is the control: transport first (only the internal secret carries an
    execution record at all), then the record, then the session's privacy mode.
    A temporary session reads nothing; incognito additionally writes nothing.
    """
    session = request.headers.get("X-Session-Key", "")
    if request.get("internal_auth") is not True:
        await asyncio.to_thread(_audit, operation, "denied", session, "not an agent call")
        return _refuse("Only Captain can use Global memory here.", "captain_only")
    scope = await member_request_scope(request)
    if not scope.verified or scope.execution is None:
        await asyncio.to_thread(_audit, operation, "denied", session, "no execution record")
        return _refuse("Only Captain can use Global memory here.", "captain_only")
    from kiro_crew.execution_context import is_assistant_execution

    config = await asyncio.to_thread(KiroCrewConfig.load)
    if not is_assistant_execution(config, scope.execution):
        await asyncio.to_thread(_audit, operation, "denied", session, "not Captain")
        return _refuse("Only Captain can use Global memory here.", "captain_only")
    state = request.app["state"]
    mode = scope.execution.memory_mode
    if mode == "temporary" or _blocks_reads_session(state, request):
        await asyncio.to_thread(_audit, operation, "denied", session, "reads disabled")
        return _refuse("Memory reads are disabled for this session.", "memory_reads_disabled")
    if write and (mode != "persistent" or _is_restricted_session(state, request)):
        await asyncio.to_thread(_audit, operation, "denied", session, "writes disabled")
        return _refuse("Memory writes are not allowed in this session mode.", "restricted_session")
    await asyncio.to_thread(_audit, operation, "allowed", session)
    return None


@memory_recall_deadline
async def api_captain_global_recall(request: web.Request) -> web.Response:
    """GET /api/captain/agent/global-recall?q= -- Captain's read-only Global recall."""
    refusal = await require_assistant_caller(request, "captain.global_recall", write=False)
    if refusal is not None:
        return refusal
    return await recall_from_store(request, request.app["state"], "")


def _normalized_preference(raw: object) -> str | None:
    """One trimmed line of at most :data:`MAX_PREFERENCE_CHARS`, or ``None``.

    A line break would let one call write several entries (or a heading) into a
    document every session reads, and a credential has no business in it, so
    both are refused rather than rewritten.
    """
    from kiro_crew.security import redact_credentials

    if not isinstance(raw, str):
        return None
    text = raw.strip()
    if text.startswith("- "):
        text = text[2:].strip()
    if not text or len(text) > MAX_PREFERENCE_CHARS or "\n" in text or "\r" in text:
        return None
    if redact_credentials(text)[0] != text:
        return None
    return text


def _append_preference(memory: Any, line: str) -> str:
    """Append ``- line`` to Global ``preferences.md`` under compare-and-swap.

    Returns ``"added"``, ``"unchanged"`` (the line is already there), ``"busy"``
    (a concurrent writer won every attempt) or ``"persistence_disabled"`` (the
    operator switched persistent memory off, so nothing is written -- the same
    switch ``learn_add`` honours). Never rewrites existing text.
    """
    if not KiroCrewConfig.load().memory.persistence_enabled:
        return "persistence_disabled"
    entry = f"- {line}"
    for _ in range(_PREFERENCE_CAS_ATTEMPTS):
        current = memory.read_preferences()
        if any(existing.strip() == entry for existing in current.splitlines()):
            return "unchanged"
        content = current if current.endswith("\n") or not current else current + "\n"
        if memory.write_preferences(content + entry + "\n", expected_baseline=current):
            return "added"
    return "busy"


async def api_captain_global_preference(request: web.Request) -> web.Response:
    """POST /api/captain/agent/global-preference -- add one line to Global preferences."""
    refusal = await require_assistant_caller(request, "captain.global_preference", write=True)
    if refusal is not None:
        return refusal
    body, refusal = await read_bounded_json(request, max_bytes=4096)
    if refusal is not None:
        return refusal
    assert body is not None
    line = _normalized_preference(body.get("preference"))
    if line is None:
        return _refuse(
            f"A preference is one line of 1-{MAX_PREFERENCE_CHARS} characters with no "
            "credentials.",
            "invalid_preference",
            400,
        )
    state = request.app["state"]
    builder = getattr(state, "context_builder", None)
    if builder is None:
        return _refuse("Global memory is unavailable.", "store_unavailable", 503)
    try:
        outcome = await asyncio.to_thread(_append_preference, builder.memory, line)
    except (OSError, ValueError, UnicodeDecodeError):
        logger.warning("Captain's global preference write failed", exc_info=True)
        return _refuse("Global memory is unavailable.", "store_unavailable", 503)
    if outcome == "persistence_disabled":
        return _refuse(
            "The preference was NOT saved: persistent memory is turned off "
            "(memory.persistence_enabled).",
            "persistence_disabled",
            409,
        )
    if outcome == "busy":
        return _refuse(
            "The preferences document changed while saving; try again.", "preferences_busy", 409
        )
    return web.json_response({"status": outcome, "preference": line})
