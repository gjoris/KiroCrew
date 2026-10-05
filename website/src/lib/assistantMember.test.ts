import { describe, expect, it } from 'vitest'
import { ApiError } from '../api/apiError'
import { ASSISTANT_KIRO_AGENT, ASSISTANT_MEMBER_NAME, captainIdentityRefusal, isAssistantMember, isOfferableTemplate } from './assistantMember'

describe('assistantMember', () => {
  it('recognises the built-in Assistant only on its own template', () => {
    expect(isAssistantMember({ name: 'kirocrew-captain', kiro_agent: ASSISTANT_KIRO_AGENT })).toBe(true)
    expect(isAssistantMember({ name: 'kirocrew-captain', kiro_agent: 'kirocrew' })).toBe(false)
    expect(isAssistantMember({ name: 'helper', kiro_agent: ASSISTANT_KIRO_AGENT })).toBe(false)
    expect(isAssistantMember(null)).toBe(false)
  })

  it('never offers the Assistant template as another crewmate\'s Built from choice', () => {
    expect(isOfferableTemplate(ASSISTANT_KIRO_AGENT)).toBe(false)
    expect(isOfferableTemplate('kirocrew')).toBe(true)
    expect(isOfferableTemplate('my-template')).toBe(true)
    // A spec left over from before the template was renamed is an ordinary template.
    expect(isOfferableTemplate('kirocrew-assistant')).toBe(true)
  })

  it('keys Captain by `kirocrew-captain`; a member named `assistant` is ordinary', () => {
    expect(ASSISTANT_MEMBER_NAME).toBe('kirocrew-captain')
    expect(isAssistantMember({ name: 'assistant', kiro_agent: ASSISTANT_KIRO_AGENT })).toBe(false)
  })

  it('maps only the two Captain identity refusals to localized sentences', () => {
    const err = (status: number, code: string) => new ApiError(status, 'x', JSON.stringify({ code }))
    expect(captainIdentityRefusal(err(409, 'assistant_name_taken'))).toContain('belongs to Captain')
    expect(captainIdentityRefusal(err(409, 'assistant_member_reserved'))).toContain('reserved for Captain')
    expect(captainIdentityRefusal(err(409, 'agent_exists'))).toBeNull()
    expect(captainIdentityRefusal(err(400, 'assistant_name_taken'))).toBeNull()
    expect(captainIdentityRefusal(new Error('network'))).toBeNull()
  })
})
