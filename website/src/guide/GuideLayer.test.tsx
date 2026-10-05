/**
 * Registered-action guide: consent before anything moves, the arrow's target
 * and pointer contract, owner-tab / revision handling, which slot "is being
 * viewed", per-request guide headers on the ONE save a committed step names,
 * that the MCP guide only hands off to the native add form, and that the
 * browser never claims a save succeeded.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Provider } from 'react-redux'
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom'
import { http, HttpResponse } from 'msw'
import { useEffect, useState, type ReactNode } from 'react'
import { server } from '../../integration/mocks/server'
import '../api/client'
import { store } from '../store'
import { setActiveSlot } from '../store/chatSlice'
import { sseSlots } from '../store/dashboardSlice'
import { TAB_ID } from '../api/tabId'
import { NavigationLeaveGuardProvider, useRegisterNavigationLeaveGuard } from '../components/NavigationLeaveGuard'
import { applyGuideUpdate, GUIDE_PENDING_QUERY_KEY, type Guide } from '../api/guide'
import { _resetViewedThreadForTests, setViewedThreadSlot } from '../lib/viewedThread'
import { i18nT } from '../i18n/t'
import { endedBySlot, GuideProvider, reconcilePending, useGuide } from './GuideContext'
import { useGuideOpenedSurface } from './useGuideOpenedSurface'
import GuideLayer, { arrowPlacement, GUIDE_RELAYOUT_MS, guideReturnFor, isCaptainChatSlot, isFinalGuideStep, memberSlugOfSlot, nearbyControlBoxes, pageChromeBoxes, popoverPlacement } from './GuideLayer'
import { CAPTAIN_ROUTE, __setCaptainForTests } from '../lib/captainHandoff'
import GuideOfferCard from './GuideOfferCard'
import { GUIDE_ANCHORS, isSensitiveSetting, resolveGuideAction, resolveGuideActions } from './guideActions'
import { GUIDE_EARLIER_STEP_WAIT_MS, GUIDE_FOUND_MAX_ATTEMPTS, GUIDE_FOUND_RETRY_MS, GUIDE_TARGET_WAIT_MS } from './useGuideStepTracker'
import McpCustomServerModal from '../components/McpCustomServerModal'
import { SETTINGS_REGISTRY } from '../components/commandPalette/settingsRegistry.gen'
import { resolveSettingElementStrict } from '../hooks/useSettingHighlight'

const L = (k: string, v?: Record<string, unknown>) => i18nT(`components.guideLayer.${k}`, v)

type Call = { path: string; body: Record<string, unknown>; headers: Headers }
let calls: Call[]
let pending: Guide[]
/** What each write returns; defaults to echoing the guide the test set. */
let onWrite: (path: string, body: Record<string, unknown>) => Guide | null

const guide = (over: Partial<Guide> = {}): Guide => ({
  guide_id: 'g1',
  slot_key: 'slot-A',
  status: 'offered',
  revision: 1,
  owner_tab: null,
  action_index: 0,
  step_index: 0,
  actions: [{ id: 'crewmate.create', params: { name: 'radar', goal: 'watch the build' } }],
  reason: 'You asked for a crewmate.',
  expires_at: null,
  lease_expires_at: null,
  ...over,
})

const claimed = (g: Guide): Guide => ({ ...g, status: 'active', owner_tab: TAB_ID, revision: g.revision + 1 })

function LocationProbe() {
  const loc = useLocation()
  return <div data-testid="loc" data-granted={(loc.state as { leaveGranted?: boolean } | null)?.leaveGranted ? '1' : '0'}>{loc.pathname + loc.search}</div>
}

/**
 * The native MCP surfaces, reduced to what the guide touches: the Connections
 * tab (starting on Services), McpTab's Add Custom button, and the REAL add
 * dialog. The anchors are the same literals the pages carry (pinned below).
 */
function NativeMcpHost({ startOn = 'services' }: { startOn?: 'services' | 'mcp-servers' }) {
  const [tab, setTab] = useState(startOn)
  const [open, setOpen] = useState(false)
  return (
    <>
      <Target anchor="mcp.servers-tab" testId="native-mcp-tab" onClick={() => setTab('mcp-servers')} />
      {tab === 'mcp-servers' && <Target anchor="mcp.add-custom" testId="native-add-custom" onClick={() => setOpen(true)} />}
      <McpCustomServerModal open={open} onClose={() => setOpen(false)} />
    </>
  )
}

let qc: QueryClient
/** *chatSlot* stands in for the open chat pane, whose conversation holds the
 *  offer's row (guide `g1`, the id every fixture here uses). */
function renderGuide(path: string, extra?: ReactNode, chatSlot: string | null = 'slot-A') {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <Provider store={store}>
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={[path]}>
          <NavigationLeaveGuardProvider>
            <GuideProvider>
              <GuideLayer />
              {chatSlot && <GuideOfferCard guideId="g1" slotKey={chatSlot} />}
              <LocationProbe />
              {extra}
            </GuideProvider>
          </NavigationLeaveGuardProvider>
        </MemoryRouter>
      </QueryClientProvider>
    </Provider>,
  )
}

/** A registered control with a real-looking box (happy-dom lays nothing out). */
function Target({ anchor, rect = { top: 300, left: 100, width: 80, height: 30 }, testId, onClick }: {
  anchor?: string
  rect?: { top: number; left: number; width: number; height: number }
  testId?: string
  onClick?: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-guide-anchor={anchor}
      data-testid={testId ?? `target-${anchor ?? 'none'}`}
      ref={(el) => {
        if (!el) return
        el.getBoundingClientRect = () => ({ ...rect, right: rect.left + rect.width, bottom: rect.top + rect.height, x: rect.left, y: rect.top, toJSON: () => ({}) }) as DOMRect
      }}
    >
      target
    </button>
  )
}

beforeEach(() => {
  calls = []
  pending = []
  onWrite = () => null
  _resetViewedThreadForTests()
  store.dispatch(setActiveSlot('slot-A'))
  server.use(
    http.get('/api/guide/pending', () => HttpResponse.json({ guides: pending })),
    ...['claim', 'progress', 'heartbeat', 'cancel', 'dismiss'].map(name =>
      http.post(`/api/guide/${name}`, async ({ request }) => {
        const body = (await request.json()) as Record<string, unknown>
        calls.push({ path: `/api/guide/${name}`, body, headers: request.headers })
        return HttpResponse.json({ guide: onWrite(name, body) })
      }),
    ),
    http.post('/api/mcp/custom', async ({ request }) => {
      calls.push({ path: '/api/mcp/custom', body: (await request.json()) as Record<string, unknown>, headers: request.headers })
      return HttpResponse.json({ ok: true, added: ['files'], enabled: false })
    }),
  )
})

afterEach(() => {
  vi.restoreAllMocks()
})

const writes = (path: string) => calls.filter(c => c.path === path)

/** A page surface whose draft appears and disappears on cue. */
const draftState = { atStake: false }
function DraftSurface() {
  useRegisterNavigationLeaveGuard(() => !draftState.atStake)
  return null
}

describe('offer and consent', () => {
  it('a draft typed while the claim was out stops the walk to the step page; the guide stays claimed', async () => {
    draftState.atStake = false
    pending = [guide()]
    let release: () => void = () => {}
    server.use(http.post('/api/guide/claim', async ({ request }) => {
      const body = (await request.json()) as Record<string, unknown>
      calls.push({ path: '/api/guide/claim', body, headers: request.headers })
      await new Promise<void>(r => { release = r })
      return HttpResponse.json({ guide: claimed(guide()) })
    }))
    renderGuide('/chat/slot-A', <DraftSurface />)
    fireEvent.click(await screen.findByTestId('guide-start'))
    await waitFor(() => expect(writes('/api/guide/claim')).toHaveLength(1))
    // The user starts typing something while the claim is in flight.
    draftState.atStake = true
    release()
    await new Promise(r => setTimeout(r, 100))
    expect(screen.getByTestId('loc').textContent).toBe('/chat/slot-A')
    draftState.atStake = false
  })

  it('offers the guide only in the chat it came from, and nothing moves before Start', async () => {
    pending = [guide()]
    renderGuide('/chat/slot-A')
    expect(await screen.findByTestId('guide-start')).toBeTruthy()
    // The gateway's internal reason token is never painted as copy.
    expect(screen.queryByText('You asked for a crewmate.')).toBeNull()
    // Offered is not accepted: no claim, no navigation, no pre-fill.
    await new Promise(r => setTimeout(r, 50))
    expect(calls).toHaveLength(0)
    expect(screen.getByTestId('loc').textContent).toBe('/chat/slot-A')
  })

  it('says so when the pending-guides read fails, and can be closed', async () => {
    server.use(http.get('/api/guide/pending', () => HttpResponse.json({ error: 'gateway unavailable' }, { status: 500 })))
    renderGuide('/chat/slot-A')
    expect(await screen.findByTestId('guide-pending-error')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: L('close') }))
    await waitFor(() => expect(screen.queryByTestId('guide-pending-error')).toBeNull())
  })

  it('stays silent when the owner-only pending route refuses this session', async () => {
    server.use(http.get('/api/guide/pending', () => HttpResponse.json({ error: 'owner only' }, { status: 403 })))
    renderGuide('/chat/slot-A')
    await new Promise(r => setTimeout(r, 100))
    expect(screen.queryByTestId('guide-pending-error')).toBeNull()
  })

  it('Start claims first, then navigates to the Crewmates hand-off with the draft', async () => {
    pending = [guide()]
    onWrite = (name, b) => (name === 'claim' ? claimed({ ...guide(), revision: b.revision as number }) : null)
    renderGuide('/chat/slot-A')
    fireEvent.click(await screen.findByTestId('guide-start'))
    await waitFor(() => expect(screen.getByTestId('loc').textContent).toBe('/members?create=1&name=radar&goal=watch+the+build'))
    const [claim] = writes('/api/guide/claim')
    expect(claim.body).toEqual({ guide_id: 'g1', tab_id: TAB_ID, revision: 1 })
    expect(claim.body).not.toHaveProperty('take_over')
  })

  it('reads the Crewmates page thread, not a stale chat activeSlot', async () => {
    pending = [guide({ status: 'active', owner_tab: 'other-tab' })]
    // activeSlot is still slot-A from an earlier chat visit, but on /members
    // the thread on screen is whatever the page registered.
    renderGuide('/members?member=radar', undefined, null)
    await act(async () => { await qc.refetchQueries({ queryKey: GUIDE_PENDING_QUERY_KEY }) })
    expect(screen.queryByTestId('guide-pill')).toBeNull()
    act(() => setViewedThreadSlot('slot-B'))
    expect(screen.queryByTestId('guide-pill')).toBeNull()
    act(() => setViewedThreadSlot('slot-A'))
    expect(await screen.findByText(L('other_tab'))).toBeTruthy()
  })

  it('keeps the members address when entering from the Crewmates page', () => {
    const r = resolveGuideAction({ id: 'crewmate.create', params: { goal: 'g' } })
    if (!r.ok || r.action.enter.kind !== 'navigate') throw new Error('expected navigate')
    expect(r.action.enter.to({ pathname: '/members', search: '?member=default' })).toBe('/members?member=default&create=1&goal=g')
  })
})

async function startCrewmate(extra?: ReactNode, over: Partial<Guide> = {}) {
  pending = [guide(over)]
  let current = claimed(guide(over))
  onWrite = (name, b) => {
    if (name === 'claim') return current
    if (name === 'progress') {
      current = { ...current, revision: current.revision + 1, step_index: (b.step_index as number) + (b.outcome === 'observed' ? 1 : 0), status: b.outcome === 'observed' ? 'active' : 'target_missing' }
      return current
    }
    return current
  }
  renderGuide('/chat/slot-A', extra)
  fireEvent.click(await screen.findByTestId('guide-start'))
  await waitFor(() => expect(screen.getByTestId('loc').textContent).toContain('/members'))
  return () => current
}

