import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, render, screen, fireEvent } from '@testing-library/react'
import AskAgentButton, { askAgentHard } from '../components/AskAgentButton'
import {
  CAPTAIN_HANDOFF_TARGET,
  CAPTAIN_ROUTE,
  __setCaptainForTests,
  errorHandoffDestination,
  publishCaptainFromAgents,
} from '../lib/captainHandoff'
import {
  __resetErrorJournalForTests,
  __resetNavSeamForTests,
  consumeChatHandoff,
  installSoftNavigate,
} from '../utils/errorReport'
import { i18nT } from '../i18n/t'

/* Error hand-offs name Captain (the built-in Assistant crewmate) and open
 * Captain's thread instead of a fresh /chat session. Without a Captain on the
 * roster (the user deleted it) the original generic hand-off is kept. */

const CAPTAIN_ROW = { name: 'kirocrew-captain', kiro_agent: 'kirocrew-captain', display_name: '' }

beforeEach(() => {
  sessionStorage.clear()
  __resetErrorJournalForTests()
  __resetNavSeamForTests()
  __setCaptainForTests(undefined)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('Captain error hand-off', () => {
  it('labels the hand-off with Captain\'s default display name', () => {
    publishCaptainFromAgents([CAPTAIN_ROW])
    render(<AskAgentButton message="zzq-boom" />)
    const name = i18nT('components.assistantWelcome.default_name')
    expect(screen.getByRole('button').textContent).toBe(`Ask ${name}`)
  })

  it('follows a user rename live', () => {
    publishCaptainFromAgents([{ ...CAPTAIN_ROW, display_name: 'Mochi' }])
    render(<AskAgentButton message="zzq-boom" />)
    expect(screen.getByRole('button').textContent).toBe('Ask Mochi')
    act(() => { publishCaptainFromAgents([{ ...CAPTAIN_ROW, display_name: 'Skipper' }]) })
    expect(screen.getByRole('button').textContent).toBe('Ask Skipper')
  })

  it('navigates to Captain\'s thread and tags the prompt for Captain\'s composer', () => {
    publishCaptainFromAgents([CAPTAIN_ROW])
    const nav = vi.fn()
    installSoftNavigate(nav)
    render(<AskAgentButton message="zzq-route-boom" />)
    fireEvent.click(screen.getByRole('button'))
    expect(nav).toHaveBeenCalledWith(CAPTAIN_ROUTE)
    expect(CAPTAIN_ROUTE).toBe('/members?member=kirocrew-captain')
    expect(errorHandoffDestination()).toBe(CAPTAIN_ROUTE)
    // A fresh /chat drain must not take it; Captain's drain does.
    expect(consumeChatHandoff()).toBeNull()
    expect(consumeChatHandoff({ target: CAPTAIN_HANDOFF_TARGET })).toContain('zzq-route-boom')
  })

  it('the root boundary\'s hard path does a full page load to Captain\'s route', () => {
    publishCaptainFromAgents([CAPTAIN_ROW])
    const assign = vi.fn()
    vi.spyOn(window, 'location', 'get').mockReturnValue({ ...window.location, assign } as Location)
    askAgentHard('zzq-hard-boom')
    expect(assign).toHaveBeenCalledWith(CAPTAIN_ROUTE)
    expect(consumeChatHandoff({ target: CAPTAIN_HANDOFF_TARGET })).toContain('zzq-hard-boom')
  })

  it('without a Captain keeps the generic label and the fresh /chat hand-off', () => {
    // A user crewmate merely NAMED assistant on another template is not Captain.
    publishCaptainFromAgents([{ name: 'kirocrew-captain', kiro_agent: 'my-template' }])
    const nav = vi.fn()
    installSoftNavigate(nav)
    render(<AskAgentButton message="zzq-nocap-boom" />)
    expect(screen.getByRole('button').textContent).toBe('Ask the agent')
    fireEvent.click(screen.getByRole('button'))
    expect(nav).toHaveBeenCalledWith('/chat')
    expect(errorHandoffDestination()).toBe('/chat')
    expect(consumeChatHandoff({ target: CAPTAIN_HANDOFF_TARGET })).toBeNull()
    expect(consumeChatHandoff()).toContain('zzq-nocap-boom')
  })

  it('leaves non-error asks (git panel) unchanged', () => {
    publishCaptainFromAgents([{ ...CAPTAIN_ROW, display_name: 'Mochi' }])
    expect(i18nT('components.gitPanel.ask_agent_changes')).toBe('Ask the agent about the changes')
    expect(i18nT('components.gitPanel.ask_agent_history')).toBe('Ask the agent about the history')
  })
})
