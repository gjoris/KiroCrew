/**
 * The registered-action guide's on-screen layer: one small floating panel and,
 * while a step's target is found, an arrow and outline on that control. It
 * floats over every page for the states that walk the user somewhere (an
 * active step, a missing target, a step the user navigated away from, another
 * tab, re-entry, a refusal); the offer
 * and the result live in the slot's chat (GuideOfferCard). Once the guide this
 * tab drove ends, the same panel becomes a chip saying so with the way back to
 * that chat, shown only while the user is not already on it.
 *
 * The panel never reserves layout space. While a step's target is tracked it
 * is a popover anchored to that control on the side OPPOSITE the arrow
 * (`popoverPlacement`), so the explanation reads next to what it explains; in
 * every other state it is a chip floating at the bottom centre. It is ONE
 * element in both forms, so the eye follows it from the chip to the control.
 *
 * Non-modal by construction. There is no scrim and no full-screen element:
 * the arrow and outline are `pointer-events: none` and hidden from assistive
 * tech, so every click and key still reaches the page underneath, and only the
 * panel's own buttons take input. The panel never covers the target and never
 * takes focus on its own.
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { useLocation, useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { motion, useReducedMotion } from 'framer-motion'
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Compass, Loader2, X } from 'lucide-react'
import { Btn, IconButton } from '../components/ui'
import ErrorNotice from '../components/ErrorNotice'
import { useGuardedLeave } from '../components/NavigationLeaveGuard'
import { membersRosterQuery } from '../api/membersQuery'
import type { MemberRosterRow } from '../api/client'
import type { ChatSlot } from '../types'
import { useAppSelector } from '../store'
import { ASSISTANT_KIRO_AGENT, ASSISTANT_MEMBER_NAME, isAssistantMember } from '../lib/assistantMember'
import { CAPTAIN_ROUTE, useCaptainName } from '../lib/captainHandoff'
import type { GuideActionRefusal } from './guideActions'
import { useGuide, useViewedSlot, type GuideView } from './GuideContext'
import { finishedKeyFor } from './GuideOfferCard'
import { useGuideStepTracker, type GuideRect } from './useGuideStepTracker'

const ARROW = 24
const GAP = 6
/** The outline is drawn this far outside the target box. */
const OUTLINE = 4
/** Minimum distance between the panel and every viewport edge. */
export const PANEL_MARGIN = 8
export const PANEL_MAX_WIDTH = 320
/** Below this viewport width the panel spans the viewport minus its margins. */
const NARROW = 768

interface Viewport { width: number; height: number }
export interface Box { top: number; left: number; bottom: number; right: number }
/** A box of page text; `weight` is how much hiding it costs (a field label more than a heading). */
export interface TextBox extends Box { weight?: number }

/** Which way the arrow points: at the target from above (`down`), below (`up`), its left (`right`) or right (`left`). */
export type ArrowDir = 'down' | 'up' | 'left' | 'right'
export interface ArrowPlace {
  top: number
  left: number
  /** The arrow is below the target, pointing up at it. */
  up: boolean
  dir: ArrowDir
}

/** Smallest distance kept between the arrow and the viewport edge. */
const ARROW_EDGE = 4
/** How far the arrow's nudge animation moves it away from the target. */
const ARROW_TRAVEL = 4

const boxesTouch = (a: Box, b: Box, pad: number) =>
  a.left < b.right + pad && b.left < a.right + pad && a.top < b.bottom + pad && b.top < a.bottom + pad

/**
 * Where the arrow sits for a target. It keeps GAP from the target's OUTLINE
 * (not the bare box) and GAP from every control in `obstacles` -- the page's
 * neighbouring controls, so the arrow never lands on another control's
 * border. Tried in order: above (below first when the viewport has no room
 * above), the other vertical side, either vertical side shifted along the
 * target to a clear column, then beside the target pointing sideways. When
 * nothing is clear it falls back to the first vertical side: the arrow must
 * still say where the target is.
 */