describe('arrow and targets', () => {
  it('points at the registered control without a scrim or pointer capture, and follows it', async () => {
    const rect = { top: 300, left: 100, width: 80, height: 30 }
    await startCrewmate(<Target anchor={GUIDE_ANCHORS.crewmateGoalNext} rect={rect} />)
    const outline = await screen.findByTestId('guide-target-outline')
    const arrow = screen.getByTestId('guide-arrow')
    for (const el of [outline, arrow]) {
      expect(el.className).toContain('pointer-events-none')
      expect(el.getAttribute('aria-hidden')).toBe('true')
    }
    // No element of the layer covers the viewport.
    expect(document.body.querySelector('.inset-0')).toBeNull()
    // The step panel floats next to the control, opposite the arrow (the arrow
    // is above this target, so the panel is below it), and takes no layout space.
    const panel = screen.getByTestId('guide-pill')
    expect(panel.className).toContain('fixed')
    expect(panel.parentElement).toBe(document.body)
    expect(panel.className).toContain('pointer-events-auto')
    expect(panel.getAttribute('data-placement')).toBe('opposite')
    expect(arrowPlacement(rect, { width: window.innerWidth, height: window.innerHeight }).up).toBe(false)
    expect(panel.style.top).toBe('340px')
    expect(panel).toContainElement(screen.getByTestId('guide-step-text'))
    expect(outline.style.top).toBe('296px')
    // The page underneath still gets its click.
    const onClick = vi.fn()
    screen.getByTestId(`target-${GUIDE_ANCHORS.crewmateGoalNext}`).addEventListener('click', onClick)
    fireEvent.click(screen.getByTestId(`target-${GUIDE_ANCHORS.crewmateGoalNext}`))
    expect(onClick).toHaveBeenCalled()
    // Scrolling re-measures the same control, and the panel follows it.
    rect.top = 420
    act(() => { window.dispatchEvent(new Event('scroll')) })
    await waitFor(() => expect(screen.getByTestId('guide-target-outline').style.top).toBe('416px'))
    expect(screen.getByTestId('guide-pill').style.top).toBe('460px')
    expect(screen.getByTestId('guide-pill')).toBe(panel)
  })

  describe('the step panel on a real page', () => {
    /** An element with a real-looking box (happy-dom lays nothing out). */
    const boxed = (r: { top: number; left: number; width: number; height: number }) => (el: HTMLElement | null) => {
      if (el) el.getBoundingClientRect = () => ({ ...r, right: r.left + r.width, bottom: r.top + r.height, x: r.left, y: r.top, toJSON: () => ({}) }) as DOMRect
    }
    let restoreHeight: () => void
    beforeEach(() => {
      const desc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight')
      Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
        configurable: true,
        get(this: HTMLElement) { return this.getAttribute('data-testid') === 'guide-pill' ? 120 : 0 },
      })
      restoreHeight = () => { if (desc) Object.defineProperty(HTMLElement.prototype, 'offsetHeight', desc) }
    })
    afterEach(() => restoreHeight())
    const pillTop = () => Number.parseFloat(screen.getByTestId('guide-pill').style.top)

    it('keeps clear of a control far from the target, not only the ones by the arrow', async () => {
      // The default target sits at 300..330; the row below the panel's first spot is outside the arrow's reach.
      await startCrewmate(<>
        <Target anchor={GUIDE_ANCHORS.crewmateGoalNext} />
        <button type="button" ref={boxed({ top: 400, left: 0, width: 1024, height: 40 })}>row</button>
      </>)
      await screen.findByTestId('guide-target-outline')
      await waitFor(() => expect(screen.getByTestId('guide-pill').getAttribute('data-placement')).toBe('beyond-arrow'))
      expect(pillTop()).toBe(140)
    })

    it('never covers the page chrome: the top bar and a sticky back bar', async () => {
      await startCrewmate(
        <main id="main-content" ref={boxed({ top: 42, left: 0, width: 1024, height: 726 })}>
          <div className="sticky top-0" ref={boxed({ top: 42, left: 0, width: 1024, height: 108 })} />
          <Target anchor={GUIDE_ANCHORS.crewmateGoalNext} rect={{ top: 200, left: 100, width: 80, height: 30 }} />
          <button type="button" ref={boxed({ top: 250, left: 0, width: 1024, height: 40 })}>row</button>
        </main>,
      )
      await screen.findByTestId('guide-target-outline')
      // Above the arrow would be the bar; below the target, the row: just past the row instead.
      await waitFor(() => expect(screen.getByTestId('guide-pill').getAttribute('data-placement')).toBe('past-controls'))
      expect(pillTop()).toBe(296)
    })
  })

  it('floats a bottom chip, not a top bar, while no target is tracked', async () => {
    await startCrewmate(<Target testId="meet-crewmates-next" />)
    const panel = await screen.findByTestId('guide-pill')
    expect(await screen.findByText(L('looking_for_control'))).toBeTruthy()
    expect(panel.getAttribute('data-placement')).toBe('chip')
    expect(panel.parentElement).toBe(document.body)
    expect(panel.className).toContain('fixed')
    expect(panel.className).toContain('bottom-safe-offset-4')
    expect(panel.style.top).toBe('')
    expect(screen.queryByTestId('guide-arrow')).toBeNull()
  })

  it('reports observed once the form reaches a later registered control', async () => {
    await startCrewmate(<><Target anchor={GUIDE_ANCHORS.crewmateGoalNext} /><Target anchor={GUIDE_ANCHORS.crewmateNameNext} /></>)
    await waitFor(() => expect(writes('/api/guide/progress').length).toBeGreaterThan(0))
    const [first] = writes('/api/guide/progress')
    expect(first.body).toMatchObject({ guide_id: 'g1', tab_id: TAB_ID, action_index: 0, step_index: 0, outcome: 'observed' })
  })

  it('reports target_missing after the bounded wait and never points at a look-alike', async () => {
    // An unregistered button that looks like the step's Next is not a target.
    await startCrewmate(<Target testId="meet-crewmates-next" />)
    // Let the tracker start its wait, then move the clock past the bound.
    await new Promise(r => setTimeout(r, 300))
    expect(writes('/api/guide/progress')).toHaveLength(0)
    const t0 = Date.now()
    vi.spyOn(Date, 'now').mockImplementation(() => t0 + GUIDE_TARGET_WAIT_MS + 1000)
    await waitFor(() => expect(writes('/api/guide/progress').map(c => c.body.outcome)).toEqual(['target_missing']))
    expect(screen.queryByTestId('guide-arrow')).toBeNull()
    expect(await screen.findByText(L('target_missing'))).toBeTruthy()
  })

  it('places the arrow below a control at the top edge and keeps it on screen', () => {
    expect(arrowPlacement({ top: 4, left: 0, width: 10, height: 10 }, { width: 320, height: 600 })).toMatchObject({ up: true, left: 4 })
    const p = arrowPlacement({ top: 300, left: 310, width: 20, height: 20 }, { width: 320, height: 600 })
    expect(p.up).toBe(false)
    expect(p.left).toBeLessThanOrEqual(320 - 24 - 4)
  })

  describe('the arrow keeps clear of the outline and the neighbouring controls', () => {
    type B = { top: number; left: number; bottom: number; right: number }
    const arrowBox = (a: { top: number; left: number }): B => ({ top: a.top, left: a.left, bottom: a.top + 24, right: a.left + 24 })
    /** Smallest distance between two boxes (0 when they touch or overlap). */
    const dist = (a: B, b: B) => Math.max(0, Math.max(a.left - b.right, b.left - a.right), Math.max(a.top - b.bottom, b.top - a.bottom))
    const outlineOf = (r: { top: number; left: number; width: number; height: number }): B =>
      ({ top: r.top - 4, left: r.left - 4, bottom: r.top + r.height + 4, right: r.left + r.width + 4 })

    // Settings > Display > Theme, measured on a pod (the Mode row is the target).
    it.each([
      ['desktop', { width: 1440, height: 900 }, { top: 256.7, left: 532, width: 884, height: 102.9 },
        [{ top: 202.7, left: 532, bottom: 240.7, right: 1416 }, { top: 373.6, left: 532, bottom: 403.8, right: 638 }, { top: 270.6, left: 288, bottom: 306.7, right: 508 }]],
      ['390px phone', { width: 390, height: 844 }, { top: 230.4, left: 16, width: 358, height: 102.9 },
        [{ top: 176.4, left: 16, bottom: 214.4, right: 374 }, { top: 347.3, left: 16, bottom: 377.4, right: 122 }]],
    ] as const)('%s Mode row under the Theme dropdown', (_name, vp, rect, controls) => {
      const a = arrowPlacement(rect, vp, controls)
      const box = arrowBox(a)
      expect(dist(box, outlineOf(rect))).toBeGreaterThanOrEqual(6)
      for (const c of controls) expect(dist(box, c)).toBeGreaterThanOrEqual(6)
      // The nudge moves the arrow 4px away from the target: the box it sweeps
      // keeps the same distance from every neighbour, not only its rest spot.
      const swept: B = {
        top: box.top - (a.dir === 'down' ? 4 : 0), left: box.left - (a.dir === 'right' ? 4 : 0),
        bottom: box.bottom + (a.dir === 'up' ? 4 : 0), right: box.right + (a.dir === 'left' ? 4 : 0),
      }
      for (const c of controls) expect(dist(swept, c)).toBeGreaterThanOrEqual(6)
      expect(a.dir).toBe('up')
      // The panel still never covers the target or the arrow.
      const p = popoverPlacement(rect, vp, 120, controls)
      const pb = { top: p.top, left: p.left, bottom: p.top + 120, right: p.left + p.width }
      expect(dist(pb, box)).toBeGreaterThan(0)
      expect(dist(pb, outlineOf(rect))).toBeGreaterThan(0)
    })

    it('keeps the nudge animation clear of a neighbour that sits exactly at the gap', () => {
      // No room above, so the arrow goes below the target; a full-width control
      // 6px under the arrow's REST spot is only 2px away at the nudge's peak.
      const vp = { width: 400, height: 600 }
      const rect = { top: 10, left: 150, width: 100, height: 40 }
      const below = arrowPlacement(rect, vp)
      const neighbour = { top: below.top + 24 + 6, left: 0, bottom: below.top + 24 + 40, right: 400 }
      const a = arrowPlacement(rect, vp, [neighbour])
      const box = arrowBox(a)
      const swept: B = {
        top: box.top - (a.dir === 'down' ? 4 : 0), left: box.left - (a.dir === 'right' ? 4 : 0),
        bottom: box.bottom + (a.dir === 'up' ? 4 : 0), right: box.right + (a.dir === 'left' ? 4 : 0),
      }
      expect(dist(swept, neighbour)).toBeGreaterThanOrEqual(6)
    })

    // Every control on screen at Settings > Display > Theme, measured on a pod,
    // minus the Mode row's own segmented buttons (parts of the target).
    const DESK_CONTROLS = {
      themeDropdown: { top: 202.7, left: 532, bottom: 240.7, right: 1416 },
      newTheme: { top: 373.6, left: 532, bottom: 403.8, right: 638 },
      installSource: { top: 446.3, left: 532, bottom: 484.3, right: 672 },
      installUrl: { top: 446.3, left: 680, bottom: 484.3, right: 1343 },
      install: { top: 446.3, left: 1351, bottom: 484.3, right: 1416 },
      subnavTheme: { top: 232.4, left: 288, bottom: 268.6, right: 508 },
      subnavSidebar: { top: 270.6, left: 288, bottom: 306.7, right: 508 },
      commandBar: { top: 7, left: 559.6, bottom: 35, right: 842.4 },
      navNotifications: { top: 351.9, left: 86, bottom: 388, right: 261 },
      navShortcuts: { top: 390, left: 86, bottom: 426.2, right: 261 },
    }
    const PHONE_CONTROLS = {
      menu: { top: 1, left: 8, bottom: 41, right: 48 },
      bell: { top: 7, left: 350, bottom: 35, right: 378 },
      back: { top: 42, left: 10, bottom: 79.7, right: 93 },
      themeDropdown: { top: 176.4, left: 16, bottom: 214.4, right: 374 },
      newTheme: { top: 347.3, left: 16, bottom: 377.4, right: 122 },
      installSource: { top: 420, left: 16, bottom: 458, right: 156 },
      installUrl: { top: 420, left: 164, bottom: 458, right: 301 },
      install: { top: 420, left: 309, bottom: 458, right: 374 },
    }
    it.each([
      ['desktop', { width: 1440, height: 900 }, { top: 256.7, left: 532, width: 884, height: 102.9 }, DESK_CONTROLS, { top: 0, left: 0, bottom: 42, right: 1440 }],
      ['390px phone', { width: 390, height: 844 }, { top: 230.4, left: 16, width: 358, height: 102.9 }, PHONE_CONTROLS, { top: 0, left: 0, bottom: 79.7, right: 390 }],
    ] as const)('%s: the panel covers no control, the header, the target or the arrow', (_n, vp, rect, controls, chrome) => {
      const list = Object.values(controls)
      const H = 127
      const p = popoverPlacement(rect, vp, H, list, [chrome])
      const pb = { top: p.top, left: p.left, bottom: p.top + H, right: p.left + p.width }
      const over = (a: B, b: B) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom
      for (const [name, c] of Object.entries(controls)) expect(over(pb, c), name).toBe(false)
      expect(over(pb, chrome), 'header').toBe(false)
      expect(over(pb, outlineOf(rect)), 'target').toBe(false)
      expect(over(pb, arrowBox(arrowPlacement(rect, vp, list))), 'arrow').toBe(false)
      expect(pb.top).toBeGreaterThanOrEqual(8)
      expect(pb.bottom).toBeLessThanOrEqual(vp.height - 8)
      expect(p.side).toBe('past-controls')
    })

    it('with no clear spot, covers the least control area and never the target, arrow or header', () => {
      const vp = { width: 390, height: 500 }
      const rect = { top: 200, left: 16, width: 358, height: 100 }
      // Controls filling every free band of the viewport.
      const controls = [
        { top: 90, left: 16, bottom: 180, right: 374 },
        { top: 340, left: 16, bottom: 400, right: 374 },
        { top: 410, left: 16, bottom: 420, right: 374 },
      ]
      const chrome = { top: 0, left: 0, bottom: 80, right: 390 }
      const H = 100
      const p = popoverPlacement(rect, vp, H, controls, [chrome])
      const pb = { top: p.top, left: p.left, bottom: p.top + H, right: p.left + p.width }
      const area = (a: B, b: B) => Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top))
      expect(area(pb, chrome)).toBe(0)
      expect(area(pb, outlineOf(rect))).toBe(0)
      expect(area(pb, arrowBox(arrowPlacement(rect, vp, controls)))).toBe(0)
      // Below the arrow (334..) every spot covers part of the two lower controls;
      // the one chosen covers less than the plain spot under the arrow.
      const covered = controls.reduce((n, c) => n + area(pb, c), 0)
      expect(covered).toBeGreaterThan(0)
      const plain = { top: 340, left: 8, bottom: 440, right: 382 }
      expect(covered).toBeLessThan(controls.reduce((n, c) => n + area(plain, c), 0))
    })

    it('covers a control before the header, and either before the target', () => {
      const vp = { width: 390, height: 844 }
      // A tall target with a row under it: only the header and the row are left.
      const rect = { top: 150, left: 16, width: 358, height: 450 }
      const row = { top: 610, left: 0, bottom: 836, right: 390 }
      const chrome = { top: 0, left: 0, bottom: 80, right: 390 }
      const p = popoverPlacement(rect, vp, 100, [row], [chrome])
      const pb = { top: p.top, left: p.left, bottom: p.top + 100, right: p.left + p.width }
      const over = (a: B, b: B) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom
      expect(over(pb, chrome)).toBe(false)
      expect(over(pb, outlineOf(rect))).toBe(false)
      expect(over(pb, row)).toBe(true)
    })

    it('reads the page chrome: the top bar and a sticky bar pinned to the main region', () => {
      const doc = document.implementation.createHTMLDocument('x')
      const rectOf = (r: { top: number; left: number; width: number; height: number }) => () =>
        ({ ...r, bottom: r.top + r.height, right: r.left + r.width, x: r.left, y: r.top, toJSON: () => r }) as DOMRect
      const main = doc.createElement('main')
      main.id = 'main-content'
      main.getBoundingClientRect = rectOf({ top: 42, left: 0, width: 390, height: 802 })
      const bar = doc.createElement('div')
      bar.className = 'sticky top-0'
      bar.getBoundingClientRect = rectOf({ top: 42, left: 0, width: 390, height: 37.7 })
      const lower = doc.createElement('div')
      lower.className = 'sticky'
      lower.getBoundingClientRect = rectOf({ top: 400, left: 0, width: 390, height: 40 })
      main.append(bar, lower)
      doc.body.append(main)
      expect(pageChromeBoxes({ width: 390, height: 844 }, doc)).toEqual([{ top: 0, left: 0, bottom: 79.7, right: 390 }])
      bar.remove()
      expect(pageChromeBoxes({ width: 390, height: 844 }, doc)).toEqual([{ top: 0, left: 0, bottom: 42, right: 390 }])
    })

    it('keeps GAP from the outline itself with no neighbours', () => {
      const rect = { top: 300, left: 600, width: 100, height: 30 }
      const a = arrowPlacement(rect, { width: 1440, height: 900 })
      expect(a).toMatchObject({ dir: 'down', top: 300 - 4 - 6 - 24 })
    })

    it('slides along the target, then goes beside it, before giving up', () => {
      const vp = { width: 1440, height: 900 }
      const rect = { top: 300, left: 400, width: 400, height: 40 }
      // Both vertical sides blocked at the centre only: slide to a clear column.
      const mid = [{ top: 250, left: 560, bottom: 290, right: 640 }, { top: 350, left: 560, bottom: 400, right: 640 }]
      const slid = arrowPlacement(rect, vp, mid)
      expect(slid.dir).toBe('down')
      expect(slid.left + 24 + 6 <= 560 || slid.left >= 640 + 6).toBe(true)
      // Both vertical sides blocked along the whole span: point from the side.
      const full = [{ top: 250, left: 380, bottom: 290, right: 820 }, { top: 350, left: 380, bottom: 400, right: 820 }]
      expect(arrowPlacement(rect, vp, full)).toMatchObject({ dir: 'left', left: 800 + 10 })
    })

    it('reads the nearby controls from the page, not the target, its parts or the guide panel', () => {
      const host = document.createElement('div')
      const mk = (tag: string, r: { top: number; left: number; width: number; height: number }, attrs: Record<string, string> = {}) => {
        const el = document.createElement(tag)
        for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v)
        el.getBoundingClientRect = () => ({ ...r, bottom: r.top + r.height, right: r.left + r.width, x: r.left, y: r.top, toJSON: () => r }) as DOMRect
        return el
      }
      const target = { top: 257, left: 531, width: 886, height: 104 }
      host.append(
        mk('button', { top: 203, left: 532, width: 884, height: 38 }),
        mk('button', { top: 300, left: 540, width: 70, height: 30 }),
        mk('button', { top: 600, left: 540, width: 70, height: 30 }),
      )
      const pill = mk('div', { top: 100, left: 600, width: 300, height: 200 }, { 'data-testid': 'guide-pill' })
      pill.append(mk('button', { top: 230, left: 610, width: 60, height: 30 }))
      host.append(pill)
      expect(nearbyControlBoxes(target, host)).toEqual([{ top: 203, left: 532, bottom: 241, right: 1416 }])
    })
  })

  describe('popoverPlacement', () => {
    const desk = { width: 1440, height: 900 }
    const phone = { width: 390, height: 844 }
    const H = 120
    type R = { top: number; left: number; width: number; height: number }
    const box = (r: R) => ({ top: r.top, left: r.left, bottom: r.top + r.height, right: r.left + r.width })
    const hits = (a: ReturnType<typeof box>, b: ReturnType<typeof box>) =>
      a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom
    /** The target outline plus the arrow: what the panel must never cover. */
    const guarded = (rect: R, vp: { width: number; height: number }) => {
      const a = arrowPlacement(rect, vp)
      return [
        box({ top: rect.top - 4, left: rect.left - 4, width: rect.width + 8, height: rect.height + 8 }),
        box({ top: a.top, left: a.left, width: 24, height: 24 }),
      ]
    }
    const panelBox = (p: { top: number; left: number; width: number }) => box({ top: p.top, left: p.left, width: p.width, height: H })
    const inside = (p: { top: number; left: number; width: number }, vp: { width: number; height: number }) =>
      p.left >= 8 && p.top >= 8 && p.left + p.width <= vp.width - 8 && p.top + H <= vp.height - 8

    it('sits opposite the arrow: below a target whose arrow is above it', () => {
      const rect = { top: 400, left: 600, width: 100, height: 30 }
      expect(arrowPlacement(rect, desk).up).toBe(false)
      const p = popoverPlacement(rect, desk, H)
      expect(p.side).toBe('opposite')
      expect(p.top).toBeGreaterThanOrEqual(rect.top + rect.height)
    })

    it('sits past the arrow, never on the control, when a top-edge control has its arrow below it', () => {
      // A control at the viewport top: the arrow goes below it and there is no
      // room above, so the panel goes past the arrow instead of onto the control.
      const top = { top: 10, left: 600, width: 100, height: 30 }
      const a = arrowPlacement(top, desk)
      expect(a.up).toBe(true)
      const p = popoverPlacement(top, desk, H)
      expect(p.side).toBe('beyond-arrow')
      expect(p.top).toBeGreaterThanOrEqual(a.top + 24)
    })

    it('goes above the target when the arrow is above but there is no room below', () => {
      const rect = { top: 820, left: 600, width: 100, height: 30 }
      const p = popoverPlacement(rect, desk, H)
      expect(p.side).toBe('beyond-arrow')
      expect(p.top + H).toBeLessThanOrEqual(arrowPlacement(rect, desk).top)
    })

    it('covers a heading before a field label, however small the label', () => {
      const rect = { top: 400, left: 600, width: 100, height: 30 }
      const first = panelBox(popoverPlacement(rect, desk, H))
      // A full-width label row where the panel would go, and big headings
      // everywhere else: by area the label is cheaper, but hiding it is worse.
      const label = { top: first.top, left: 0, bottom: first.top + 14, right: 1440, weight: 3 }
      const above = { top: 0, left: 0, bottom: first.top - 1, right: 1440, weight: 1 }
      const below = { top: first.top + 15, left: 0, bottom: 900, right: 1440, weight: 1 }
      const p = panelBox(popoverPlacement(rect, desk, H, [], [], [label, above, below]))
      const hit = (a: typeof label, b: typeof label) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom
      expect(hit(p, label)).toBe(false)
    })

    it('keeps off a field label when it has a free spot', () => {
      const rect = { top: 400, left: 600, width: 100, height: 30 }
      const first = panelBox(popoverPlacement(rect, desk, H))
      const label = { top: first.top, left: first.left, bottom: first.top + 14, right: first.left + 60 }
      const moved = panelBox(popoverPlacement(rect, desk, H, [], [], [label]))
      const hit = (a: typeof label, b: typeof label) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom
      expect(hit(moved, label)).toBe(false)
    })

    it('centres on the target and clamps to the viewport by 8px', () => {
      expect(popoverPlacement({ top: 400, left: 600, width: 100, height: 30 }, desk, H)).toMatchObject({ left: 650 - 160, width: 320 })
      expect(popoverPlacement({ top: 400, left: 0, width: 20, height: 20 }, desk, H).left).toBe(8)
      expect(popoverPlacement({ top: 400, left: 1420, width: 20, height: 20 }, desk, H).left).toBe(1440 - 320 - 8)
    })

    it('spans a phone viewport minus its margins', () => {
      expect(popoverPlacement({ top: 400, left: 300, width: 60, height: 30 }, phone, H)).toMatchObject({ left: 8, width: 390 - 16 })
    })

    it('goes beside the target, then to a clear corner, when neither vertical side fits', () => {
      const vp = { width: 1440, height: 300 }
      expect(popoverPlacement({ top: 120, left: 200, width: 100, height: 40 }, vp, 200)).toMatchObject({ side: 'beside', left: 310 })
      // A control where the beside spot would be: a corner instead. Left and
      // right of the viewport: a fixed corner choice covers one of them.
      for (const [left, blocker] of [[200, { top: 60, left: 320, bottom: 100, right: 400 }], [1250, { top: 60, left: 1000, bottom: 100, right: 1100 }]] as const) {
        const rect = { top: 120, left, width: 100, height: 40 }
        const p = popoverPlacement(rect, vp, 200, [blocker])
        expect(p.side).toBe('corner')
        expect(hits(box({ top: p.top, left: p.left, width: p.width, height: 200 }), blocker)).toBe(false)
        const pb = box({ top: p.top, left: p.left, width: p.width, height: 200 })
        for (const g of guarded(rect, vp)) expect(hits(pb, g), `left ${left}`).toBe(false)
        expect(p.top).toBeGreaterThanOrEqual(8)
        expect(p.top + 200).toBeLessThanOrEqual(300 - 8)
      }
    })

    it('never covers the target or arrow, and stays on screen, anywhere on a desktop or phone', () => {
      for (const vp of [desk, phone]) {
        for (let top = 0; top <= vp.height - 30; top += 37) {
          for (const left of [0, vp.width / 2 - 40, vp.width - 80]) {
            const rect = { top, left, width: 80, height: 30 }
            const p = popoverPlacement(rect, vp, H)
            for (const g of guarded(rect, vp)) expect(hits(panelBox(p), g), `${vp.width} ${top} ${left} ${p.side}`).toBe(false)
            expect(inside(p, vp), `${vp.width} ${top} ${left}`).toBe(true)
          }
        }
      }
    })
  })

  it('resolves a Settings row strictly: no first-match stand-in for a missing occurrence', () => {
    const entry = { ...SETTINGS_REGISTRY[0], settingId: undefined, configKey: undefined, labelKey: undefined, label: 'Dup', occurrence: 2 }
    const one = document.createElement('div')
    one.setAttribute('data-setting-label', 'Dup')
    document.body.appendChild(one)
    expect(resolveSettingElementStrict(entry)).toBeNull()
    const two = document.createElement('div')
    two.setAttribute('data-setting-label', 'Dup')
    document.body.appendChild(two)
    expect(resolveSettingElementStrict(entry)).toBe(two)
    one.remove(); two.remove()
  })

  it('never guides to credential or security-ceiling settings', () => {
    const sensitive = SETTINGS_REGISTRY.filter(isSensitiveSetting).map(e => e.id)
    for (const id of ['security.denied-commands', 'secrets.jira-api-token', 'browser.attach-token', 'channels.slack-bot-token-slack']) {
      expect(sensitive).toContain(id)
      expect(resolveGuideAction({ id: 'settings.show', params: { setting_id: id } })).toEqual({ ok: false, reason: 'sensitive_setting' })
    }
    expect(resolveGuideAction({ id: 'settings.show', params: { setting_id: 'chat.default-model' } }).ok).toBe(true)
    expect(resolveGuideAction({ id: 'run.js', params: {} })).toEqual({ ok: false, reason: 'unknown_action' })
  })
})
/** Stands in for any nav click that takes the user off the step's page. */
function NavTo({ to }: { to: string }) {
  const navigate = useNavigate()
  return <button type="button" data-testid="nav-away" onClick={() => navigate(to)}>away</button>
}

