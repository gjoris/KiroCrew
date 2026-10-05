/**
 * The built-in Assistant crewmate.
 *
 * The Assistant (Captain) is its own built-in crew member (config key
 * `kirocrew-captain`, bound to the template of the same name), separate from the
 * reserved `default` member, which keeps its ordinary presentation. BOTH halves
 * identify it: a member under any other key -- including one a user named
 * `assistant` -- is an ordinary crewmate and gets none of Captain's behaviour.
 * The key is Captain's identity; its display name is only a label.
 */

import { ApiError } from '../api/apiError'
import { i18nT } from '../i18n/t'
import { parseErrorCode } from '../utils/errorReport'

export const ASSISTANT_MEMBER_NAME = 'kirocrew-captain'
export const ASSISTANT_KIRO_AGENT = 'kirocrew-captain'

/** True only for the built-in Assistant: key `kirocrew-captain` AND its template. */
export function isAssistantMember(m: { name?: string; kiro_agent?: unknown } | null | undefined): boolean {
  return !!m && m.name === ASSISTANT_MEMBER_NAME && m.kiro_agent === ASSISTANT_KIRO_AGENT
}

/** Whether a template may be OFFERED as a crewmate's "Built from" choice.
 *  `kirocrew-captain` is the Assistant's own singleton template (its
 *  capability overrides are re-applied by the installer), so no other member
 *  is built from it. The pickers still show it as the CURRENT value when the
 *  member being edited is the Assistant itself: they re-add a bound value that
 *  is missing from the list. */
export function isOfferableTemplate(name: string): boolean {
  return name !== ASSISTANT_KIRO_AGENT
}

/** The gateway's refusal codes for a change that would blur Captain's identity. */
export const ASSISTANT_MEMBER_RESERVED = 'assistant_member_reserved'
export const ASSISTANT_NAME_TAKEN = 'assistant_name_taken'

/** The localized sentence for a create or rename the gateway refused because it
 *  would take Captain's key or Captain's name, else `null`. */
export function captainIdentityRefusal(e: unknown): string | null {
  if (!(e instanceof ApiError) || e.status !== 409) return null
  const code = parseErrorCode(e.body)
  if (code === ASSISTANT_MEMBER_RESERVED) return i18nT('lib.captainIdentity.reserved')
  if (code === ASSISTANT_NAME_TAKEN) return i18nT('lib.captainIdentity.name_taken')
  return null
}
