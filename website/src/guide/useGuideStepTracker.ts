/**
 * Finds the control the current guide step points at and follows it.
 *
 * The target is the ONE element the registry names: a registered
 * `data-guide-anchor`, or the exact Settings row (`resolveSettingElementStrict`).
 * It must be visibly rendered; nothing near it stands in. While it is absent
 * the tracker waits a bounded time for a panel that mounts late, then reports
 * `target_missing` once. A `reach` step reports `observed` once the UI shows a
 * later registered anchor — the human moved the form on. A `committed` step is
 * never reported by the browser; after its save was submitted, the target
 * leaving (a dialog closing on success) is not "missing" either. Once a step
 * IS missing, the same hook runs in `recover` mode: the target (or a later
 * anchor of a `reach` step) coming back reports `onFound`, re-offered on a
 * slower cadence a bounded number of times so one failed write does not
 * strand it, and the gateway returns the guide to that same step.
 */
import { useEffect, useRef, useState } from 'react'
import { resolveSettingElementStrict } from '../hooks/useSettingHighlight'
import { findGuideAnchor, type GuideStepPlan, type GuideTarget } from './guideActions'

/** How long a registered target may take to appear before it is missing. */
export const GUIDE_TARGET_WAIT_MS = 10_000
/** How long the page must show an EARLIER step of the action, with this step's
 *  target absent, before the step counts as missing (and recovers back there). */
export const GUIDE_EARLIER_STEP_WAIT_MS = 1_500
/** Poll cadence while a step is tracked; scroll and resize re-measure at once. */
export const GUIDE_TRACK_TICK_MS = 250
/** A recovered target re-offers `onFound` this often until the guide resumes. */
export const GUIDE_FOUND_RETRY_MS = 2_000
/** How many times a recovered target is offered before the tracker gives up. */
export const GUIDE_FOUND_MAX_ATTEMPTS = 5

export interface GuideRect {
  top: number
  left: number
  width: number
  height: number
}

export function resolveGuideTarget(target: GuideTarget): HTMLElement | null {
  return target.kind === 'anchor' ? findGuideAnchor(target.anchor) : resolveSettingElementStrict(target.entry)
}

/** Rendered and painted: connected, non-empty box, not hidden or inert. */
export function isGuideTargetVisible(el: HTMLElement | null): el is HTMLElement {
  if (!el || !el.isConnected) return false
  if (el.closest('[hidden], [inert]')) return false
  const style = window.getComputedStyle(el)
  if (style.visibility === 'hidden' || style.display === 'none') return false
  const r = el.getBoundingClientRect()
  return r.width > 0 && r.height > 0
}

const sameRect = (a: GuideRect | null, b: GuideRect | null) =>
  a === b || (!!a && !!b && a.top === b.top && a.left === b.left && a.width === b.width && a.height === b.height)

/** Index of the LATEST earlier step whose own target is visible, or -1. */
export function latestVisibleEarlierStep(steps: readonly GuideStepPlan[] | undefined): number {
  if (!steps) return -1
  for (let i = steps.length - 1; i >= 0; i--) {
    if (isGuideTargetVisible(resolveGuideTarget(steps[i].target))) return i
  }
  return -1
}