/** A registered target the test can show and hide, like a panel that unmounts. */
function ToggleTarget({ anchor, initial = false }: { anchor: string; initial?: boolean }) {
  const [shown, setShown] = useState(initial)
  return (
    <>
      <button type="button" data-testid="toggle-target" onClick={() => setShown(s => !s)}>toggle</button>
      {shown && <Target anchor={anchor} />}
    </>
  )
}

/** The gateway's progress transitions, including recovery in place. */
const gatewayProgress = (current: Guide, b: Record<string, unknown>): Guide => {
  const next = { ...current, revision: current.revision + 1 }
  if (b.outcome === 'observed') return { ...next, status: 'active', step_index: (b.step_index as number) + 1 }
  if (b.outcome === 'target_missing') return { ...next, status: 'target_missing' }
  if (current.status !== 'target_missing') return current
  const resume = typeof b.resume_step_index === 'number' ? { step_index: b.resume_step_index } : {}
  return { ...next, status: 'active', ...resume }
}

describe('leaving a step and coming back', () => {
  const outcomes = () => writes('/api/guide/progress').map(c => c.body.outcome)

  async function startTracked(extra: ReactNode, over: Partial<Guide> = {}) {
    pending = [guide(over)]
    let current = claimed(guide(over))
    onWrite = (name, b) => {
      if (name === 'progress') current = gatewayProgress(current, b)
      if (name === 'cancel') current = { ...current, status: 'cancelled', owner_tab: null, revision: current.revision + 1 }
      return current
    }
    renderGuide('/chat/slot-A', extra)
    fireEvent.click(await screen.findByTestId('guide-start'))
    await waitFor(() => expect(screen.getByTestId('loc').textContent).toContain('/members'))
    return () => current
  }

  it('only a navigation asked about in the same step tells the page its leave was granted', async () => {
    await startTracked(<><Target anchor={GUIDE_ANCHORS.crewmateGoalNext} /><NavTo to="/settings/chat" /></>)
    // Start awaited its claim after asking: a draft typed meanwhile was never asked about.
    expect(screen.getByTestId('loc').dataset.granted).toBe('0')
    await screen.findByTestId('guide-arrow')
    fireEvent.click(screen.getByTestId('nav-away'))
    fireEvent.click(await screen.findByTestId('guide-go-back'))
    // Go back asks and navigates in one step: the page need not ask again.
    await waitFor(() => expect(screen.getByTestId('loc').textContent).toContain('/members?create=1'))
    expect(screen.getByTestId('loc').dataset.granted).toBe('1')
  })

  it('says the user left the step at once, and Go back returns to the step page and resumes it', async () => {
    await startTracked(<><Target anchor={GUIDE_ANCHORS.crewmateGoalNext} /><NavTo to="/settings/chat" /></>)
    await screen.findByTestId('guide-arrow')
    fireEvent.click(screen.getByTestId('nav-away'))
    expect(await screen.findByText(L('left_step'))).toBeTruthy()
    // Not waiting out the missing bound, and not pointing at anything meanwhile.
    expect(screen.queryByTestId('guide-arrow')).toBeNull()
    await new Promise(r => setTimeout(r, 300))
    expect(outcomes()).toEqual([])
    expect(screen.queryByTestId('guide-arrow')).toBeNull()
    fireEvent.click(screen.getByTestId('guide-go-back'))
    // The action's own enter plan: the Crewmates hand-off with the draft.
    await waitFor(() => expect(screen.getByTestId('loc').textContent).toBe('/members?create=1&name=radar&goal=watch+the+build'))
    expect(await screen.findByTestId('guide-arrow')).toBeTruthy()
    expect(screen.queryByText(L('left_step'))).toBeNull()
    expect(outcomes()).toEqual([])
  })

  it('a missing target that shows again resumes the same step by itself, once each time', async () => {
    const now = await startTracked(<><ToggleTarget anchor={GUIDE_ANCHORS.crewmateGoalNext} /><NavTo to="/settings/chat" /></>)
    await new Promise(r => setTimeout(r, 300))
    const t0 = Date.now()
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => t0 + GUIDE_TARGET_WAIT_MS + 1000)
    await waitFor(() => expect(outcomes()).toEqual(['target_missing']))
    expect(await screen.findByText(L('target_missing'))).toBeTruthy()
    expect(screen.getByTestId('guide-go-back')).toBeTruthy()
    // Off the page, Go back still leads back (the target was never found
    // there, so this is still "missing", not "left").
    fireEvent.click(screen.getByTestId('nav-away'))
    await waitFor(() => expect(screen.getByTestId('loc').textContent).toBe('/settings/chat'))
    fireEvent.click(screen.getByTestId('guide-go-back'))
    await waitFor(() => expect(screen.getByTestId('loc').textContent).toContain('/members?create=1'))
    clock.mockRestore()
    fireEvent.click(screen.getByTestId('toggle-target'))
    await waitFor(() => expect(outcomes()).toEqual(['target_missing', 'target_found']))
    const found = writes('/api/guide/progress')[1].body
    expect(found).toMatchObject({ step_index: 0, revision: now().revision - 1 })
    expect(now()).toMatchObject({ status: 'active', step_index: 0 })
    expect(await screen.findByTestId('guide-arrow')).toBeTruthy()
    expect(screen.getByTestId('guide-step-text').textContent).toBe(i18nT('components.guideLayer.step_crewmate_goal'))
    await new Promise(r => setTimeout(r, 300))
    expect(outcomes()).toEqual(['target_missing', 'target_found'])
    // Gone again: reported again, at its new revision, not swallowed as sent.
    fireEvent.click(screen.getByTestId('toggle-target'))
    await new Promise(r => setTimeout(r, 300))
    const t1 = Date.now()
    vi.spyOn(Date, 'now').mockImplementation(() => t1 + GUIDE_TARGET_WAIT_MS + 1000)
    await waitFor(() => expect(outcomes()).toEqual(['target_missing', 'target_found', 'target_missing']))
    // This time the step had been on screen, so going elsewhere reads as leaving it.
    fireEvent.click(screen.getByTestId('nav-away'))
    expect(await screen.findByText(L('left_step'))).toBeTruthy()
    expect(screen.getByTestId('guide-go-back')).toBeTruthy()
  })

  it('a guide that ended never resumes when its target shows again', async () => {
    await startTracked(<ToggleTarget anchor={GUIDE_ANCHORS.crewmateGoalNext} />)
    await new Promise(r => setTimeout(r, 300))
    const t0 = Date.now()
    vi.spyOn(Date, 'now').mockImplementation(() => t0 + GUIDE_TARGET_WAIT_MS + 1000)
    await waitFor(() => expect(outcomes()).toEqual(['target_missing']))
    fireEvent.click(await screen.findByRole('button', { name: L('cancel_guide') }))
    await waitFor(() => expect(writes('/api/guide/cancel')).toHaveLength(1))
    await waitFor(() => expect(screen.queryByTestId('guide-go-back')).toBeNull())
    fireEvent.click(screen.getByTestId('toggle-target'))
    await new Promise(r => setTimeout(r, 400))
    expect(outcomes()).toEqual(['target_missing'])
    expect(screen.queryByTestId('guide-arrow')).toBeNull()
  })

  it('after a reload, taking over a missing guide walks back to its step and resumes it there', async () => {
    // A reload is a new tab id: the guide is still the old tab's, still missing.
    pending = [guide({ status: 'target_missing', owner_tab: 'old-tab', revision: 6 })]
    let current: Guide = pending[0]
    onWrite = (name, b) => {
      if (name === 'claim') current = { ...current, owner_tab: TAB_ID, revision: current.revision + 1 }
      if (name === 'progress') current = gatewayProgress(current, b)
      return current
    }
    renderGuide('/chat/slot-A', <ToggleTarget anchor={GUIDE_ANCHORS.crewmateGoalNext} />)
    fireEvent.click(await screen.findByTestId('guide-take-over'))
    await waitFor(() => expect(screen.getByTestId('loc').textContent).toBe('/members?create=1&name=radar&goal=watch+the+build'))
    expect(writes('/api/guide/progress')).toHaveLength(0)
    fireEvent.click(screen.getByTestId('toggle-target'))
    await waitFor(() => expect(outcomes()).toEqual(['target_found']))
    expect(writes('/api/guide/progress')[0].body).toMatchObject({ revision: 7, tab_id: TAB_ID })
    expect(await screen.findByTestId('guide-arrow')).toBeTruthy()
  })

  it('a recovery report that fails is offered again and still resumes the step', async () => {
    pending = [guide({ status: 'target_missing', owner_tab: 'old-tab', revision: 6 })]
    let current: Guide = pending[0]
    onWrite = (name, b) => {
      if (name === 'claim') current = { ...current, owner_tab: TAB_ID, revision: current.revision + 1 }
      if (name === 'progress') current = gatewayProgress(current, b)
      return current
    }
    let failNext = true
    server.use(
      http.post('/api/guide/progress', async ({ request }) => {
        const body = (await request.json()) as Record<string, unknown>
        calls.push({ path: '/api/guide/progress', body, headers: request.headers })
        if (failNext) {
          failNext = false
          return HttpResponse.json({ error: 'flaky' }, { status: 503 })
        }
        return HttpResponse.json({ guide: onWrite('progress', body) })
      }),
    )
    renderGuide('/chat/slot-A', <ToggleTarget anchor={GUIDE_ANCHORS.crewmateGoalNext} />)
    fireEvent.click(await screen.findByTestId('guide-take-over'))
    await waitFor(() => expect(screen.getByTestId('loc').textContent).toContain('/members?create=1'))
    fireEvent.click(screen.getByTestId('toggle-target'))
    await waitFor(() => expect(outcomes()).toEqual(['target_found']))
    expect(current.status).toBe('target_missing')
    const t0 = Date.now()
    vi.spyOn(Date, 'now').mockImplementation(() => t0 + GUIDE_FOUND_RETRY_MS + 500)
    await waitFor(() => expect(outcomes()).toEqual(['target_found', 'target_found']))
    expect(current).toMatchObject({ status: 'active', step_index: 0 })
    expect(await screen.findByTestId('guide-arrow')).toBeTruthy()
    // The failed attempt's error does not outlive the report that landed.
    await waitFor(() => expect(screen.queryByText('flaky')).toBeNull())
  })

  it('a report slower than the retry spacing still ends in a stopped panel, never a silent tracker', async () => {
    await startTracked(<><ToggleTarget anchor={GUIDE_ANCHORS.crewmateGoalNext} /></>)
    const release: Array<() => void> = []
    server.use(
      http.post('/api/guide/progress', async ({ request }) => {
        const body = (await request.json()) as Record<string, unknown>
        calls.push({ path: '/api/guide/progress', body, headers: request.headers })
        await new Promise<void>(r => release.push(r))
        return HttpResponse.json({ error: 'flaky' }, { status: 503 })
      }),
    )
    await new Promise(r => setTimeout(r, 300))
    let t = Date.now() + GUIDE_TARGET_WAIT_MS + 1000
    vi.spyOn(Date, 'now').mockImplementation(() => t)
    await waitFor(() => expect(outcomes()).toEqual(['target_missing']))
    // Many retry windows pass while the first report is still out: none of
    // those offers was sent, so none may use up an attempt.
    for (let i = 0; i < GUIDE_FOUND_MAX_ATTEMPTS + 2; i++) {
      t += GUIDE_FOUND_RETRY_MS + 100
      await new Promise(r => setTimeout(r, 300))
    }
    expect(outcomes()).toHaveLength(1)
    for (let i = 1; i < GUIDE_FOUND_MAX_ATTEMPTS; i++) {
      release.splice(0).forEach(r => r())
      t += GUIDE_FOUND_RETRY_MS + 100
      await waitFor(() => expect(outcomes()).toHaveLength(i + 1))
    }
    release.splice(0).forEach(r => r())
    // Every real attempt failed: the panel says it stopped and offers Go back.
    expect(await screen.findByText(L('target_missing'))).toBeTruthy()
    expect(screen.getByTestId('guide-go-back')).toBeTruthy()
    expect(screen.queryByText(L('looking_for_control'))).toBeNull()
    expect(screen.getByText('flaky')).toBeTruthy()
    // Going back restarts the attempt: the stopped reports' error goes with it.
    fireEvent.click(screen.getByTestId('guide-go-back'))
    await waitFor(() => expect(screen.queryByText('flaky')).toBeNull())
  }, 15_000)

  it('a failed target_missing report is offered again, and Go back re-arms a tracker that gave up', async () => {
    const now = await startTracked(<><ToggleTarget anchor={GUIDE_ANCHORS.crewmateGoalNext} /></>)
    let failing = true
    server.use(
      http.post('/api/guide/progress', async ({ request }) => {
        const body = (await request.json()) as Record<string, unknown>
        calls.push({ path: '/api/guide/progress', body, headers: request.headers })
        if (failing) return HttpResponse.json({ error: 'flaky' }, { status: 503 })
        return HttpResponse.json({ guide: onWrite('progress', body) })
      }),
    )
    await new Promise(r => setTimeout(r, 300))
    let t = Date.now() + GUIDE_TARGET_WAIT_MS + 1000
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => t)
    await waitFor(() => expect(outcomes()).toEqual(['target_missing']))
    // One failure is not "stopped": the tracker is still retrying.
    await new Promise(r => setTimeout(r, 100))
    expect(screen.queryByText(L('target_missing'))).toBeNull()
    expect(screen.queryByTestId('guide-go-back')).toBeNull()
    // Every retry fails until the tracker gives up.
    for (let i = 1; i < GUIDE_FOUND_MAX_ATTEMPTS; i++) {
      t += GUIDE_FOUND_RETRY_MS + 100
      await waitFor(() => expect(outcomes()).toHaveLength(i + 1))
    }
    t += GUIDE_FOUND_RETRY_MS * 3
    await new Promise(r => setTimeout(r, 600))
    expect(outcomes()).toHaveLength(GUIDE_FOUND_MAX_ATTEMPTS)
    // It has stopped: the panel says so instead of spinning on "Looking for".
    expect(screen.queryByText(L('looking_for_control'))).toBeNull()
    expect(screen.getByText(L('target_missing'))).toBeTruthy()
    // The network is back; pressing Go back on the same page reports again.
    failing = false
    fireEvent.click(await screen.findByTestId('guide-go-back'))
    await new Promise(r => setTimeout(r, 300))
    t += GUIDE_TARGET_WAIT_MS + 1000
    await waitFor(() => expect(outcomes()).toHaveLength(GUIDE_FOUND_MAX_ATTEMPTS + 1))
    await waitFor(() => expect(now().status).toBe('target_missing'))
    clock.mockRestore()
  })

  it('a form that restarts on return takes the guide back to the step it shows', async () => {
    // The real wizard keeps its step in local state: leaving /members unmounts
    // it, and coming back starts it over at the first step.
    function Wizard() {
      const [step, setStep] = useState(1)
      return step === 1
        ? <Target anchor={GUIDE_ANCHORS.crewmateGoalNext} onClick={() => setStep(2)} />
        : <Target anchor={GUIDE_ANCHORS.crewmateNameNext} />
    }
    function RoutedWizard() {
      const loc = useLocation()
      return loc.pathname === '/members' ? <Wizard /> : null
    }
    const now = await startTracked(<><RoutedWizard /><NavTo to="/settings/chat" /></>)
    fireEvent.click(await screen.findByTestId(`target-${GUIDE_ANCHORS.crewmateGoalNext}`))
    await waitFor(() => expect(now()).toMatchObject({ status: 'active', step_index: 1 }))
    fireEvent.click(screen.getByTestId('nav-away'))
    expect(await screen.findByText(L('left_step'))).toBeTruthy()
    fireEvent.click(screen.getByTestId('guide-go-back'))
    await waitFor(() => expect(screen.getByTestId('loc').textContent).toContain('/members?create=1'))
    expect(await screen.findByTestId(`target-${GUIDE_ANCHORS.crewmateGoalNext}`)).toBeTruthy()
    const t0 = Date.now()
    vi.spyOn(Date, 'now').mockImplementation(() => t0 + GUIDE_EARLIER_STEP_WAIT_MS + 500)
    await waitFor(() => expect(outcomes()).toEqual(['observed', 'target_missing', 'target_found']))
    expect(writes('/api/guide/progress')[2].body).toMatchObject({ step_index: 1, resume_step_index: 0 })
    expect(now()).toMatchObject({ status: 'active', step_index: 0 })
    await waitFor(() => expect(screen.getByTestId('guide-step-text').textContent).toBe(i18nT('components.guideLayer.step_crewmate_goal')))
    expect(await screen.findByTestId('guide-arrow')).toBeTruthy()
  })

  it('a save the server refused stops the waiting, and the guide follows the form back', async () => {
    let api: ReturnType<typeof useGuide> = null
    function Probe() { api = useGuide(); return null }
    const now = await startTracked(<><ToggleTarget anchor={GUIDE_ANCHORS.crewmateNameNext} initial /><Probe /></>, { step_index: 2 })
    // On the Create step, the human pressed Create: the step is "submitted".
    act(() => { expect(api?.requestHeadersFor('crewmate.create')).toBeTruthy() })
    expect(api?.submitted).toBe(true)
    // The create came back 409: the form is on the name step again.
    act(() => api?.noteSaveRefused('crewmate.create'))
    expect(api?.submitted).toBe(false)
    await new Promise(r => setTimeout(r, 300))
    const t0 = Date.now()
    vi.spyOn(Date, 'now').mockImplementation(() => t0 + GUIDE_EARLIER_STEP_WAIT_MS + 500)
    await waitFor(() => expect(outcomes()).toEqual(['target_missing', 'target_found']))
    expect(writes('/api/guide/progress')[1].body).toMatchObject({ step_index: 2, resume_step_index: 1 })
    expect(now()).toMatchObject({ status: 'active', step_index: 1 })
  })

  it('a save waits for a report still in flight, and then reads the step the gateway moved to', async () => {
    let api: ReturnType<typeof useGuide> = null
    function Probe() { api = useGuide(); return null }
    let release!: () => void
    const gate = new Promise<void>(r => { release = r })
    await startTracked(<><Target anchor={GUIDE_ANCHORS.crewmateNameNext} /><Probe /></>, { step_index: 1 })
    server.use(
      http.post('/api/guide/progress', async ({ request }) => {
        const body = (await request.json()) as Record<string, unknown>
        calls.push({ path: '/api/guide/progress', body, headers: request.headers })
        await gate
        return HttpResponse.json({ guide: onWrite('progress', body) })
      }),
    )
    // The form reaches Create before the gateway answered the step-1 report.
    act(() => api?.report('observed'))
    await waitFor(() => expect(outcomes()).toEqual(['observed']))
    let synced = false
    const done = api!.awaitSync('crewmate.create').then((ok) => { synced = true; expect(ok).toBe(true) })
    await new Promise(r => setTimeout(r, 50))
    expect(synced).toBe(false)
    release()
    await done
    // Read after the wait, the headers name the commit step's revision.
    let headers: Record<string, string> | undefined
    act(() => { headers = api?.requestHeadersFor('crewmate.create') })
    expect(headers).toBeTruthy()
  })

  it('an observed report that fails is offered again, so the guide does not stay a step behind', async () => {
    let failNext = true
    const now = await startTracked(<><Target anchor={GUIDE_ANCHORS.crewmateGoalNext} /></>)
    server.use(
      http.post('/api/guide/progress', async ({ request }) => {
        const body = (await request.json()) as Record<string, unknown>
        calls.push({ path: '/api/guide/progress', body, headers: request.headers })
        if (failNext) { failNext = false; return HttpResponse.json({ error: 'flaky' }, { status: 503 }) }
        return HttpResponse.json({ guide: onWrite('progress', body) })
      }),
    )
    // The form moved on: the next step's control is on screen.
    render(<Target anchor={GUIDE_ANCHORS.crewmateNameNext} rect={{ top: 500, left: 100, width: 80, height: 30 }} />)
    await waitFor(() => expect(outcomes()).toEqual(['observed']))
    const t0 = Date.now()
    vi.spyOn(Date, 'now').mockImplementation(() => t0 + GUIDE_FOUND_RETRY_MS + 500)
    await waitFor(() => expect(outcomes()).toEqual(['observed', 'observed']))
    expect(now()).toMatchObject({ status: 'active', step_index: 1 })
  })

  it('re-measures the page while the target stays put, so a control that slides in is avoided', async () => {
    // jsdom lays nothing out, so the panel measures 0 tall; the arrow has a
    // fixed size, which makes it the observable for a re-measured neighbour.
    const where = { rect: { top: 2000, left: 0, width: 10, height: 10 } }
    function Sliding() {
      return (
        <button
          type="button"
          ref={(el) => {
            if (!el) return
            el.getBoundingClientRect = () => {
              const r = where.rect
              return { ...r, right: r.left + r.width, bottom: r.top + r.height, x: r.left, y: r.top, toJSON: () => ({}) } as DOMRect
            }
          }}
        >
          neighbour
        </button>
      )
    }
    await startTracked(<><Target anchor={GUIDE_ANCHORS.crewmateGoalNext} /><Sliding /></>)
    const arrow = await screen.findByTestId('guide-arrow')
    const at = (el: HTMLElement) => ({ top: parseFloat(el.style.top), left: parseFloat(el.style.left) })
    const before = at(arrow)
    // A control now sits exactly where the arrow rests.
    where.rect = { top: before.top, left: before.left, width: 24, height: 24 }
    await waitFor(() => expect(at(screen.getByTestId('guide-arrow'))).not.toEqual(before), { timeout: GUIDE_RELAYOUT_MS * 4 })
  })

  it('a save the guide never caught up with ends the guide saying the change was saved', async () => {
    let api: ReturnType<typeof useGuide> = null
    function Probe() { api = useGuide(); return null }
    let current: Guide | null = null
    const now = await startTracked(<><Target anchor={GUIDE_ANCHORS.crewmateNameNext} /><Probe /></>, { step_index: 1 })
    const prev = onWrite
    onWrite = (name, b) => {
      if (name === 'cancel') { current = { ...now(), status: 'cancelled', reason: b.reason as string, owner_tab: null, finished_at: 10, revision: now().revision + 1 }; return current }
      return prev(name, b)
    }
    // Still on the name step: the wait for the Create step runs out.
    const t0 = Date.now()
    let ok: boolean | undefined
    const wait = api!.awaitSync('crewmate.create').then(v => { ok = v })
    vi.spyOn(Date, 'now').mockImplementation(() => t0)
    await new Promise(r => setTimeout(r, 50))
    expect(ok).toBeUndefined()
    await wait
    expect(ok).toBe(false)
    act(() => api?.noteSavedWithoutGuide('crewmate.create'))
    await waitFor(() => expect(writes('/api/guide/cancel')).toHaveLength(1))
    expect(writes('/api/guide/cancel')[0].body).toMatchObject({ reason: 'saved_without_guide' })
    expect((await screen.findAllByText(L('finished_saved_without_guide'))).length).toBeGreaterThan(0)
    expect(screen.queryByText(L('finished_cancelled'))).toBeNull()
  })

  it('closing a guide its save went past retries at the re-read revision after a 409', async () => {
    let api: ReturnType<typeof useGuide> = null
    function Probe() { api = useGuide(); return null }
    const now = await startTracked(<><Target anchor={GUIDE_ANCHORS.crewmateNameNext} /><Probe /></>, { step_index: 1 })
    // The gateway moved on (a late progress report) before the browser heard.
    const server_ = { revision: now().revision + 1 }
    pending = [{ ...now(), revision: server_.revision, step_index: 2 }]
    server.use(
      http.post('/api/guide/cancel', async ({ request }) => {
        const body = (await request.json()) as Record<string, unknown>
        calls.push({ path: '/api/guide/cancel', body, headers: request.headers })
        if (body.revision !== server_.revision) return HttpResponse.json({ error: 'stale', code: 'stale_revision' }, { status: 409 })
        return HttpResponse.json({ guide: { ...pending[0], status: 'cancelled', reason: body.reason, owner_tab: null, finished_at: 10, revision: server_.revision + 1 } })
      }),
    )
    act(() => api?.noteSavedWithoutGuide('crewmate.create'))
    await waitFor(() => expect(writes('/api/guide/cancel')).toHaveLength(2), { timeout: 3000 })
    expect(writes('/api/guide/cancel').map(c => c.body.revision)).toEqual([server_.revision - 1, server_.revision])
    expect((await screen.findAllByText(L('finished_saved_without_guide'))).length).toBeGreaterThan(0)
  })

  it('closing after a 409 waits for a slow re-read, then closes the same guide at its new revision', async () => {
    let api: ReturnType<typeof useGuide> = null
    function Probe() { api = useGuide(); return null }
    const now = await startTracked(<><Target anchor={GUIDE_ANCHORS.crewmateNameNext} /><Probe /></>, { step_index: 1 })
    const server_ = { revision: now().revision + 1 }
    pending = [{ ...now(), revision: server_.revision, step_index: 2 }]
    server.use(
      // The re-read takes longer than any fixed retry spacing would.
      http.get('/api/guide/pending', async () => {
        await new Promise(r => setTimeout(r, 2100))
        return HttpResponse.json({ guides: pending })
      }),
      http.post('/api/guide/cancel', async ({ request }) => {
        const body = (await request.json()) as Record<string, unknown>
        calls.push({ path: '/api/guide/cancel', body, headers: request.headers })
        if (body.revision !== server_.revision) return HttpResponse.json({ error: 'stale', code: 'stale_revision' }, { status: 409 })
        return HttpResponse.json({ guide: { ...pending[0], status: 'cancelled', reason: body.reason, owner_tab: null, finished_at: 10, revision: server_.revision + 1 } })
      }),
    )
    act(() => api?.noteSavedWithoutGuide('crewmate.create'))
    await waitFor(() => expect(writes('/api/guide/cancel')).toHaveLength(1))
    await new Promise(r => setTimeout(r, 1500))
    // No second attempt spent on the stale revision while the read is out.
    expect(writes('/api/guide/cancel')).toHaveLength(1)
    await waitFor(() => expect(writes('/api/guide/cancel')).toHaveLength(2), { timeout: 4000 })
    expect(writes('/api/guide/cancel').map(c => c.body.revision)).toEqual([server_.revision - 1, server_.revision])
    expect((await screen.findAllByText(L('finished_saved_without_guide'), {}, { timeout: 4000 })).length).toBeGreaterThan(0)
  }, 10_000)

  it('a recorded row keeps the saved-without-guide wording once the live guide is gone', async () => {
    pending = []
    render(
      <Provider store={store}>
        <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
          <MemoryRouter initialEntries={['/chat/slot-A']}>
            <GuideProvider>
              <GuideOfferCard guideId="gone" slotKey="slot-A" recordedStatus="cancelled" recordedReason="saved_without_guide" />
            </GuideProvider>
          </MemoryRouter>
        </QueryClientProvider>
      </Provider>,
    )
    expect(await screen.findByText(L('finished_saved_without_guide'))).toBeTruthy()
  })

  it('awaitSync answers false at once when this tab has no guide on that action', async () => {
    let api: ReturnType<typeof useGuide> = null
    function Probe() { api = useGuide(); return null }
    renderGuide('/chat/slot-A', <Probe />)
    await waitFor(() => expect(api).toBeTruthy())
    await expect(api!.awaitSync('crewmate.create')).resolves.toBe(false)
  })

  it('a step page that redirects on arrival is never read as the user leaving it', async () => {
    // The plan leads to /members; this stand-in page canonicalises it away at
    // once, so the tab never stood on the plan's path and cannot have left it.
    function Redirect() {
      const loc = useLocation()
      const navigate = useNavigate()
      useEffect(() => { if (loc.pathname === '/members') navigate('/crew', { replace: true }) }, [loc.pathname, navigate])
      return null
    }
    pending = [guide()]
    onWrite = () => claimed(guide())
    renderGuide('/chat/slot-A', <Redirect />)
    fireEvent.click(await screen.findByTestId('guide-start'))
    await waitFor(() => expect(screen.getByTestId('loc').textContent).toBe('/crew'))
    expect(await screen.findByText(L('looking_for_control'))).toBeTruthy()
    expect(screen.queryByText(L('left_step'))).toBeNull()
  })

  it('never sends a recovery for a guide that is not missing', async () => {
    let report: ((o: 'target_found') => void) | undefined
    function Probe() {
      report = useGuide()?.report
      return null
    }
    await startTracked(<><Target anchor={GUIDE_ANCHORS.crewmateGoalNext} /><Probe /></>)
    await screen.findByTestId('guide-arrow')
    act(() => report?.('target_found'))
    await new Promise(r => setTimeout(r, 100))
    expect(outcomes()).toEqual([])
  })
})