export function arrowPlacement(rect: GuideRect, viewport: Viewport, obstacles: readonly Box[] = []): ArrowPlace {
  const reach = OUTLINE + GAP
  const minLeft = ARROW_EDGE
  const maxLeft = Math.max(ARROW_EDGE, viewport.width - ARROW - ARROW_EDGE)
  const clampX = (x: number) => Math.min(Math.max(x, minLeft), maxLeft)
  const aboveTop = rect.top - reach - ARROW
  const belowTop = rect.top + rect.height + reach
  const roomAbove = aboveTop >= ARROW_EDGE
  const center = clampX(rect.left + rect.width / 2 - ARROW / 2)
  const inView = (top: number, left: number) =>
    top >= ARROW_EDGE && top + ARROW <= viewport.height - ARROW_EDGE && left >= minLeft && left <= maxLeft
  const clear = (top: number, left: number, dir: ArrowDir) => {
    if (!inView(top, left)) return false
    // The nudge animation moves the arrow ARROW_TRAVEL away from the target,
    // so the box it sweeps, not only where it rests, keeps GAP from neighbours.
    const box: Box = {
      top: top - (dir === 'down' ? ARROW_TRAVEL : 0),
      left: left - (dir === 'right' ? ARROW_TRAVEL : 0),
      bottom: top + ARROW + (dir === 'up' ? ARROW_TRAVEL : 0),
      right: left + ARROW + (dir === 'left' ? ARROW_TRAVEL : 0),
    }
    return !obstacles.some(o => boxesTouch(box, o, GAP))
  }
  const vertical: Array<{ top: number; dir: ArrowDir }> = roomAbove
    ? [{ top: aboveTop, dir: 'down' }, { top: belowTop, dir: 'up' }]
    : [{ top: belowTop, dir: 'up' }, { top: aboveTop, dir: 'down' }]
  const place = (top: number, left: number, dir: ArrowDir): ArrowPlace => ({ top, left, up: dir === 'up', dir })

  for (const v of vertical) if (clear(v.top, center, v.dir)) return place(v.top, center, v.dir)
  // Slide along the target's span, nearest to its centre first.
  const from = clampX(rect.left)
  const to = clampX(rect.left + rect.width - ARROW)
  const columns: number[] = []
  for (let d = 4; d <= rect.width; d += 4) {
    for (const x of [center - d, center + d]) if (x >= from && x <= to) columns.push(x)
  }
  for (const v of vertical) for (const x of columns) if (clear(v.top, x, v.dir)) return place(v.top, x, v.dir)
  const sideTop = rect.top + rect.height / 2 - ARROW / 2
  const right = rect.left + rect.width + reach
  const left = rect.left - reach - ARROW
  if (clear(sideTop, right, 'left')) return place(sideTop, right, 'left')
  if (clear(sideTop, left, 'right')) return place(sideTop, left, 'right')
  const first = vertical[0]
  return place(first.top, center, first.dir)
}

const NO_BOXES: readonly Box[] = []

/** How often the boxes around a tracked target are re-measured. */
export const GUIDE_RELAYOUT_MS = 500

const sameBoxes = (a: readonly Box[], b: readonly Box[]) =>
  a.length === b.length && a.every((x, i) => x.top === b[i].top && x.left === b[i].left && x.bottom === b[i].bottom && x.right === b[i].right)

/** *boxes*, but the previous array when the measurement did not change. */
function useStableBoxes(boxes: readonly Box[]): readonly Box[] {
  const ref = useRef(boxes)
  if (!sameBoxes(ref.current, boxes)) ref.current = boxes
  return ref.current
}

/** How far from the target the arrow can reach: its candidate spots lie within this band. */
export const ARROW_BAND = OUTLINE + 2 * GAP + ARROW

/**
 * The boxes of the page's controls within *band* of *rect* (clipped to
 * *viewport* when given), other than the target itself, its own parts,
 * anything wrapping it, and the guide's own layer. The arrow needs only the
 * ones within ARROW_BAND; the panel, which can float anywhere, needs every
 * control on screen.
 */
export function nearbyControlBoxes(rect: GuideRect, root: ParentNode = document, band = ARROW_BAND, viewport?: Viewport): Box[] {
  const zone: Box = { top: rect.top - band, left: rect.left - band, bottom: rect.top + rect.height + band, right: rect.left + rect.width + band }
  if (viewport) {
    zone.top = Math.max(zone.top, 0); zone.left = Math.max(zone.left, 0)
    zone.bottom = Math.min(zone.bottom, viewport.height); zone.right = Math.min(zone.right, viewport.width)
  }
  const target: Box = { top: rect.top, left: rect.left, bottom: rect.top + rect.height, right: rect.left + rect.width }
  const out: Box[] = []
  for (const el of Array.from(root.querySelectorAll<HTMLElement>('button, input, select, textarea, a[href], [role="button"], [role="combobox"], [role="tab"], [role="switch"], [role="radio"], [role="checkbox"]'))) {
    if (el.closest('[data-testid="guide-pill"]')) continue
    const r = el.getBoundingClientRect()
    if (r.width <= 0 || r.height <= 0) continue
    const b: Box = { top: r.top, left: r.left, bottom: r.bottom, right: r.right }
    if (!boxesTouch(b, zone, 0)) continue
    const inside = b.top >= target.top - 1 && b.left >= target.left - 1 && b.bottom <= target.bottom + 1 && b.right <= target.right + 1
    const wraps = b.top <= target.top + 1 && b.left <= target.left + 1 && b.bottom >= target.bottom - 1 && b.right >= target.right - 1
    if (inside || wraps) continue
    out.push(b)
  }
  return out
}

/** On-screen labels and headings outside the guide's own layer. */
export function pageTextBoxes(viewport: Viewport, root: ParentNode = document): TextBox[] {
  const out: TextBox[] = []
  for (const el of Array.from(root.querySelectorAll<HTMLElement>('label, h1, h2, h3, legend'))) {
    if (el.closest('[data-testid="guide-pill"]')) continue
    const r = el.getBoundingClientRect()
    if (r.width <= 0 || r.height <= 0) continue
    if (r.bottom <= 0 || r.top >= viewport.height || r.right <= 0 || r.left >= viewport.width) continue
    // A field label names what the step asks the user to look at; a heading
    // (often a decorative hero) can be read past.
    const weight = el.tagName === 'LABEL' || el.tagName === 'LEGEND' ? TEXT_LABEL_WEIGHT : 1
    out.push({ top: r.top, left: r.left, bottom: r.bottom, right: r.right, weight })
  }
  return out
}

/** How many headings hiding one field label is worth. */
const TEXT_LABEL_WEIGHT = 3

/**
 * The page's own chrome the panel must never cover: everything above the
 * main region (the top bar, which on a phone holds the menu button) and any
 * sticky bar pinned to the main region's top (a settings page's back bar).
 */
