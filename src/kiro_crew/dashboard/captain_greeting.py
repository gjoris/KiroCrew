"""Captain's first greeting: one real model turn the first time its chat opens.

The built-in Captain member (``kirocrew-captain``) speaks first. When the owner
opens Captain's pinned DM thread and it holds no messages yet, the dashboard asks
for a greeting (``POST /api/members/{slug}/greet``) and this module starts ONE
ordinary Captain turn whose prompt is :data:`CAPTAIN_GREETING_KICKOFF`. Captain's
role prompt (``agent._ASSISTANT_SYSTEM_PROMPT``, "First greeting and names") tells it what
that kickoff means: introduce itself by its display name with one line on what
it helps with, then ask how to address the user.

Three properties are the whole design:

* **A real turn, no user row.** The kickoff goes to the model through
  ``_run_chat`` exactly like a gateway-composed prompt (``_synthetic_payload``,
  actor ``gateway``), but nothing is appended to the transcript before dispatch,
  so the user never sees a bubble they did not type. The greeting itself is
  Captain's own assistant row in its own session, so the next turn knows it
  asked for a name.
* **At most once per Captain thread.** A marker file in the member's directory
  is created with ``O_EXCL`` BEFORE dispatch, so two tabs, a reload or a retry
  after a failed turn can never greet twice. A thread that already has rows, or a
  turn in flight, never greets either; neither consumes the marker.
* **Captain only.** The slug must resolve through its DM binding to
  ``kirocrew-captain`` and the live slot must be that member's pinned thread.

A turn that fails (no backend, signed-out CLI) surfaces through the normal turn
error path once; the marker is already claimed, so it never loops.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import time
from pathlib import Path
from typing import Any

from kiro_crew import members as members_mod
from kiro_crew.agent_files import ASSISTANT_MEMBER_NAME

logger = logging.getLogger(__name__)

#: The hidden instruction the greeting turn runs. The leading tag is the one the
#: Captain role prompt names; the rest tells the model plainly that the user has
#: not typed anything, so it is never mistaken for speech.
CAPTAIN_GREETING_KICKOFF = (
    "[Captain first greeting] The user just opened this chat for the first time "
    "and it has no messages yet. They have not typed anything: this note comes "
    "from Kiro Crew, not from them, and they cannot see it. This is your first "
    "conversation with them, so do not welcome them back, and use a name only if "
    "their preferences or your memory state it, never one taken from a username, "
    "path, email or host name. Follow the "
    '"First greeting and names" rule of your role now: introduce yourself by your name, '
    "say what you help with, then ask how to address them (or greet them by the "
    "name you already know). That rule sets the length and what to cover."
)

#: One-time marker under the member's directory (``members/<slug>/``).
GREETING_MARKER_FILENAME = "captain_greeting.json"

# Outcomes reported to the caller. Only ``started`` dispatched a turn.
STARTED = "started"
NOT_CAPTAIN = "not_captain"
NO_THREAD = "no_thread"
NOT_EMPTY = "not_empty"
BUSY = "busy"
ALREADY_GREETED = "already_greeted"


def greeting_marker_path(slug: str) -> Path:
    """Where the once-only marker for *slug*'s thread lives (containment-checked)."""
    return members_mod.member_dir(slug) / GREETING_MARKER_FILENAME


def claim_greeting_marker(slug: str, slot_key: str) -> bool:
    """Atomically claim the greeting for *slug*. False when it was already claimed.

    ``O_CREAT | O_EXCL`` is the whole guard: it is atomic across tasks and
    processes, so exactly one caller ever sees True. Blocking IO; call it off
    the event loop.
    """
    path = greeting_marker_path(slug)
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        return False
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        json.dump({"slot_key": slot_key, "ts": time.time()}, fh)
    return True


def _captain_slot(state: Any, binding: dict | None) -> tuple[str, Any]:
    """Resolve a DM *binding* to Captain's live pinned thread, or say why not."""
    if binding is None or binding.get("member") != ASSISTANT_MEMBER_NAME:
        return NOT_CAPTAIN, None
    slot = state._slots.get(binding.get("slot_key", ""))
    if (
        slot is None
        or slot.mode != members_mod.DM_SLOT_MODE
        or slot.agent != ASSISTANT_MEMBER_NAME
        or slot.is_remote
        or getattr(slot, "executor", "") == "remote"
    ):
        return NO_THREAD, None
    return "", slot


def _has_content(slot: Any) -> bool:
    """True when the thread already holds anything a greeting would precede."""
    return bool(slot.messages) or bool(getattr(slot, "_queue", None))


async def maybe_start_captain_greeting(state: Any, slug: str) -> str:
    """Start Captain's first greeting on *slug*'s thread when it is owed.

    Returns one of the module's outcome constants. Every check that can refuse
    runs BEFORE the marker is claimed, and the emptiness/busy checks run again
    after the off-loop claim, since a send can land while the claim is written.
    """
    binding = await asyncio.to_thread(members_mod.read_dm_binding, slug)
    reason, slot = _captain_slot(state, binding)
    if slot is None:
        return reason
    if slot.running:
        return BUSY
    if _has_content(slot):
        return NOT_EMPTY
    if not await asyncio.to_thread(claim_greeting_marker, slug, slot.key):
        return ALREADY_GREETED
    if slot.running or _has_content(slot) or state._slots.get(slot.key) is not slot:
        # Lost the race to a real send (or the slot was replaced) after the
        # claim. The user is already talking, so the greeting is simply moot.
        return NOT_EMPTY if _has_content(slot) else BUSY
    _dispatch_greeting(state, slot)
    return STARTED


def _dispatch_greeting(state: Any, slot: Any) -> None:
    """Run the kickoff as a gateway-authored turn, with no transcript row for it."""
    # Deferred: chat_handlers / chat import this package's handlers at load.
    from kiro_crew.dashboard.chat import _run_chat
    from kiro_crew.dashboard.chat_handlers import _sweep_stale_permissions
    from kiro_crew.dashboard.turn_dispatch import spawn_guarded_turn

    # The owner opened this thread, so a human is demonstrably watching it.
    slot._human_seen = True
    slot._has_reader = False  # delivered over the WebSocket, like a ws send
    slot._file_changes = []
    _sweep_stale_permissions(slot)
    task = spawn_guarded_turn(
        state,
        slot,
        state.run_background_turn(
            slot,
            _run_chat(
                state,
                slot,
                CAPTAIN_GREETING_KICKOFF,
                _synthetic_payload=True,
                _turn_actor="gateway",
            ),
        ),
    )
    slot.task = task
    state.push_slots_update()
    logger.info("captain greeting started on %s", slot.key)