describe('the acknowledge button on the last step', () => {
  /** The view GuideContext derives for *g* at its current indices. */
  const viewOf = (g: Guide) => {
    const resolved = resolveGuideActions(g.actions)
    const action = resolved.ok ? resolved.actions[g.action_index] ?? null : null
    const step = action ? action.steps[g.step_index] ?? null : null
    return { guide: g, resolved, ownedHere: true, needsEnter: false, action, step }
  }
  const show = { id: 'settings.show', params: { setting_id: 'chat.default-model' } }
  const mcp = { id: 'mcp.open_add', params: {} }

  it('a single-setting guide ends on its only step', () => {
    expect(isFinalGuideStep(viewOf(guide({ actions: [show] })))).toBe(true)
  })

  it('a step that another action follows is not the last', () => {
    expect(isFinalGuideStep(viewOf(guide({ actions: [show, mcp], action_index: 0 })))).toBe(false)
    expect(isFinalGuideStep(viewOf(guide({ actions: [mcp, show], action_index: 1 })))).toBe(true)
  })

  it('an earlier step of a multi-step action is not the last; its final step is', () => {
    expect(isFinalGuideStep(viewOf(guide({ actions: [mcp], step_index: 0 })))).toBe(false)
    expect(isFinalGuideStep(viewOf(guide({ actions: [mcp], step_index: 1 })))).toBe(true)
  })

  it('a refused guide has no last step', () => {
    expect(isFinalGuideStep(viewOf(guide({ actions: [{ id: 'run.js', params: {} }] })))).toBe(false)
  })

  it('the settings step asks for the change and never claims the guide makes it', () => {
    const text = L('step_settings_show')
    expect(text).not.toMatch(/\bNext\b|found it/)
    expect(text).toMatch(/doesn.t change it for you/)
  })
})

