import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { DisplayNameField, displayNameFallback } from '../pages/KiroCrewAgentsPage'
import type { KiroCrewAgent } from '../components/AgentSelector'

const captain = { name: 'kirocrew-captain', kiro_agent: 'kirocrew-captain', display_name: '' } as KiroCrewAgent
const ordinary = { name: 'pr-buddy', kiro_agent: 'kirocrew', display_name: '' } as KiroCrewAgent

describe('Captain display name in the crew editor', () => {
  it('falls back to the default Captain name, never the member key', () => {
    expect(displayNameFallback(captain, 'kirocrew-captain')).toBe('Captain')
    expect(displayNameFallback(ordinary, 'pr-buddy')).toBe('pr-buddy')
    expect(displayNameFallback(undefined, 'pr-buddy')).toBe('pr-buddy')
  })

  it('an empty Captain field shows Captain, and the hint never names the key', () => {
    const { container } = render(
      <DisplayNameField value="" onChange={() => {}} fallback={displayNameFallback(captain, 'kirocrew-captain')} />,
    )
    expect(screen.getByTestId('display-name-input')).toHaveAttribute('placeholder', 'Captain')
    expect(container.textContent).not.toContain('kirocrew-captain')
  })

  it('a renamed Captain shows the rename', () => {
    render(<DisplayNameField value="Skipper" onChange={() => {}} fallback="Captain" />)
    expect(screen.getByTestId('display-name-input')).toHaveValue('Skipper')
  })
})
