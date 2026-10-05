/**
 * A schedule card that runs ONCE: the gateway marks it `once: true` (on the
 * card or in its params) and carries an `at` param instead of `cron_expr`,
 * with the resolved run time in `next_run_at`. Such a card has no recurrence,
 * so it reads "Runs once" and a date, never a cron humanization or "Next run".
 */
import { i18nT } from '../i18n/t'
import { activeLocale, fmtDateFields, fmtRelative, toDate } from '../i18n/format'
import type { Card } from '../api/cards'

const SCHEDULE_KINDS = new Set(['schedule.create', 'schedule.update'])

type OneShotCard = Pick<Card, 'kind' | 'params'> & Partial<Pick<Card, 'once' | 'next_run_at' | 'timezone'>>

export function isOneShot(card: OneShotCard): boolean {
  if (!SCHEDULE_KINDS.has(card.kind)) return false
  if (card.once === true || card.params.once === true) return true
  const at = card.params.at
  return (typeof at === 'string' ? at.trim() !== '' : typeof at === 'number') && !card.params.cron_expr
}

/** The card's time zone: the gateway's resolved one, else the param. */
export function cardTimezone(card: OneShotCard): string | undefined {
  return card.timezone ?? (typeof card.params.timezone === 'string' ? card.params.timezone : undefined)
}

const DAY: Intl.DateTimeFormatOptions = { year: 'numeric', month: 'numeric', day: 'numeric' }

/**
 * When a one-shot runs, in the reader's language and the schedule's zone:
 * "Tomorrow, Oct 4 · 9:00 AM PDT". Today / tomorrow read relatively; any other
 * day names its weekday. `capitalize` is for a value that starts a row; a
 * value inside a sentence keeps the locale's own lowercase ("tomorrow").
 */
export function fmtOneShot(
  value: string | number | null | undefined,
  timeZone?: string,
  { capitalize = true, now = Date.now() }: { capitalize?: boolean; now?: number } = {},
): string | null {
  const d = toDate(value ?? null)
  if (!d) return null
  const tz = timeZone ? { timeZone } : {}
  const dayOf = (x: number) => fmtDateFields(x, { ...DAY, ...tz })
  const target = dayOf(d.getTime())
  const sameYear = fmtDateFields(d, { year: 'numeric', ...tz }) === fmtDateFields(now, { year: 'numeric', ...tz })
  let day: string
  if (target === dayOf(now)) day = fmtRelative(now, { now, unit: 'day', style: 'long' })
  else if (target === dayOf(now + 86_400_000)) day = fmtRelative(now + 86_400_000, { now, unit: 'day', style: 'long' })
  else day = fmtDateFields(d, { weekday: 'short', ...tz })
  if (capitalize) day = day.charAt(0).toLocaleUpperCase(activeLocale()) + day.slice(1)
  const date = fmtDateFields(d, { month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }), ...tz })
  const time = fmtDateFields(d, { hour: 'numeric', minute: '2-digit', timeZoneName: 'short', ...tz })
  return i18nT('components.changeCards.schedule_once_when', { day, date, time })
}

/** The one-shot's run time: the gateway's resolved `next_run_at`, else `at`. */
export function oneShotWhen(card: OneShotCard, opts?: { capitalize?: boolean; now?: number }): string | null {
  const at = card.params.at
  const raw = card.next_run_at ?? (typeof at === 'string' || typeof at === 'number' ? at : null)
  return fmtOneShot(raw, cardTimezone(card), opts)
}

/**
 * When a one-shot runs, as a timestamp, or null for anything else. A run time
 * that has passed cannot be scheduled (the gateway answers `at_in_past`), so
 * the card has to know before the person presses the button, not after.
 */
export function oneShotRunAt(card: OneShotCard): number | null {
  if (!isOneShot(card)) return null
  const at = card.params.at
  const d = toDate(card.next_run_at ?? (typeof at === 'string' || typeof at === 'number' ? at : null))
  return d ? d.getTime() : null
}