describe('owner tab and revision', () => {
  it('a second tab cannot advance; explicit takeover claims the current revision', async () => {
    pending = [guide({ status: 'active', owner_tab: 'other-tab', revision: 5 })]
    onWrite = () => claimed(guide({ revision: 5 }))
    renderGuide('/chat/slot-A', <><Target anchor={GUIDE_ANCHORS.crewmateGoalNext} /><Target anchor={GUIDE_ANCHORS.crewmateNameNext} /></>)
    expect(await screen.findByText(L('other_tab'))).toBeTruthy()
    await new Promise(r => setTimeout(r, 400))
    expect(writes('/api/guide/progress')).toHaveLength(0)
    expect(screen.queryByTestId('guide-arrow')).toBeNull()
    fireEvent.click(screen.getByTestId('guide-take-over'))
    await waitFor(() => expect(writes('/api/guide/claim')).toHaveLength(1))
    expect(writes('/api/guide/claim')[0].body).toEqual({ guide_id: 'g1', tab_id: TAB_ID, revision: 5, take_over: true })
  })

  it('the old tab stops once another tab takes the guide over', async () => {
    await startCrewmate(<Target anchor={GUIDE_ANCHORS.crewmateGoalNext} />)
    await screen.findByTestId('guide-arrow')
    act(() => applyGuideUpdate(qc, { ...claimed(guide()), owner_tab: 'other-tab', revision: 9 }))
    await waitFor(() => expect(screen.queryByTestId('guide-arrow')).toBeNull())
    const before = calls.length
    await new Promise(r => setTimeout(r, 400))
    expect(calls.slice(before).filter(c => c.path === '/api/guide/progress')).toHaveLength(0)
  })

  it('ignores an update older than the revision it holds', async () => {
    pending = [guide({ revision: 4 })]
    renderGuide('/chat/slot-A')
    await screen.findByTestId('guide-start')
    act(() => applyGuideUpdate(qc, guide({ revision: 3, status: 'cancelled' })))
    expect(screen.getByTestId('guide-start')).toBeTruthy()
  })
})