export function pageChromeBoxes(viewport: Viewport, root: Document = document): Box[] {
  const main = root.getElementById('main-content')
  if (!main) return []
  const m = main.getBoundingClientRect()
  let bottom = m.top
  for (const el of Array.from(main.querySelectorAll<HTMLElement>('.sticky, .fixed'))) {
    const r = el.getBoundingClientRect()
    if (r.height > 0 && Math.abs(r.top - m.top) <= 2 && r.width >= m.width / 2) bottom = Math.max(bottom, r.bottom)
  }
  return bottom > 0 ? [{ top: 0, left: 0, bottom, right: viewport.width }] : []
}

export function panelWidth(viewportWidth: number): number {
  const room = Math.max(0, viewportWidth - 2 * PANEL_MARGIN)
  return viewportWidth < NARROW ? room : Math.min(PANEL_MAX_WIDTH, room)
}

export interface PanelPlacement {
  top: number
  left: number
  width: number
  /**
   * `opposite`: the side away from the arrow; `beyond-arrow`: past the arrow
   * on its own side; `beside`: left or right of the target; `past-controls`:
   * just past a neighbouring control, clear of it; `corner`: a viewport corner.
   */
  side: 'opposite' | 'beyond-arrow' | 'beside' | 'past-controls' | 'corner'
}

const overlap = (a: Box, b: Box) =>
  Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top))

/**
 * Where the step panel floats for a tracked target. Candidates, in order:
 * opposite the arrow (arrow above the target -> panel below it), past the
 * arrow on its own side, beside the target, just past each neighbouring
 * control (nearest the target first), then the viewport corners; each
 * vertical candidate is tried centred on the target, then flush with either
 * of its edges.
 *
 * The first candidate that stays inside the viewport by PANEL_MARGIN and
 * overlaps neither the target outline, the arrow, the page chrome
 * (`reserved`) nor any control in `obstacles` wins. When none is clear, the
 * one covering the least is taken, worst first: the target and the arrow,
 * then the chrome, then other controls, then field labels and headings
 * (`text`) -- so it covers a label before a control, a control before the
 * header, and any of them before the target. The panel stays
 * non-modal either way: it only ever floats over the page.
 */
export function popoverPlacement(
  rect: GuideRect,
  viewport: Viewport,
  height: number,
  obstacles: readonly Box[] = [],
  reserved: readonly Box[] = [],
  text: readonly TextBox[] = [],
): PanelPlacement {
  const m = PANEL_MARGIN
  const width = panelWidth(viewport.width)
  const arrow = arrowPlacement(rect, viewport, obstacles)
  const outline: Box = { top: rect.top - OUTLINE, left: rect.left - OUTLINE, bottom: rect.top + rect.height + OUTLINE, right: rect.left + rect.width + OUTLINE }
  const arrowBox: Box = { top: arrow.top, left: arrow.left, bottom: arrow.top + ARROW, right: arrow.left + ARROW }
  const maxLeft = Math.max(m, viewport.width - width - m)
  const maxTop = Math.max(m, viewport.height - height - m)
  const centred = Math.min(Math.max(rect.left + rect.width / 2 - width / 2, m), maxLeft)
  // Above or below, the panel stays beside the target's span: centred on it,
  // else flush with its left or right edge.
  const clampLeft = (x: number) => Math.min(Math.max(x, m), maxLeft)
  const lefts = [centred, clampLeft(rect.left), clampLeft(rect.left + rect.width - width)]
  const guarded = [outline, arrowBox]

  type Cand = { top: number; left: number; side: PanelPlacement['side'] }
  const cands: Cand[] = []
  const vertical = (top: number, side: Cand['side']) => { for (const left of lefts) cands.push({ top, left, side }) }
  // `arrow.up`: the arrow sits BELOW the target, pointing up at it.
  vertical(arrow.up ? outline.top - GAP - height : outline.bottom + GAP, 'opposite')
  vertical(arrow.up ? arrowBox.bottom + GAP : arrowBox.top - GAP - height, 'beyond-arrow')
  const sideTop = Math.min(Math.max(rect.top + rect.height / 2 - height / 2, m), maxTop)
  cands.push({ top: sideTop, left: outline.right + GAP, side: 'beside' }, { top: sideTop, left: outline.left - GAP - width, side: 'beside' })
  const mid = rect.top + rect.height / 2
  const edges = [...obstacles, ...text]
    .flatMap(o => [o.bottom + GAP, o.top - GAP - height])
    .sort((a, b) => Math.abs(a + height / 2 - mid) - Math.abs(b + height / 2 - mid))
  for (const top of edges) vertical(top, 'past-controls')
  for (const top of [maxTop, m]) for (const left of [maxLeft, m]) cands.push({ top, left, side: 'corner' })

  const boxOf = (c: Cand): Box => ({ top: c.top, left: c.left, bottom: c.top + height, right: c.left + width })
  const inView = (c: Cand) => c.top >= m - 0.5 && c.left >= m - 0.5 && c.top + height <= viewport.height - m + 0.5 && c.left + width <= viewport.width - m + 0.5
  const cost = (c: Cand) => {
    const b = boxOf(c)
    // Worst first: the target and arrow, then the chrome, then other controls.
    return [
      guarded.reduce((n, f) => n + overlap(b, f), 0),
      reserved.reduce((n, f) => n + overlap(b, f), 0),
      obstacles.reduce((n, o) => n + overlap(b, o), 0),
      // Text is counted, not measured: half a label is as unreadable as all
      // of it, so a small label must not lose to a large heading on area.
      text.reduce((n, o) => n + (overlap(b, o) > 0 ? (o.weight ?? 1) : 0), 0),
    ]
  }
  const less = (a: number[], b: number[]) => { for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] < b[i]; return false }
  let best: { c: Cand; k: number[] } | null = null
  for (const c of cands) {
    if (!inView(c)) continue
    const k = cost(c)
    if (k.every(v => v === 0)) return { top: c.top, left: c.left, width, side: c.side }
    if (!best || less(k, best.k)) best = { c, k }
  }
  const c = best?.c ?? { top: maxTop, left: maxLeft, side: 'corner' as const }
  return { top: c.top, left: c.left, width, side: c.side }
}