export function useGuideStepTracker({
  stepId,
  step,
  enabled,
  recover = false,
  suppressMissing,
  reduceMotion,
  onObserved,
  onMissing,
  onFound,
  earlierSteps,
}: {
  /** Changes whenever the tracked step changes (guide, action, step). */
  stepId: string
  step: GuideStepPlan | null
  enabled: boolean
  /** The step's target went missing: watch for it to come back instead of
   *  tracking it. Seeing the target (or, for a `reach` step, a later anchor)
   *  reports `onFound` once; nothing is outlined and nothing goes missing. */
  recover?: boolean
  /** The committed save was submitted: absence now means "waiting", not missing. */
  suppressMissing: boolean
  reduceMotion: boolean
  /** Each report callback returns false when nothing was sent (a report is
   *  already in flight or accepted); that offer does not count as an attempt. */
  onObserved: () => boolean | void
  onMissing: () => boolean | void
  /** `resumeStepIndex` is set when an EARLIER step's target came back instead. */
  onFound?: (resumeStepIndex?: number) => boolean | void
  /** The current action's steps before this one, in order. */
  earlierSteps?: readonly GuideStepPlan[]
}): GuideRect | null {
  const [rect, setRect] = useState<GuideRect | null>(null)
  const cb = useRef({ onObserved, onMissing, onFound, suppressMissing, earlierSteps })
  cb.current = { onObserved, onMissing, onFound, suppressMissing, earlierSteps }

  useEffect(() => {
    setRect(null)
    if (!enabled || !step) return
    let done = false
    let lastReport: number | null = null
    let reportAttempts = 0
    let missingSince: number | null = null
    let scrolled = false
    let frame = 0
    const tick = () => {
      if (done) return
      if (recover) {
        const back = isGuideTargetVisible(resolveGuideTarget(step.target))
          || (step.complete.kind === 'reach' && step.complete.anchors.some(a => isGuideTargetVisible(findGuideAnchor(a))))
        // Not this step, but an earlier one of the same action: the page came
        // back started over (a remounted form), so the guide follows it back.
        const earlier = back ? -1 : latestVisibleEarlierStep(cb.current.earlierSteps)
        if (!back && earlier < 0) return
        // The report can fail (network, a refused write): keep watching and
        // offer it again on a slower cadence, a bounded number of times. The
        // Provider de-duplicates while one is in flight or accepted.
        const now = Date.now()
        if (lastReport !== null && now - lastReport < GUIDE_FOUND_RETRY_MS) return
        // Only a report actually sent counts: one the Provider swallowed (the
        // previous is still in flight) must not use up an attempt, or the
        // tracker gives up while the Provider still thinks retries remain.
        if (cb.current.onFound?.(back ? undefined : earlier) === false) return
        lastReport = now
        reportAttempts += 1
        if (reportAttempts >= GUIDE_FOUND_MAX_ATTEMPTS) done = true
        return
      }
      if (step.complete.kind === 'reach' && step.complete.anchors.some(a => isGuideTargetVisible(findGuideAnchor(a)))) {
        setRect(null)
        // Offered again on the same bounded cadence as the other reports: a
        // failed write must not leave the guide a step behind the form.
        const now = Date.now()
        if (lastReport !== null && now - lastReport < GUIDE_FOUND_RETRY_MS) return
        if (cb.current.onObserved() === false) return
        lastReport = now
        reportAttempts += 1
        if (reportAttempts >= GUIDE_FOUND_MAX_ATTEMPTS) done = true
        return
      }
      const el = resolveGuideTarget(step.target)
      if (isGuideTargetVisible(el)) {
        missingSince = null
        if (!scrolled) {
          scrolled = true
          el.scrollIntoView?.({ block: 'center', behavior: reduceMotion ? 'auto' : 'smooth' })
        }
        const r = el.getBoundingClientRect()
        const next = { top: r.top, left: r.left, width: r.width, height: r.height }
        setRect(prev => (sameRect(prev, next) ? prev : next))
        return
      }
      setRect(null)
      if (cb.current.suppressMissing) { missingSince = null; return }
      const now = Date.now()
      if (missingSince === null) missingSince = now
      else if (
        now - missingSince >= GUIDE_TARGET_WAIT_MS
        // The page already shows an earlier step of this action: it started
        // over, so there is nothing to wait out before recovering at it.
        || (now - missingSince >= GUIDE_EARLIER_STEP_WAIT_MS && latestVisibleEarlierStep(cb.current.earlierSteps) >= 0)
      ) {
        // Re-offered like a recovery: a failed write must not strand the
        // guide on a step the page no longer shows.
        if (lastReport !== null && now - lastReport < GUIDE_FOUND_RETRY_MS) return
        if (cb.current.onMissing() === false) return
        lastReport = now
        reportAttempts += 1
        if (reportAttempts >= GUIDE_FOUND_MAX_ATTEMPTS) done = true
      }
    }
    const onMove = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(tick)
    }
    tick()
    const id = setInterval(tick, GUIDE_TRACK_TICK_MS)
    window.addEventListener('scroll', onMove, true)
    window.addEventListener('resize', onMove)
    return () => {
      done = true
      clearInterval(id)
      cancelAnimationFrame(frame)
      window.removeEventListener('scroll', onMove, true)
      window.removeEventListener('resize', onMove)
    }
    // `stepId` names the step; `step` is derived from it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stepId, enabled, recover, reduceMotion])

  return rect
}
