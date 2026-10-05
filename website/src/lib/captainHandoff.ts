import { useSyncExternalStore } from 'react'
import { ASSISTANT_MEMBER_NAME, isAssistantMember } from './assistantMember'
import { consumeChatHandoff } from '../utils/errorReport'
import { mergePaneDraft } from '../utils/chatPaneDrafts'
import { safeGetSessionItem, safeSetSessionItem } from '../utils/safeStorage'
import { i18nT } from '../i18n/t'

/**
 * Error hand-offs go to Captain — the built-in Assistant crewmate — instead of a
 * fresh generic chat.
 *
 * The roster lives in React Query, but the hand-off's callers include
 * ErrorBoundary fallbacks, where the store, router or query client may be what
 * threw. So the Captain identity is published into this module-level store by
 * App.tsx while the app is healthy (the same shape as `installSoftNavigate`),
 * and read here without any provider. It is cached in sessionStorage so the
 * root boundary's hard reload, and the first paint before the roster arrives,
 * still know where to send the user.
 *
 * Three states: `undefined` (not yet known), `null` (no Captain on the roster,
 * so the old generic hand-off is used), or the raw display name
 * (`''` when Captain carries no label of its own and reads as the localized
 * default name).
 */

/** Queue tag that routes a staged hand-off to Captain's composer, not /chat. */
export const CAPTAIN_HANDOFF_TARGET = 'captain'

/** The route the app lands on Captain with: the Crewmates page, its thread open. */
export const CAPTAIN_ROUTE = `/members?member=${encodeURIComponent(ASSISTANT_MEMBER_NAME)}`

const CACHE_KEY = 'kirocrew_captain_identity'

type CaptainState = { displayName: string } | null | undefined

function readCache(): CaptainState {
  const raw = safeGetSessionItem(CACHE_KEY)
  if (raw === null) return undefined
  try {
    const v: unknown = JSON.parse(raw)
    if (v === null) return null
    if (v && typeof v === 'object' && typeof (v as { displayName?: unknown }).displayName === 'string') {
      return { displayName: (v as { displayName: string }).displayName }
    }
  } catch { /* corrupt cache reads as unknown */ }
  return undefined
}

let _captain: CaptainState = readCache()
const _listeners = new Set<() => void>()

function setCaptain(next: CaptainState): void {
  const same = next === _captain
    || (!!next && !!_captain && next.displayName === _captain.displayName)
  if (same) return
  _captain = next
  if (next !== undefined) safeSetSessionItem(CACHE_KEY, JSON.stringify(next))
  for (const fn of _listeners) {
    try { fn() } catch { /* one bad subscriber must not block the rest */ }
  }
}

/** Publish the crew registry's agent rows. Called by App.tsx on every roster read. */
export function publishCaptainFromAgents(
  agents: ReadonlyArray<{ name?: string; kiro_agent?: unknown; display_name?: string }> | null | undefined,
): void {
  if (!Array.isArray(agents)) return
  const row = agents.find(isAssistantMember)
  setCaptain(row ? { displayName: row.display_name?.trim() ?? '' } : null)
}

/** Captain's current display name, or null when there is no Captain (or it is not yet known). */
export function captainDisplayName(): string | null {
  if (!_captain) return null
  return _captain.displayName || i18nT('components.assistantWelcome.default_name')
}

function subscribe(fn: () => void): () => void {
  _listeners.add(fn)
  return () => { _listeners.delete(fn) }
}

function snapshot(): CaptainState {
  return _captain
}

/**
 * Captain's display name, re-rendering when it changes. Needs no provider, so
 * it is safe inside an ErrorBoundary fallback.
 */
export function useCaptainName(): string | null {
  const state = useSyncExternalStore(subscribe, snapshot, snapshot)
  if (!state) return null
  return state.displayName || i18nT('components.assistantWelcome.default_name')
}

/** Where an error hand-off leads right now: Captain's thread, or /chat without one. */
export function errorHandoffDestination(): string {
  return captainDisplayName() ? CAPTAIN_ROUTE : '/chat'
}

/**
 * Move every Captain-tagged hand-off into Captain's composer for `slotKey`.
 *
 * Delivered through the pane draft store: a pane already showing the slot takes
 * it into its live composer; otherwise it is parked and taken on mount. The
 * store's merge appends to whatever the user had typed, so an unsent draft is
 * kept, and nothing is sent.
 */
export function drainCaptainHandoffs(slotKey: string): number {
  if (!slotKey) return 0
  let n = 0
  let prompt: string | null
  while ((prompt = consumeChatHandoff({ target: CAPTAIN_HANDOFF_TARGET })) !== null) {
    mergePaneDraft(slotKey, prompt, [])
    n++
  }
  return n
}

/** Test seam — the identity is module state. */
export function __setCaptainForTests(next: CaptainState): void {
  _captain = next
  for (const fn of _listeners) fn()
}