function subscribeViewport(onChange: () => void) {
  window.addEventListener('resize', onChange)
  return () => window.removeEventListener('resize', onChange)
}
/** A snapshot key `useSyncExternalStore` can compare by value; split back below. */
const viewportKey = () => [window.innerWidth, window.innerHeight].join(',')

/** The viewport size, re-read on resize (the tracker re-measures the target, not the window). */
function useViewport(): Viewport {
  const key = useSyncExternalStore(subscribeViewport, viewportKey, viewportKey)
  const [w, h] = key.split(',').map(Number)
  return { width: w, height: h }
}

/** The panel's rendered height, followed as its content changes. */
function useMeasuredHeight(): [(el: HTMLElement | null) => void, number] {
  const [el, setEl] = useState<HTMLElement | null>(null)
  const [height, setHeight] = useState(0)
  useEffect(() => {
    if (!el) return
    const read = () => setHeight(el.offsetHeight)
    read()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(read)
    ro.observe(el)
    return () => ro.disconnect()
  }, [el])
  return [setEl, height]
}

/**
 * The one panel element. Anchored next to `rect` when given, else a chip at
 * the bottom centre. Either way it is `position: fixed` in a portal, so it
 * takes no space from the page. Moving between the two forms animates the
 * same element (reduced motion drops the motion, not the element); following
 * a scrolling target snaps, so it never trails the control it describes.
 */
function GuidePanel({ rect, obstacles, reserved, text, label, reduceMotion, panelRef, onFocus, onBlur, children }: {
  rect: GuideRect | null
  obstacles: readonly Box[]
  reserved: readonly Box[]
  text: readonly TextBox[]
  label: string
  reduceMotion: boolean
  panelRef: React.MutableRefObject<HTMLElement | null>
  onFocus: (e: React.FocusEvent<HTMLElement>) => void
  onBlur: (e: React.FocusEvent<HTMLElement>) => void
  children: React.ReactNode
}) {
  const viewport = useViewport()
  const [measureRef, height] = useMeasuredHeight()
  const ref = useCallback((el: HTMLDivElement | null) => { panelRef.current = el; measureRef(el) }, [panelRef, measureRef])
  const mode = rect ? 'anchored' : 'chip'
  const [settledMode, setSettledMode] = useState(mode)
  const switching = settledMode !== mode
  useEffect(() => {
    if (!switching) return
    const id = setTimeout(() => setSettledMode(mode), 300)
    return () => clearTimeout(id)
  }, [mode, switching])

  const width = panelWidth(viewport.width)
  const place = rect ? popoverPlacement(rect, viewport, height, obstacles, reserved, text) : null
  const style: React.CSSProperties = place
    ? { top: place.top, left: place.left, width: place.width }
    : { width }
  style.maxHeight = Math.max(0, viewport.height - 2 * PANEL_MARGIN)
  return createPortal(
    <motion.div
      ref={ref}
      role="region"
      aria-label={label}
      data-testid="guide-pill"
      data-placement={place ? place.side : 'chip'}
      onFocus={onFocus}
      onBlur={onBlur}
      layout={reduceMotion ? false : 'position'}
      transition={{ layout: { duration: switching ? 0.2 : 0, ease: 'easeOut' } }}
      className={`pointer-events-auto fixed z-[10003] flex flex-col gap-2 overflow-y-auto rounded-xl border border-border bg-card px-3 py-2.5 text-[13px] text-text shadow-lg ${place ? '' : 'left-safe right-safe bottom-safe-offset-4 mx-auto'}`}
      style={style}
    >
      {children}
    </motion.div>,
    document.body,
  )
}

const ARROW_ICONS = { up: ArrowUp, down: ArrowDown, left: ArrowLeft, right: ArrowRight } as const
/** The arrow's nudge toward the target. */
const ARROW_NUDGE: Record<ArrowDir, { x?: number[]; y?: number[] }> = { up: { y: [0, ARROW_TRAVEL, 0] }, down: { y: [0, -ARROW_TRAVEL, 0] }, left: { x: [0, ARROW_TRAVEL, 0] }, right: { x: [0, -ARROW_TRAVEL, 0] } }