/** The native add form carries no box in happy-dom; give it one. */
function layOutCustomForm() {
  const form = document.querySelector<HTMLElement>('[data-guide-anchor="mcp.custom-form"]')
  if (!form) return null
  form.getBoundingClientRect = () => ({ top: 100, left: 100, width: 400, height: 300, right: 500, bottom: 400, x: 100, y: 100, toJSON: () => ({}) }) as DOMRect
  return form
}

describe('MCP: navigate to the native add form, never install', () => {
  const mcpGuide = (over: Partial<Guide> = {}) => guide({ actions: [{ id: 'mcp.open_add', params: {} }], ...over })

  it('resolves only with empty params and navigates to the existing MCP page', () => {
    const r = resolveGuideAction({ id: 'mcp.open_add', params: {} })
    if (!r.ok) throw new Error('expected ok')
    expect(r.action.enter.to({ pathname: '/chat/slot-A', search: '' })).toBe('/capabilities?tab=mcp')
    expect(r.action.steps.map(st => st.complete.kind)).toEqual(['reach', 'reach'])
    expect(r.action.steps.some(st => st.complete.kind === 'committed' || st.complete.kind === 'ack')).toBe(false)
    for (const params of [{ name: 'files' }, { spec: { command: 'x' } }, { name: 'files', spec: { command: 'x' } }]) {
      expect(resolveGuideAction({ id: 'mcp.open_add', params })).toEqual({ ok: false, reason: 'invalid_params' })
    }
    expect(resolveGuideAction({ id: 'mcp.add_review', params: { name: 'files', spec: { command: 'x' } } })).toEqual({ ok: false, reason: 'unknown_action' })
  })

  it('walks Services -> MCP Servers tab -> Add Custom -> empty native form, with zero MCP writes', async () => {
    pending = [mcpGuide()]
    let current = claimed(mcpGuide())
    onWrite = (name, b) => {
      if (name === 'progress') {
        const last = (b.step_index as number) >= 1
        current = { ...current, revision: current.revision + 1, step_index: last ? current.step_index : (b.step_index as number) + 1, status: last ? 'completed' : 'active' }
      }
      return current
    }
    renderGuide('/chat/slot-A', <NativeMcpHost />)
    await screen.findByTestId('guide-start')
    expect(document.querySelector('[data-guide-anchor="mcp.custom-form"]')).toBeNull()
    fireEvent.click(screen.getByTestId('guide-start'))
    await waitFor(() => expect(screen.getByTestId('loc').textContent).toBe('/capabilities?tab=mcp'))

    // Step 1: the arrow is on the existing MCP Servers tab; nothing auto-opens.
    expect(await screen.findByText(L('step_mcp_open_tab'))).toBeTruthy()
    await new Promise(r => setTimeout(r, 400))
    expect(writes('/api/guide/progress')).toHaveLength(0)
    expect(document.querySelector('[data-guide-anchor="mcp.custom-form"]')).toBeNull()
    fireEvent.click(screen.getByTestId('native-mcp-tab'))
    await waitFor(() => expect(writes('/api/guide/progress')).toHaveLength(1))
    expect(writes('/api/guide/progress')[0].body).toMatchObject({ step_index: 0, outcome: 'observed' })

    // Step 2: the arrow is on the existing Add Custom button; the human opens it.
    expect(await screen.findByText(L('step_mcp_add_custom'))).toBeTruthy()
    expect(document.querySelector('[data-guide-anchor="mcp.custom-form"]')).toBeNull()
    fireEvent.click(screen.getByTestId('native-add-custom'))
    await waitFor(() => expect(layOutCustomForm()).not.toBeNull())
    await waitFor(() => expect(writes('/api/guide/progress')).toHaveLength(2))
    expect(writes('/api/guide/progress')[1].body).toMatchObject({ step_index: 1, outcome: 'observed' })

    // The native form is exactly as an unguided open leaves it: nothing pre-filled.
    const editor = screen.getByRole('textbox', { name: i18nT('components.mcpCustomServerModal.servers_json') }) as HTMLTextAreaElement
    expect(editor.value).toBe('')
    expect(screen.queryByLabelText(i18nT('components.mcpCustomServerModal.server_name_2'))).toBeNull()
    // Completion says the guide ended, never that a server was added.
    expect((await screen.findByTestId('guide-result')).textContent).toContain(L('finished_completed'))
    expect(screen.queryByTestId('guide-saved-server')).toBeNull()
    expect(writes('/api/mcp/custom')).toHaveLength(0)
    for (const c of calls) expect(c.headers.get('X-Guide-Id')).toBeNull()

    // The gateway keeps serving the ended guide (its chat's result line), so a
    // focus refetch must not take the line away while the user is reading it.
    pending = (qc.getQueryData<Guide[]>(GUIDE_PENDING_QUERY_KEY) ?? []).filter(g => g.status === 'completed')
    expect(pending).toHaveLength(1)
    await act(async () => { await qc.invalidateQueries({ queryKey: GUIDE_PENDING_QUERY_KEY }) })
    // Past any exit animation: the line must still be there, not fading out.
    await new Promise(r => setTimeout(r, 600))
    expect(screen.getByTestId('guide-result').textContent).toContain(L('finished_completed'))
  })

  it('skips the tab step when the MCP Servers view is already showing', async () => {
    pending = [mcpGuide()]
    onWrite = () => claimed(mcpGuide())
    renderGuide('/chat/slot-A', <NativeMcpHost startOn="mcp-servers" />)
    fireEvent.click(await screen.findByTestId('guide-start'))
    await waitFor(() => expect(writes('/api/guide/progress')).toHaveLength(1))
    expect(writes('/api/guide/progress')[0].body).toMatchObject({ step_index: 0, outcome: 'observed' })
    expect(writes('/api/mcp/custom')).toHaveLength(0)
  })

  it('the native pages carry the registered anchors and no guide prefill', () => {
    const src = (rel: string) => readFileSync(path.join(__dirname, rel), 'utf-8')
    const connections = src('../pages/connections/ConnectionsPage.tsx')
    const mcpTab = src('../pages/overview/McpTab.tsx')
    const modal = src('../components/McpCustomServerModal.tsx')
    expect(connections).toContain(`data-guide-anchor="${GUIDE_ANCHORS.mcpServersTab}"`)
    expect(mcpTab).toContain(`data-guide-anchor="${GUIDE_ANCHORS.mcpAddCustom}"`)
    expect(modal).toContain(`'${GUIDE_ANCHORS.mcpCustomForm}'`)
    for (const text of [connections, mcpTab, modal]) {
      expect(text).not.toMatch(/guide\/GuideContext|useGuide|X-Guide|draft=/)
    }
  })
})

describe('in-chat offer card', () => {
  it('shows no top banner and no card in another slot\'s chat', async () => {
    pending = [guide()]
    // Split view: slot-A's pane and slot-B's pane are both open, slot-A viewed.
    renderGuide('/chat/slot-A', <div data-testid="pane-A"><GuideOfferCard guideId="g1" slotKey="slot-A" /></div>, 'slot-B')
    const start = await screen.findByTestId('guide-start')
    expect(screen.getByTestId('pane-A').contains(start)).toBe(true)
    expect(screen.getAllByTestId('guide-offer-card')).toHaveLength(1)
    expect(screen.queryByTestId('guide-pill')).toBeNull()
  })

  it('waits in slot A\'s chat while the user views slot B', async () => {
    store.dispatch(setActiveSlot('slot-B'))
    pending = [guide()]
    renderGuide('/chat/slot-B')
    const card = await screen.findByTestId('guide-offer-card')
    expect(card.getAttribute('data-guide-status')).toBe('offered')
    expect(card.textContent).toContain(i18nT('components.guideLayer.title_crewmate_create'))
    expect(screen.queryByTestId('guide-offer-hint')).toBeNull()
    expect(screen.queryByTestId('guide-pill')).toBeNull()
  })

  it('Start claims this slot\'s guide even when another slot is viewed', async () => {
    store.dispatch(setActiveSlot('slot-B'))
    pending = [guide()]
    onWrite = (name) => (name === 'claim' ? claimed(guide()) : null)
    renderGuide('/chat/slot-B')
    fireEvent.click(await screen.findByTestId('guide-start'))
    await waitFor(() => expect(writes('/api/guide/claim')).toHaveLength(1))
    expect(writes('/api/guide/claim')[0].body).toEqual({ guide_id: 'g1', tab_id: TAB_ID, revision: 1 })
    await waitFor(() => expect(screen.getByTestId('loc').textContent).toContain('/members'))
  })

  it('Dismiss cancels and the card is REPLACED by one result line', async () => {
    pending = [guide()]
    onWrite = (name) => (name === 'cancel' ? guide({ status: 'cancelled', revision: 2, finished_at: 10 }) : null)
    renderGuide('/chat/slot-A')
    fireEvent.click(await screen.findByTestId('guide-dismiss'))
    await waitFor(() => expect(writes('/api/guide/cancel')).toHaveLength(1))
    expect(writes('/api/guide/claim')).toHaveLength(0)
    const line = await screen.findByTestId('guide-result')
    expect(line.textContent).toContain(L('finished_cancelled'))
    await waitFor(() => expect(document.activeElement).toBe(line))
    // One element in the chat: the offer's shell is gone, not wrapping the line.
    expect(screen.queryByTestId('guide-offer-card')).toBeNull()
    expect(screen.queryByTestId('guide-start')).toBeNull()
    expect(screen.getByTestId('guide-offer-cards').children).toHaveLength(1)
    expect(screen.getByTestId('guide-result-row').getAttribute('data-guide-status')).toBe('cancelled')
  })

  it('a completed show-me guide offers Show again, which replays and walks it again', async () => {
    const show = [{ id: 'settings.show', params: { setting_id: 'chat.default-model' } }]
    pending = [guide({ actions: show, status: 'completed', revision: 4, finished_at: 10 })]
    server.use(http.post('/api/guide/replay', async ({ request }) => {
      calls.push({ path: '/api/guide/replay', body: (await request.json()) as Record<string, unknown>, headers: request.headers })
      return HttpResponse.json({ guide: guide({ actions: show, status: 'offered', revision: 5 }) })
    }))
    onWrite = (name) => (name === 'claim' ? guide({ actions: show, status: 'active', revision: 6, owner_tab: TAB_ID }) : null)
    renderGuide('/chat/slot-A')
    fireEvent.click(await screen.findByTestId('guide-replay'))
    await waitFor(() => expect(writes('/api/guide/claim')).toHaveLength(1))
    expect(writes('/api/guide/replay')[0].body).toEqual({ guide_id: 'g1', revision: 4 })
    expect(writes('/api/guide/claim')[0].body).toEqual({ guide_id: 'g1', tab_id: TAB_ID, revision: 5 })
    await waitFor(() => expect(screen.getByTestId('loc').textContent).toContain('/settings'))
  })

  it('a Show again that fails says so on the result line it was pressed on', async () => {
    const show = [{ id: 'settings.show', params: { setting_id: 'chat.default-model' } }]
    pending = [guide({ actions: show, status: 'completed', revision: 4, finished_at: 10 })]
    server.use(http.post('/api/guide/replay', () => HttpResponse.json({ error: 'gateway busy' }, { status: 503 })))
    renderGuide('/chat/slot-A')
    expect(screen.queryByTestId('guide-line-error')?.textContent ?? '').toBe('')
    fireEvent.click(await screen.findByTestId('guide-replay'))
    await waitFor(() => expect(screen.getByTestId('guide-line-error').textContent).not.toBe(''))
    expect(screen.getByTestId('guide-replay')).toBeTruthy()
  })

  it('a guide that saved a change is never offered again', async () => {
    pending = [guide({ status: 'completed', revision: 4, finished_at: 10 })]
    renderGuide('/chat/slot-A')
    await screen.findByTestId('guide-result')
    expect(screen.queryByTestId('guide-replay')).toBeNull()
  })

  it('the result line survives a page reload, and has no close control', async () => {
    // What the gateway serves after the reload: the slot's newest ended guide.
    pending = [guide({ status: 'cancelled', revision: 2, finished_at: 10 })]
    renderGuide('/chat/slot-A')
    const line = await screen.findByTestId('guide-result')
    expect(line.textContent).toContain(L('finished_cancelled'))
    expect(screen.queryByTestId('guide-offer-card')).toBeNull()
    // It is the conversation's record of the offer, so nothing hides it.
    expect(screen.queryByRole('button', { name: L('close') })).toBeNull()
  })

  it('once the gateway forgets the guide, the row draws the status it recorded', async () => {
    pending = []
    render(
      <Provider store={store}>
        <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
          <MemoryRouter initialEntries={['/chat/slot-A']}>
            <GuideProvider>
              <div data-testid="done"><GuideOfferCard guideId="g1" slotKey="slot-A" recordedStatus="completed" /></div>
              <div data-testid="lapsed"><GuideOfferCard guideId="g2" slotKey="slot-A" recordedStatus="offered" /></div>
            </GuideProvider>
          </MemoryRouter>
        </QueryClientProvider>
      </Provider>,
    )
    const done = await screen.findByText(L('finished_completed'))
    expect(screen.getByTestId('done').contains(done)).toBe(true)
    // An offer the store forgot never finished: it reads as expired, with no Start.
    await waitFor(() => expect(screen.getByTestId('lapsed').textContent).toContain(L('finished_expired')))
    expect(screen.queryByTestId('guide-start')).toBeNull()
  })

  it('a row in another slot\'s chat never draws this slot\'s live offer', async () => {
    pending = [guide()]
    renderGuide('/chat/slot-A', <div data-testid="pane-B"><GuideOfferCard guideId="g1" slotKey="slot-B" recordedStatus="offered" /></div>)
    await screen.findByTestId('guide-start')
    expect(screen.getAllByTestId('guide-start')).toHaveLength(1)
    expect(screen.getByTestId('pane-B').querySelector('[data-testid="guide-start"]')).toBeNull()
  })

  it('a read that left before the cancel answered cannot bring the offer back', () => {
    const cancelled = guide({ status: 'cancelled', revision: 2 })
    expect(reconcilePending([cancelled], [guide()])).toEqual([cancelled])
    // A newer server row wins, and a row the server dropped is dropped.
    const newer = guide({ revision: 3 })
    expect(reconcilePending([cancelled], [newer])).toEqual([newer])
    expect(reconcilePending([cancelled], [])).toEqual([])
  })

  it('a slot shows only its newest ended guide, and none while a guide is live', () => {
    const old = guide({ guide_id: 'g0', status: 'cancelled', finished_at: 5 })
    const recent = guide({ guide_id: 'g1', status: 'expired', finished_at: 9 })
    expect(endedBySlot([recent, old], new Set())['slot-A'].guide_id).toBe('g1')
    expect(endedBySlot([recent, old], new Set(['g1']))['slot-A'].guide_id).toBe('g0')
    expect(endedBySlot([old, guide({ guide_id: 'g2' })], new Set())['slot-A']).toBeUndefined()
    expect(endedBySlot([{ ...recent, dismissed: true }], new Set())['slot-A']).toBeUndefined()
  })

  it('a completed crewmate guide leaves the created line in the chat', async () => {
    pending = [guide()]
    renderGuide('/chat/slot-A')
    await screen.findByTestId('guide-start')
    const done = guide({ status: 'completed', revision: 5, actions: [{ id: 'crewmate.create', params: {}, result: { name: 'radar' } }] })
    act(() => applyGuideUpdate(qc, done))
    expect(await screen.findByText(L('finished_completed'))).toBeTruthy()
    expect(screen.getByTestId('guide-result-crewmate').textContent).toBe(i18nT('components.meetCrewmatesFlow.step4_title', { name: 'radar' }))
    expect(screen.queryByTestId('guide-pill')).toBeNull()
  })
})