function GuideArrow({ rect, obstacles, reduceMotion }: { rect: GuideRect; obstacles: readonly Box[]; reduceMotion: boolean }) {
  const place = arrowPlacement(rect, { width: window.innerWidth, height: window.innerHeight }, obstacles)
  const Icon = ARROW_ICONS[place.dir]
  return (
    <>
      <div
        aria-hidden="true"
        data-testid="guide-target-outline"
        className="pointer-events-none fixed z-[10002] rounded-md border-2 border-accent"
        style={{ top: rect.top - 4, left: rect.left - 4, width: rect.width + 8, height: rect.height + 8 }}
      />
      <motion.div
        aria-hidden="true"
        data-testid="guide-arrow"
        data-arrow-dir={place.dir}
        className="pointer-events-none fixed z-[10002] text-accent"
        style={{ top: place.top, left: place.left, width: ARROW, height: ARROW }}
        animate={reduceMotion ? undefined : ARROW_NUDGE[place.dir]}
        transition={reduceMotion ? undefined : { duration: 1.2, repeat: Infinity, ease: 'easeInOut' }}
      >
        <Icon size={ARROW} strokeWidth={2.5} />
      </motion.div>
    </>
  )
}

const REFUSAL_KEYS: Record<GuideActionRefusal, string> = {
  unknown_action: 'components.guideLayer.refused_unknown_action',
  invalid_params: 'components.guideLayer.refused_invalid_params',
  unknown_setting: 'components.guideLayer.refused_unknown_setting',
  sensitive_setting: 'components.guideLayer.refused_sensitive_setting',
}

/** Where the finish chip's way back leads: the chat the guide was offered in. */
export type GuideReturn = { kind: 'captain'; to: string } | { kind: 'chat'; to: string }

/**
 * A crewmate thread's slot key (`member-<slug>`, or `member-<slug>.memory-<store>`
 * once the crewmate has a private memory store) -> that slug; anything else
 * -> null. Mirrors the gateway's `member_slot_key` (members.py): the prefix,
 * the slug pattern, and the store suffix that belongs to the SLOT, not the slug.
 */