describe('a surface the guide opened', () => {
  /** Stands in for the Crewmates page's creation flow. */
  function Surface({ pristine, onClose }: { pristine: boolean; onClose: () => void }) {
    const [open, setOpen] = useState(false)
    const mark = useGuideOpenedSurface('crewmate.create', {
      open,
      isPristine: () => pristine,
      close: () => { setOpen(false); onClose() },
    })
    return (
      <>
        <button type="button" data-testid="open-surface" onClick={() => { mark(); setOpen(true) }}>open</button>
        {open && <div data-testid="surface" />}
      </>
    )
  }

  const owned = () => guide({ status: 'active', owner_tab: TAB_ID, revision: 2 })

  it.each([
    ['cancelled', true, true],
    ['expired', true, true],
    ['cancelled', false, false],
    ['completed', true, false],
    // Ended because its save went through: the ready step stays on screen.
    ['saved_without_guide', true, false],
  ] as const)('a %s guide, untouched=%s, closes it: %s', async (status, pristine, closes) => {
    pending = [owned()]
    const onClose = vi.fn()
    renderGuide('/members', <Surface pristine={pristine} onClose={onClose} />, null)
    await waitFor(() => expect(qc.getQueryData<Guide[]>(GUIDE_PENDING_QUERY_KEY)).toHaveLength(1))
    fireEvent.click(screen.getByTestId('open-surface'))
    expect(screen.getByTestId('surface')).toBeTruthy()
    act(() => applyGuideUpdate(qc, guide(status === 'saved_without_guide'
      ? { status: 'cancelled', reason: 'saved_without_guide', revision: 3 }
      : { status, revision: 3 })))
    if (closes) {
      await waitFor(() => expect(screen.queryByTestId('surface')).toBeNull())
      expect(onClose).toHaveBeenCalledTimes(1)
    } else {
      await new Promise(r => setTimeout(r, 50))
      expect(screen.getByTestId('surface')).toBeTruthy()
      expect(onClose).not.toHaveBeenCalled()
    }
  })

  it('never closes a surface the user opened themselves', async () => {
    pending = []
    const onClose = vi.fn()
    renderGuide('/members', <Surface pristine onClose={onClose} />, null)
    fireEvent.click(screen.getByTestId('open-surface'))
    act(() => applyGuideUpdate(qc, guide({ status: 'cancelled', revision: 3 })))
    await new Promise(r => setTimeout(r, 50))
    expect(screen.getByTestId('surface')).toBeTruthy()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('the Crewmates page wires it to the guided flow and its edited flag', () => {
    const src = readFileSync(path.join(__dirname, '../pages/members/MembersPage.tsx'), 'utf-8')
    expect(src).toMatch(/useGuideOpenedSurface\('crewmate\.create'/)
    expect(src).toMatch(/isPristine: \(\) => !guidedEditedRef\.current && !guidedBusyRef\.current/)
    expect(src).toMatch(/markGuideOpenedRef\.current\(\)\n\s+openGuided\(/)
  })
})

describe('the way back once a guide ends', () => {
  const captainRow = { name: 'kirocrew-captain', kiro_agent: 'kirocrew-captain', slug: 'kirocrew-captain', slot_key: 'slot-cap', running: false }
  const radarRow = { name: 'radar', kiro_agent: 'kirocrew', slug: 'radar', slot_key: 'slot-radar', running: false }
  // A user-named "kirocrew-captain" on another template is an ordinary crewmate.
  const impostorRow = { name: 'kirocrew-captain', kiro_agent: 'kirocrew', slug: 'kirocrew-captain-2', slot_key: 'slot-fake', running: false }

  beforeEach(() => {
    __setCaptainForTests({ displayName: 'Skipper' })
    server.use(http.get('/api/members', () => HttpResponse.json({ members: [captainRow, radarRow, impostorRow] })))
  })
  afterEach(() => __setCaptainForTests(undefined))

  /** Owns *slot*'s guide in this tab, away from every chat, and lets it end. */
  async function endOwnedGuide(slot: string, how: 'complete' | 'cancel', at = '/settings/display/theme') {
    const owned = claimed(guide({ slot_key: slot }))
    pending = [owned]
    onWrite = (name) => (name === 'cancel' ? { ...owned, status: 'cancelled', revision: owned.revision + 1, finished_at: 10 } : null)
    renderGuide(at, undefined, null)
    await screen.findByTestId('guide-continue')
    if (how === 'cancel') {
      fireEvent.click(screen.getByRole('button', { name: L('cancel_guide') }))
      await waitFor(() => expect(writes('/api/guide/cancel')).toHaveLength(1))
    } else {
      act(() => applyGuideUpdate(qc, { ...owned, status: 'completed', revision: owned.revision + 1, finished_at: 10 }))
    }
  }

  it.each([['complete', 'finished_completed'], ['cancel', 'finished_cancelled']] as const)(
    '%s from Captain\'s chat: "Back to <Captain>" lands on Captain\'s thread and keeps its result line',
    async (how, finishedKey) => {
      await endOwnedGuide('slot-cap', how)
      const back = await screen.findByTestId('guide-back')
      expect(screen.getByTestId('guide-pill').textContent).toContain(L(finishedKey))
      expect(back.getAttribute('data-guide-return')).toBe('captain')
      expect(back.textContent).toBe(L('back_to_name', { name: 'Skipper' }))
      fireEvent.click(back)
      await waitFor(() => expect(screen.getByTestId('loc').textContent).toBe(CAPTAIN_ROUTE))
      await waitFor(() => expect(screen.queryByTestId('guide-pill')).toBeNull())
      // Going back is not a dismissal: Captain's chat still shows the result.
      expect(writes('/api/guide/dismiss')).toHaveLength(0)
      expect(endedBySlot(qc.getQueryData<Guide[]>(GUIDE_PENDING_QUERY_KEY) ?? [], new Set())['slot-cap']?.status)
        .toBe(how === 'cancel' ? 'cancelled' : 'completed')
    },
  )

  it('a guide from another crewmate\'s chat offers the chat wording, never Captain', async () => {
    await endOwnedGuide('slot-radar', 'complete')
    const back = await screen.findByTestId('guide-back')
    expect(back.getAttribute('data-guide-return')).toBe('chat')
    expect(back.textContent).toBe(i18nT('components.meetCrewmatesFlow.back_to_chat'))
    expect(screen.queryByText(L('back_to_name', { name: 'Skipper' }))).toBeNull()
    fireEvent.click(back)
    await waitFor(() => expect(screen.getByTestId('loc').textContent).toBe('/members?member=radar'))
  })

  it('a member merely NAMED kirocrew-captain is not Captain', async () => {
    await endOwnedGuide('slot-fake', 'complete')
    expect((await screen.findByTestId('guide-back')).getAttribute('data-guide-return')).toBe('chat')
  })

  it('a guide from an ordinary chat goes back to that chat', async () => {
    await endOwnedGuide('slot-A', 'cancel')
    fireEvent.click(await screen.findByTestId('guide-back'))
    await waitFor(() => expect(screen.getByTestId('loc').textContent).toBe('/chat?slot=slot-A'))
  })

  it('shows no way back while the user is already on Captain\'s chat', async () => {
    setViewedThreadSlot('slot-cap')
    await endOwnedGuide('slot-cap', 'complete', CAPTAIN_ROUTE)
    await act(async () => { await new Promise(r => setTimeout(r, 150)) })
    expect(screen.queryByTestId('guide-back')).toBeNull()
    expect(screen.queryByTestId('guide-pill')).toBeNull()
  })

  it('the step panel BECOMES the finish chip: one element, never unmounted between', async () => {
    const owned = claimed(guide({ slot_key: 'slot-cap' }))
    pending = [owned]
    renderGuide('/settings/display/theme', undefined, null)
    await screen.findByTestId('guide-continue')
    const panel = screen.getByTestId('guide-pill')
    const seen: Array<Element | null> = []
    const mo = new MutationObserver(() => seen.push(document.querySelector('[data-testid="guide-pill"]')))
    mo.observe(document.body, { childList: true, subtree: true })
    act(() => applyGuideUpdate(qc, { ...owned, status: 'completed', revision: owned.revision + 1, finished_at: 10 }))
    await screen.findByTestId('guide-back')
    mo.disconnect()
    expect(screen.getByTestId('guide-pill')).toBe(panel)
    expect(seen.every(el => el === panel)).toBe(true)
  })

  it('names no destination until the roster says whose chat it was', () => {
    expect(guideReturnFor('slot-cap', undefined, false)).toBeNull()
    expect(guideReturnFor('slot-cap', undefined, true)).toEqual({ kind: 'chat', to: '/chat?slot=slot-cap' })
    expect(guideReturnFor('slot-cap', [captainRow], false)).toEqual({ kind: 'captain', to: CAPTAIN_ROUTE })
  })

  it('reads a crewmate thread from its slot key, never the chat page, which does not show it', () => {
    expect(memberSlugOfSlot('member-radar')).toBe('radar')
    expect(memberSlugOfSlot('member-kirocrew-captain.memory-captain-v2')).toBe('kirocrew-captain')
    for (const k of ['member-', 'member-Radar', 'member--x', 'xmember-radar', 'chat-1-2', 'slot-A']) expect(memberSlugOfSlot(k)).toBeNull()
    const cap = { kind: 'captain', to: CAPTAIN_ROUTE }
    // Captain's thread is known from the key alone: pending, failed, or a stale binding.
    expect(guideReturnFor('member-kirocrew-captain', undefined, false)).toEqual(cap)
    expect(guideReturnFor('member-kirocrew-captain.memory-captain-v2', undefined, true)).toEqual(cap)
    expect(guideReturnFor('member-kirocrew-captain', [{ ...captainRow, slot_key: 'member-kirocrew-captain.memory-captain-v3' }], false)).toEqual(cap)
    // Another crewmate's: by exact name when one row carries the slug.
    const oncall = { name: 'Oncall', kiro_agent: 'kirocrew', slug: 'oncall', slot_key: 'member-oncall.memory-oncall-v2', running: false }
    expect(guideReturnFor('member-oncall', [oncall, radarRow], false)).toEqual({ kind: 'chat', to: '/members?member=Oncall' })
    // ...by slug when the roster failed, or two rows share the lossy slug.
    expect(guideReturnFor('member-radar', undefined, true)).toEqual({ kind: 'chat', to: '/members?member=radar' })
    expect(guideReturnFor('member-oncall', [oncall, { ...oncall, name: 'oncall', slot_key: '' }], false)).toEqual({ kind: 'chat', to: '/members?member=oncall' })
    // ...and the roster's answer is awaited for anyone but Captain.
    expect(guideReturnFor('member-radar', undefined, false)).toBeNull()
    // A non-Captain row carrying Captain's slug is that row, not Captain.
    expect(guideReturnFor('member-kirocrew-captain', [{ ...impostorRow, slug: 'kirocrew-captain' }], false)).toEqual({ kind: 'chat', to: '/members?member=kirocrew-captain' })
    // An ordinary chat slot still goes to the chat page.
    expect(guideReturnFor('chat-1-2', undefined, true)).toEqual({ kind: 'chat', to: '/chat?slot=chat-1-2' })
  })

  describe('a Captain chat opened from the sessions list', () => {
    const capChat = { key: 'chat-7-1700000000', agent: 'kirocrew-captain', agent_kind: 'member' as const, messages: 2, running: false }
    const plainChat = { key: 'chat-8-1700000000', agent: 'kirocrew', agent_kind: 'template' as const, messages: 2, running: false }
    beforeEach(() => { store.dispatch(sseSlots([capChat, plainChat])) })
    afterEach(() => { store.dispatch(sseSlots([{ ...plainChat, key: 'slot-A' }])) })

    it('its guide offers "Back to <Captain>" and lands on that chat', async () => {
      await endOwnedGuide(capChat.key, 'cancel')
      const back = await screen.findByTestId('guide-back')
      expect(back.getAttribute('data-guide-return')).toBe('captain')
      expect(back.textContent).toBe(L('back_to_name', { name: 'Skipper' }))
      fireEvent.click(back)
      await waitFor(() => expect(screen.getByTestId('loc').textContent).toBe(`/chat?slot=${capChat.key}`))
    })

    it('another agent\'s chat slot still offers the chat wording', async () => {
      await endOwnedGuide(plainChat.key, 'cancel')
      const back = await screen.findByTestId('guide-back')
      expect(back.getAttribute('data-guide-return')).toBe('chat')
      expect(back.textContent).toBe(i18nT('components.meetCrewmatesFlow.back_to_chat'))
    })

    it('reads Captain from the slot\'s agent, never a member merely named like it', () => {
      const to = { kind: 'captain', to: '/chat?slot=chat-7-1' }
      expect(guideReturnFor('chat-7-1', undefined, false, { agent: 'kirocrew-captain', agent_kind: 'member' })).toEqual(to)
      expect(guideReturnFor('chat-7-1', undefined, false, { agent: 'kirocrew-captain', agent_kind: 'template' })).toEqual(to)
      expect(guideReturnFor('chat-7-1', [captainRow], false, { agent: 'kirocrew-captain', agent_kind: '' })).toEqual(to)
      expect(isCaptainChatSlot({ agent: 'kirocrew-captain', agent_kind: 'member' }, [impostorRow])).toBe(false)
      expect(isCaptainChatSlot({ agent: 'kirocrew-captain', agent_kind: 'template' }, [impostorRow])).toBe(true)
      expect(isCaptainChatSlot({ agent: 'radar', agent_kind: 'member' }, [radarRow])).toBe(false)
      expect(isCaptainChatSlot(undefined, [captainRow])).toBe(false)
      expect(guideReturnFor('chat-7-1', [], false, { agent: 'kirocrew', agent_kind: 'template' })).toEqual({ kind: 'chat', to: '/chat?slot=chat-7-1' })
    })
  })

  it('a failed roster still sends Captain\'s guide back to Captain\'s thread', async () => {
    server.use(http.get('/api/members', () => HttpResponse.json({ error: 'boom' }, { status: 500 })))
    await endOwnedGuide('member-kirocrew-captain', 'cancel')
    const back = await screen.findByTestId('guide-back')
    expect(back.getAttribute('data-guide-return')).toBe('captain')
    expect(back.textContent).toBe(L('back_to_name', { name: 'Skipper' }))
    fireEvent.click(back)
    await waitFor(() => expect(screen.getByTestId('loc').textContent).toBe(CAPTAIN_ROUTE))
  })

  it.each([
    ['the roster failed', () => HttpResponse.json({ error: 'boom' }, { status: 500 }), '/members?member=radar'],
    ['the binding moved on', () => HttpResponse.json({ members: [captainRow, { ...radarRow, name: 'Radar', slot_key: 'member-radar.memory-radar-v2' }] }), '/members?member=Radar'],
  ])('a crewmate\'s guide goes back to that crewmate when %s', async (_why, members, to) => {
    server.use(http.get('/api/members', members))
    await endOwnedGuide('member-radar', 'complete')
    const back = await screen.findByTestId('guide-back')
    expect(back.textContent).toBe(i18nT('components.meetCrewmatesFlow.back_to_chat'))
    fireEvent.click(back)
    await waitFor(() => expect(screen.getByTestId('loc').textContent).toBe(to))
  })

  it('announces the end in a status region that was there before it', async () => {
    const owned = claimed(guide({ slot_key: 'member-kirocrew-captain' }))
    pending = [owned]
    renderGuide('/settings/display/theme', undefined, null)
    await screen.findByTestId('guide-continue')
    const status = screen.getByTestId('guide-finished-status')
    expect(status.getAttribute('role')).toBe('status')
    expect(status.getAttribute('aria-live')).toBe('polite')
    expect(status.textContent).toBe('')
    act(() => applyGuideUpdate(qc, { ...owned, status: 'cancelled', revision: owned.revision + 1, finished_at: 10 }))
    await screen.findByTestId('guide-back')
    expect(screen.getByTestId('guide-finished-status')).toBe(status)
    expect(status.textContent).toBe(L('finished_cancelled'))
    fireEvent.click(screen.getByTestId('guide-finished-close'))
    await waitFor(() => expect(status.textContent).toBe(''))
  })

  it('the finish chip\'s close and way back are 44px touch targets', async () => {
    await endOwnedGuide('member-kirocrew-captain', 'complete')
    for (const el of [await screen.findByTestId('guide-back'), screen.getByTestId('guide-finished-close')]) {
      expect(el.className).toMatch(/\bmin-h-11\b/)
    }
    expect(screen.getByTestId('guide-finished-close').className).toMatch(/\bmin-w-11\b/)
  })

  /** A Settings row the settings.show guide points at, with a laid-out box. */
  function SettingRow() {
    const entry = SETTINGS_REGISTRY.find(e => e.id === 'chat.default-model')!
    return (
      <div
        data-setting-label={i18nT(entry.labelKey!)}
        ref={(el) => {
          if (el) el.getBoundingClientRect = () => ({ top: 300, left: 100, width: 80, height: 30, right: 180, bottom: 330, x: 100, y: 300, toJSON: () => ({}) }) as DOMRect
        }}
      >
        row
      </div>
    )
  }

  it('Done that finishes the guide moves focus to the way back; closing returns it to the page', async () => {
    const g = guide({ slot_key: 'member-kirocrew-captain', actions: [{ id: 'settings.show', params: { setting_id: 'chat.default-model' } }] })
    let current = claimed(g)
    pending = [current]
    onWrite = (name) => {
      if (name === 'progress') current = { ...current, status: 'completed', revision: current.revision + 1, finished_at: 10 }
      return current
    }
    render(
      <Provider store={store}>
        <QueryClientProvider client={(qc = new QueryClient({ defaultOptions: { queries: { retry: false } } }))}>
          <MemoryRouter initialEntries={['/overview']}>
            <GuideProvider>
              <main id="main-content" tabIndex={-1}><GuideLayer /><SettingRow /><LocationProbe /></main>
            </GuideProvider>
          </MemoryRouter>
        </QueryClientProvider>
      </Provider>,
    )
    fireEvent.click(await screen.findByTestId('guide-continue'))
    const next = await screen.findByTestId('guide-next')
    await waitFor(() => expect((next as HTMLButtonElement).disabled).toBe(false))
    // The guide's only step: the button ends it, so it reads Done, not Next.
    expect(next.textContent).toBe(i18nT('components.meetCrewmatesFlow.done'))
    expect(next.textContent).not.toBe(L('next'))
    act(() => next.focus())
    fireEvent.click(next)
    const back = await screen.findByTestId('guide-back')
    await waitFor(() => expect(document.activeElement).toBe(back))
    act(() => screen.getByTestId('guide-finished-close').focus())
    fireEvent.click(screen.getByTestId('guide-finished-close'))
    await waitFor(() => expect(screen.queryByTestId('guide-pill')).toBeNull())
    expect(document.activeElement).toBe(document.getElementById('main-content'))
  })

  it('Done works again on a replayed guide', async () => {
    const g = guide({ slot_key: 'member-kirocrew-captain', actions: [{ id: 'settings.show', params: { setting_id: 'chat.default-model' } }] })
    let current = claimed(g)
    pending = [current]
    onWrite = (name) => {
      if (name === 'progress') current = { ...current, status: 'completed', revision: current.revision + 1, finished_at: 10 }
      if (name === 'claim') current = { ...current, status: 'active', owner_tab: TAB_ID, revision: current.revision + 1 }
      return current
    }
    server.use(http.post('/api/guide/replay', async ({ request }) => {
      calls.push({ path: '/api/guide/replay', body: (await request.json()) as Record<string, unknown>, headers: request.headers })
      current = { ...current, status: 'offered', owner_tab: null, revision: current.revision + 1, finished_at: null, step_index: 0, action_index: 0 }
      return HttpResponse.json({ guide: current })
    }))
    render(
      <Provider store={store}>
        <QueryClientProvider client={(qc = new QueryClient({ defaultOptions: { queries: { retry: false } } }))}>
          <MemoryRouter initialEntries={['/overview']}>
            <GuideProvider>
              <main id="main-content" tabIndex={-1}>
                <GuideLayer /><SettingRow /><LocationProbe />
                <GuideOfferCard guideId={g.guide_id} slotKey="member-kirocrew-captain" />
              </main>
            </GuideProvider>
          </MemoryRouter>
        </QueryClientProvider>
      </Provider>,
    )
    fireEvent.click(await screen.findByTestId('guide-continue'))
    const first = await screen.findByTestId('guide-next')
    await waitFor(() => expect((first as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(first)
    await waitFor(() => expect(writes('/api/guide/progress')).toHaveLength(1))
    fireEvent.click(await screen.findByTestId('guide-replay'))
    await waitFor(() => expect(writes('/api/guide/claim')).toHaveLength(1))
    const again = await screen.findByTestId('guide-next')
    await waitFor(() => expect((again as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(again)
    await waitFor(() => expect(writes('/api/guide/progress')).toHaveLength(2))
  })

  it('a replayed multi-action guide enters each action\'s page again', async () => {
    const actions = [{ id: 'settings.show', params: { setting_id: 'chat.default-model' } }, { id: 'mcp.open_add', params: {} }]
    const g = guide({ slot_key: 'member-kirocrew-captain', actions })
    let current: Guide = { ...claimed(g), action_index: 1, step_index: 0 }
    pending = [current]
    onWrite = (name) => {
      if (name === 'claim') current = { ...current, status: 'active', owner_tab: TAB_ID, revision: current.revision + 1, action_index: 0, step_index: 0 }
      return current
    }
    server.use(http.post('/api/guide/replay', async ({ request }) => {
      calls.push({ path: '/api/guide/replay', body: (await request.json()) as Record<string, unknown>, headers: request.headers })
      current = { ...current, status: 'offered', owner_tab: null, revision: current.revision + 1, finished_at: null, action_index: 0, step_index: 0 }
      return HttpResponse.json({ guide: current })
    }))
    render(
      <Provider store={store}>
        <QueryClientProvider client={(qc = new QueryClient({ defaultOptions: { queries: { retry: false } } }))}>
          <MemoryRouter initialEntries={['/overview']}>
            <GuideProvider>
              <main id="main-content" tabIndex={-1}>
                <GuideLayer /><SettingRow /><LocationProbe />
                <GuideOfferCard guideId={g.guide_id} slotKey="member-kirocrew-captain" />
              </main>
            </GuideProvider>
          </MemoryRouter>
        </QueryClientProvider>
      </Provider>,
    )
    // The first walk entered the second action in this tab.
    fireEvent.click(await screen.findByTestId('guide-continue'))
    await waitFor(() => expect(screen.queryByTestId('guide-continue')).toBeNull())
    current = { ...current, status: 'completed', owner_tab: null, revision: current.revision + 1, finished_at: 10 }
    act(() => { qc.setQueryData(GUIDE_PENDING_QUERY_KEY, [current]) })
    fireEvent.click(await screen.findByTestId('guide-replay'))
    await waitFor(() => expect(writes('/api/guide/claim')).toHaveLength(1))
    // The gateway advances the replay to its second action.
    current = { ...current, action_index: 1, step_index: 0, revision: current.revision + 1 }
    act(() => { qc.setQueryData(GUIDE_PENDING_QUERY_KEY, [current]) })
    expect(await screen.findByTestId('guide-continue')).toBeTruthy()
  })

  it('a settings step another action follows keeps Next', async () => {
    const g = guide({ slot_key: 'member-kirocrew-captain', actions: [{ id: 'settings.show', params: { setting_id: 'chat.default-model' } }, { id: 'mcp.open_add', params: {} }] })
    pending = [claimed(g)]
    onWrite = () => null
    render(
      <Provider store={store}>
        <QueryClientProvider client={(qc = new QueryClient({ defaultOptions: { queries: { retry: false } } }))}>
          <MemoryRouter initialEntries={['/overview']}>
            <GuideProvider>
              <main id="main-content" tabIndex={-1}><GuideLayer /><SettingRow /><LocationProbe /></main>
            </GuideProvider>
          </MemoryRouter>
        </QueryClientProvider>
      </Provider>,
    )
    fireEvent.click(await screen.findByTestId('guide-continue'))
    const next = await screen.findByTestId('guide-next')
    expect(next.textContent).toBe(L('next'))
  })

  it('Cancel moves focus into the chip; a guide that ends while the user works elsewhere does not steal focus', async () => {
    await endOwnedGuide('member-kirocrew-captain', 'cancel')
    // Cancel was clicked without focusing it (a mouse on Safari): focus stays put.
    expect(document.activeElement).toBe(document.body)
    cleanup()

    const owned = claimed(guide({ slot_key: 'member-kirocrew-captain' }))
    pending = [owned]
    onWrite = (name) => (name === 'cancel' ? { ...owned, status: 'cancelled', revision: owned.revision + 1, finished_at: 10 } : null)
    renderGuide('/settings/display/theme', undefined, null)
    await screen.findByTestId('guide-continue')
    const cancel = screen.getByRole('button', { name: L('cancel_guide') })
    act(() => cancel.focus())
    fireEvent.click(cancel)
    const back = await screen.findByTestId('guide-back')
    await waitFor(() => expect(document.activeElement).toBe(back))
    cleanup()

    // Focus was in the panel, then the user pressed on the page (a spot that
    // takes no focus, so the blur names no new target).
    pending = [owned]
    renderGuide('/settings/display/theme', <p data-testid="page-text">text</p>, null)
    const cont = await screen.findByTestId('guide-continue')
    act(() => cont.focus())
    fireEvent.pointerDown(screen.getByTestId('page-text'))
    act(() => cont.blur())
    act(() => applyGuideUpdate(qc, { ...owned, status: 'completed', revision: owned.revision + 1, finished_at: 10 }))
    await screen.findByTestId('guide-back')
    await act(async () => { await new Promise(r => setTimeout(r, 50)) })
    expect(document.activeElement).toBe(document.body)
  })
})