const MEMBER_SLOT_KEY = /^member-([a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?)(?:\.memory-.+)?$/
export function memberSlugOfSlot(slotKey: string): string | null {
  return MEMBER_SLOT_KEY.exec(slotKey)?.[1] ?? null
}

/**
 * Whether a chat slot's agent is Captain. The slot names its agent by key: a
 * member key or a template name. `kirocrew-captain` is Captain's reserved
 * member key AND its singleton template, so the name alone identifies
 * Captain unless the roster has a member under that key bound to another
 * template (then it is that member, never Captain).
 */
export function isCaptainChatSlot(
  slot: Pick<ChatSlot, 'agent' | 'agent_kind'> | null | undefined,
  rows: readonly MemberRosterRow[] | undefined,
): boolean {
  if (!slot || slot.agent !== ASSISTANT_KIRO_AGENT) return false
  if (slot.agent_kind === 'template') return true
  const row = rows?.find(r => r.name === slot.agent)
  return row ? isAssistantMember(row) : true
}

const toMember = (name: string): GuideReturn => ({ kind: 'chat', to: `/members?member=${encodeURIComponent(name)}` })

/**
 * The way back to *slotKey*'s chat once its guide ended. Captain's thread when
 * the slot is Captain's (identified by key AND template, never by name);
 * another crewmate's thread when it is theirs; else the chat page on that
 * slot.
 *
 * A crewmate thread never leads to the chat page, which does not show those
 * slots: when the roster has no row bound to the slot (it failed to load, or
 * the binding moved on), the crewmate is read from the slot key itself.
 * Captain's slug is its reserved key, so Captain's thread is known from the
 * key alone, before any roster. Otherwise `null` while the roster is still
 * unknown, so the label never flips from "chat" to Captain's name under the
 * user's pointer.
 */
export function guideReturnFor(
  slotKey: string,
  rows: readonly MemberRosterRow[] | undefined,
  rosterFailed: boolean,
  slot?: Pick<ChatSlot, 'agent' | 'agent_kind'> | null,
): GuideReturn | null {
  if (!slotKey) return null
  const bound = rows?.find(r => !!r.slot_key && r.slot_key === slotKey)
  if (bound) return isAssistantMember(bound) ? { kind: 'captain', to: CAPTAIN_ROUTE } : toMember(bound.name)
  // An ordinary chat slot whose agent is Captain (a Captain chat opened from
  // the sessions list): its way back is that chat, worded as Captain's.
  if (isCaptainChatSlot(slot, rows)) return { kind: 'captain', to: `/chat?slot=${encodeURIComponent(slotKey)}` }
  const slug = memberSlugOfSlot(slotKey)
  if (slug !== null) {
    // The page opens a crewmate by exact name; the slug is lossy, so a name is
    // used only when exactly one row carries this slug.
    const bySlug = rows?.filter(r => r.slug === slug) ?? []
    if (bySlug.length === 1) return isAssistantMember(bySlug[0]) ? { kind: 'captain', to: CAPTAIN_ROUTE } : toMember(bySlug[0].name)
    if (slug === ASSISTANT_MEMBER_NAME) return { kind: 'captain', to: CAPTAIN_ROUTE }
  }
  if (!rows && !rosterFailed) return null
  // A member slot no roster row names: the page answers a gone crewmate itself.
  if (slug !== null) return toMember(slug)
  return { kind: 'chat', to: `/chat?slot=${encodeURIComponent(slotKey)}` }
}

/**
 * Matches the in-chat offer card's 44px controls (GuideOfferCard). The negative
 * margins let the hit area reach into the panel's padding, so the header row
 * stays one text line tall beside it.
 */
const TOUCH_CLOSE = 'min-h-11 min-w-11 -my-2.5 -mr-2 inline-flex items-center justify-center'

function PillHead({ title, onClose, closeLabel, closeClassName = '', titleRef }: {
  title: string
  onClose?: () => void
  closeLabel: string
  closeClassName?: string
  titleRef?: React.Ref<HTMLSpanElement>
}) {
  return (
    <div className={`flex gap-2 ${closeClassName ? 'items-center' : 'items-start'}`}>
      <Compass size={16} className={`shrink-0 text-accent ${closeClassName ? '' : 'mt-0.5'}`} aria-hidden="true" />
      <span
        ref={titleRef}
        tabIndex={titleRef ? -1 : undefined}
        data-testid={titleRef ? 'guide-finished-title' : undefined}
        className="min-w-0 flex-1 font-semibold text-text-strong rounded-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {title}
      </span>
      {onClose && (
        <IconButton aria-label={closeLabel} title={closeLabel} onClick={onClose} className={`shrink-0 ${closeClassName}`} data-testid={closeClassName ? 'guide-finished-close' : undefined}>
          <X size={14} aria-hidden="true" />
        </IconButton>
      )}
    </div>
  )
}

/**
 * Whether the current step is the guide's last one: the last step of its last
 * action. Its acknowledge button reads Done instead of Next, because nothing
 * follows it. Done only ends the guide; it never stands for the change the
 * step asked for.
 */
export function isFinalGuideStep(view: GuideView): boolean {
  if (!view.resolved.ok || !view.action) return false
  return view.guide.action_index === view.resolved.actions.length - 1
    && view.guide.step_index === view.action.steps.length - 1
}

function ActiveStep({ view, rect }: { view: GuideView; rect: GuideRect | null }) {
  const { t } = useTranslation()
  const ctx = useGuide()!
  const step = view.step!
  const waiting = step.complete.kind === 'committed' && ctx.submitted && !rect
  return (
    <>
      <p className="m-0" aria-live="polite" data-testid="guide-step-text">
        {waiting ? t('components.guideLayer.waiting_for_confirmation') : t(step.textKey)}
      </p>
      {!rect && !waiting && (
        // Retries exhausted: the wait will not end by itself, so say the guide
        // stopped (with the way back below) instead of spinning forever.
        ctx.stalled
          ? <p className="m-0 text-muted" role="status">{t('components.guideLayer.target_missing')}</p>
          : (
            <p className="m-0 flex items-center gap-1.5 text-muted" role="status">
              <Loader2 size={13} className="animate-spin" aria-hidden="true" /> {t('components.guideLayer.looking_for_control')}
            </p>
          )
      )}
      {ctx.submitted && <p className="m-0 text-[12px] text-muted">{t('components.guideLayer.cancel_does_not_undo')}</p>}
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Btn onClick={() => ctx.cancel()} disabled={ctx.busy}>{t('components.guideLayer.cancel_guide')}</Btn>
        {step.complete.kind === 'ack' && (
          <Btn primary onClick={() => ctx.report('observed')} disabled={!rect} data-testid="guide-next">
            {isFinalGuideStep(view) ? t('components.meetCrewmatesFlow.done') : t('components.guideLayer.next')}
          </Btn>
        )}
        {/* The reports for this step ran out of retries while the control is
            absent: the wait cannot end by itself, so offer the way back,
            which also starts the reports again. */}
        {!rect && !waiting && ctx.stalled && (
          <Btn primary onClick={ctx.returnToStep} disabled={ctx.busy} data-testid="guide-go-back">{t('components.guideLayer.go_back_to_step')}</Btn>
        )}
      </div>
    </>
  )
}

/**
 * Cancel, and the way back to the current step's page, for a step the user is
 * not on (it left its page, or its target went missing). The way back is the
 * action's own enter plan; arriving there resumes the step by itself.
 */
function StepReturnButtons() {
  const { t } = useTranslation()
  const ctx = useGuide()!
  return (
    <div className="flex flex-wrap items-center justify-end gap-2">
      <Btn onClick={() => ctx.cancel()} disabled={ctx.busy}>{t('components.guideLayer.cancel_guide')}</Btn>
      <Btn primary onClick={ctx.returnToStep} disabled={ctx.busy} data-testid="guide-go-back">{t('components.guideLayer.go_back_to_step')}</Btn>
    </div>
  )
}

export default function GuideLayer() {
  const { t } = useTranslation()
  const ctx = useGuide()
  const reduceMotion = !!useReducedMotion()
  const view = ctx?.view ?? null
  const tracking = !!view && view.ownedHere && !view.needsEnter && !view.leftStep && view.guide.status === 'active' && !!view.step
  // A missing target is watched for, not tracked: once the human is back on
  // the step's page and it shows again, the gateway resumes the same step.
  const recovering = !!view && view.ownedHere && view.guide.status === 'target_missing' && !!view.step
  const stepId = view ? `${view.guide.guide_id}:${view.guide.action_index}:${view.guide.step_index}:${ctx?.trackNonce ?? 0}` : ''
  const rect = useGuideStepTracker({
    stepId,
    step: view?.step ?? null,
    enabled: tracking || recovering,
    recover: recovering,
    suppressMissing: !!ctx?.submitted,
    reduceMotion,
    onObserved: () => ctx?.report('observed'),
    onMissing: () => ctx?.report('target_missing'),
    onFound: (resumeStepIndex) => ctx?.report('target_found', resumeStepIndex),
    earlierSteps: view?.action && view.step ? view.action.steps.slice(0, view.guide.step_index) : undefined,
  })
  const anchor = tracking && view?.step ? rect : null
  // The neighbouring controls the arrow keeps clear of, read from the page as
  // laid out now; the tracker hands back a new rect whenever the target moves.
  // The page can still be moving while the target stays put (a wizard step
  // sliding in after a recovery, a panel expanding), so the boxes the arrow
  // and panel avoid are re-measured on a slow tick too, not only when the
  // target moves; an unchanged measurement keeps the same arrays.
  const [layoutTick, setLayoutTick] = useState(0)
  const anchored = !!anchor
  useEffect(() => {
    if (!anchored) return
    const id = setInterval(() => setLayoutTick(n => n + 1), GUIDE_RELAYOUT_MS)
    return () => clearInterval(id)
  }, [anchored])
  const obstacles = useStableBoxes(useMemo(() => {
    if (!anchor) return NO_BOXES
    const vp = { width: window.innerWidth, height: window.innerHeight }
    return nearbyControlBoxes(anchor, document, Infinity, vp)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anchor, layoutTick]))
  const reserved = useStableBoxes(useMemo(() => (anchor ? pageChromeBoxes({ width: window.innerWidth, height: window.innerHeight }) : NO_BOXES),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [anchor, layoutTick]))
  const text = useStableBoxes(useMemo(() => (anchor ? pageTextBoxes({ width: window.innerWidth, height: window.innerHeight }) : NO_BOXES),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [anchor, layoutTick]))
  const notePageSeen = ctx?.notePageSeen
  const seenTarget = !!rect && tracking
  // Re-run on arrival too: the target can be found in the render before the
  // address settles, when the page does not yet count as the step's.
  const { pathname } = useLocation()
  useEffect(() => { if (seenTarget) notePageSeen?.() }, [seenTarget, stepId, pathname, notePageSeen])
  const [hiddenPendingError, setHiddenPendingError] = useState<string | null>(null)
  // The guide this tab drove has ended. Its result line is in the chat it was
  // offered in, so the chip speaks only while the user is somewhere else, and
  // offers the way back there.
  const viewedSlot = useViewedSlot()
  const finished = ctx?.finished ?? null
  const showFinished = !!finished && finished.slot_key !== viewedSlot
  const roster = useQuery({ ...membersRosterQuery, enabled: showFinished })
  const finishedSlot = useAppSelector(state => (finished ? state.dashboard.slots.find(s => s.key === finished.slot_key) : undefined))
  const captainName = useCaptainName()
  const navigate = useNavigate()
  const guardedLeave = useGuardedLeave()

  // Whether keyboard focus is in the panel, kept as focus moves rather than
  // read when the guide ends: by then the Next or Cancel button that was
  // focused may already have left the DOM. Focus leaving for another element,
  // or a press anywhere outside, clears it; an unmount (no new target) does not.
  const panelEl = useRef<HTMLElement | null>(null)
  const focusInside = useRef(false)
  const focusBefore = useRef<HTMLElement | null>(null)
  const onPanelFocus = useCallback((e: React.FocusEvent<HTMLElement>) => {
    if (!focusInside.current) {
      const from = e.relatedTarget
      focusBefore.current = from instanceof HTMLElement && !panelEl.current?.contains(from) ? from : null
    }
    focusInside.current = true
  }, [])
  const onPanelBlur = useCallback((e: React.FocusEvent<HTMLElement>) => {
    const to = e.relatedTarget
    if (to instanceof Node && !panelEl.current?.contains(to)) focusInside.current = false
  }, [])
  useEffect(() => {
    const down = (e: PointerEvent) => {
      if (e.target instanceof Node && !panelEl.current?.contains(e.target)) focusInside.current = false
    }
    document.addEventListener('pointerdown', down, true)
    return () => document.removeEventListener('pointerdown', down, true)
  }, [])

  // The guide ended while the user was working in the panel: focus follows
  // to the way back, or to the finish line while no way back is known yet.
  // Never pulled in from elsewhere on the page.
  const finishedTitleRef = useRef<HTMLSpanElement>(null)
  const backRef = useRef<HTMLButtonElement>(null)
  const finishKey = showFinished && finished ? `${finished.guide_id}:${finished.status}` : ''
  useEffect(() => {
    if (!finishKey || !focusInside.current) return
    ;(backRef.current ?? finishedTitleRef.current)?.focus()
  }, [finishKey])

  if (!ctx) return null
  const finishedText = showFinished && finished
    ? t(finishedKeyFor(finished.status, finished.reason, 'components.guideLayer.finished_cancelled'))
    : ''
  // Closing the chip hands focus back to where it was before the panel took
  // it, else to the page's main region -- never to the document body.
  const closeFinished = () => {
    const restore = focusInside.current
    const prior = focusBefore.current
    ctx.dismissFinished()
    focusInside.current = false
    if (!restore) return
    const target = prior && prior.isConnected && !(prior as HTMLButtonElement).disabled
      ? prior
      : document.getElementById('main-content')
    target?.focus()
  }

  const label = t('components.guideLayer.region_label')
  const closeLabel = t('components.guideLayer.close')
  const error = (
    <>
      {/* No hand-off: the guide pill floats over the page being guided, whose unsaved form draft the hand-off navigation would discard. */}
      <ErrorNotice variant="inline" className="text-[12px]" message={ctx.error} testId="guide-error" />
    </>
  )

  let body: React.ReactNode = null
  if (!view && ctx.pendingError && ctx.pendingError !== hiddenPendingError) {
    body = (
      <>
        <PillHead title={t('components.guideLayer.title_generic')} onClose={() => setHiddenPendingError(ctx.pendingError)} closeLabel={closeLabel} />
        {/* No hand-off: the pill floats over whatever page is open, whose unsaved draft the hand-off navigation would discard. */}
        <ErrorNotice variant="inline" className="text-[12px]" message={ctx.pendingError} testId="guide-pending-error" />
      </>
    )
  } else if (view) {
    const title = view.action ? t(view.action.titleKey, view.action.titleVars) : t('components.guideLayer.title_generic')
    const g = view.guide
    if (!view.resolved.ok) {
      body = (
        <>
          <PillHead title={t('components.guideLayer.title_generic')} closeLabel={closeLabel} />
          <p className="m-0">{t(REFUSAL_KEYS[view.resolved.reason])}</p>
          {error}
          <div className="flex justify-end"><Btn onClick={() => ctx.cancel()} disabled={ctx.busy}>{t('components.guideLayer.dismiss')}</Btn></div>
        </>
      )
    } else if (g.status === 'target_missing' && view.ownedHere) {
      body = (
        <>
          <PillHead title={title} closeLabel={closeLabel} />
          <p className="m-0" role="status">{view.offStepPage ? t('components.guideLayer.left_step') : t('components.guideLayer.target_missing')}</p>
          {error}
          <StepReturnButtons />
        </>
      )
    } else if (g.status === 'offered') {
      // The offer is the chat's to show (GuideOfferCard in that slot's chat),
      // never a banner over whatever page is open.
      body = null
    } else if (!view.ownedHere) {
      body = (
        <>
          <PillHead title={title} closeLabel={closeLabel} />
          <p className="m-0">{t('components.guideLayer.other_tab')}</p>
          {error}
          <div className="flex flex-wrap justify-end gap-2">
            <Btn onClick={() => ctx.cancel()} disabled={ctx.busy}>{t('components.guideLayer.cancel_guide')}</Btn>
            <Btn primary onClick={ctx.takeOver} disabled={ctx.busy} data-testid="guide-take-over">{t('components.guideLayer.take_over')}</Btn>
          </div>
        </>
      )
    } else if (view.needsEnter) {
      body = (
        <>
          <PillHead title={title} closeLabel={closeLabel} />
          <p className="m-0">{t('components.guideLayer.continue_hint')}</p>
          {error}
          <div className="flex flex-wrap justify-end gap-2">
            <Btn onClick={() => ctx.cancel()} disabled={ctx.busy}>{t('components.guideLayer.cancel_guide')}</Btn>
            <Btn primary onClick={ctx.continueAction} disabled={ctx.busy} data-testid="guide-continue">{t('components.guideLayer.continue')}</Btn>
          </div>
        </>
      )
    } else if (view.leftStep) {
      body = (
        <>
          <PillHead title={title} closeLabel={closeLabel} />
          <p className="m-0" role="status">{t('components.guideLayer.left_step')}</p>
          {error}
          <StepReturnButtons />
        </>
      )
    } else if (view.step) {
      body = (
        <>
          <PillHead title={title} closeLabel={closeLabel} />
          <ActiveStep view={view} rect={rect} />
          {error}
        </>
      )
    }
  }

  let announced = ''
  if (!body && showFinished && finished) {
    announced = finishedText
    const back = guideReturnFor(finished.slot_key, roster.data, roster.isError, finishedSlot)
    const backLabel = back?.kind === 'captain'
      ? t('components.guideLayer.back_to_name', { name: captainName ?? t('components.assistantWelcome.default_name') })
      : t('components.meetCrewmatesFlow.back_to_chat')
    body = (
      <>
        <PillHead
          title={finishedText}
          titleRef={finishedTitleRef}
          onClose={closeFinished}
          closeLabel={closeLabel}
          closeClassName={TOUCH_CLOSE}
        />
        {back && (
          <div className="flex justify-end">
            <Btn
              ref={backRef}
              primary
              className="min-h-11 px-4"
              data-testid="guide-back"
              data-guide-return={back.kind}
              onClick={() => guardedLeave(() => { focusInside.current = false; navigate(back.to); ctx.dismissFinished() }, back.to)}
            >
              {backLabel}
            </Btn>
          </div>
        )}
      </>
    )
  }

  return (
    <>
      {/* One status region for the whole life of the layer, so the end of a
          guide is announced into a region that already exists. Silent on the
          slot's own chat, whose result line announces it instead. */}
      {createPortal(<div role="status" aria-live="polite" className="sr-only" data-testid="guide-finished-status">{announced}</div>, document.body)}
      {body && anchor && createPortal(<GuideArrow rect={anchor} obstacles={obstacles} reduceMotion={reduceMotion} />, document.body)}
      {body && (
        <GuidePanel rect={anchor} obstacles={obstacles} reserved={reserved} text={text} label={label} reduceMotion={reduceMotion} panelRef={panelEl} onFocus={onPanelFocus} onBlur={onPanelBlur}>
          {body}
        </GuidePanel>
      )}
    </>
  )
}
