/**
 * Closing a session tree — option B: refuse while any descendant runs (#17253).
 *
 * The ✕ has two outcomes:
 *   - any running descendant → refuses; a notice lists which are running; nothing closes.
 *   - no running descendants → closes silently (pref off) or asks once with useConfirm (pref on).
 *
 * There is no "close anyway" on the refusal notice.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Provider } from 'react-redux'

const chatConfig = vi.hoisted(() => ({ confirmCloseSession: false }))
vi.mock('../pages/chat/ChatSettings', () => ({ loadChatConfig: () => chatConfig }))

const deleteSlot = vi.hoisted(() => vi.fn((key: string) => () => ({
  unwrap: async () => key,
})))
vi.mock('../store/chatSlice', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  deleteSlot,
}))

import { store } from '../store'
import { planCloseTree, type CloseTreeRow } from '../lib/sessionCloseTree'
import { useCloseSessionTree } from '../hooks/useCloseSessionTree'

interface Row extends CloseTreeRow {
  key: string
  title?: string
  running?: boolean
}

const root = (key: string, title: string, running = false): Row =>
  ({ key, title, running, parent: null })
const child = (key: string, title: string, parent: string, running = false): Row =>
  ({ key, title, running, parent: { slot: parent, key: parent } })

const isRunning = (row: Row) => row.running === true
const closedOrder = () => deleteSlot.mock.calls.map(([key]) => key)

function Press({ rows }: { rows: Row[] }) {
  const { closeSessionTree, closeTreeDialog, closeTreeError } = useCloseSessionTree({
    rows, isRunning, closeOne: (key: string) => closeOneSpy(key),
  })
  return (
    <>
      <button data-testid="x" onClick={() => closeSessionTree('lead')}>x</button>
      {closeTreeDialog}
      {closeTreeError}
    </>
  )
}

function Harness({ rows }: { rows: Row[] }) {
  return (
    <Provider store={store}>
      <Press rows={rows} />
    </Provider>
  )
}

let closeOneSpy = vi.fn()

/** lead ─ w1 (running) ─ sub1 (running) / sub2 ; w2 */
const RUNNING_TREE: Row[] = [
  root('lead', 'pipeline-conductor', true),
  child('w1', 'worker - babysit', 'lead', true),
  child('sub1', 'subworker - rerun lane', 'w1', true),
  child('sub2', 'subworker - log fetch', 'w1'),
  child('w2', 'worker - locale sweep', 'lead'),
]

/** Same tree, every descendant finished (lead itself is still running). */
const IDLE_TREE: Row[] = RUNNING_TREE.map(r => ({ ...r, running: r.key === 'lead' }))

beforeEach(() => {
  deleteSlot.mockReset()
  deleteSlot.mockImplementation((key: string) => () => ({ unwrap: async () => key }))
  closeOneSpy = vi.fn()
  chatConfig.confirmCloseSession = false
})

describe('planCloseTree', () => {
  it('groups descendants by depth below the pressed card', () => {
    const plan = planCloseTree(RUNNING_TREE, 'lead', isRunning)
    expect(plan.levels.map(l => [l.depth, l.sessions.map(s => s.key)])).toEqual([
      [0, ['lead']],
      [1, ['w1', 'w2']],
      [2, ['sub1', 'sub2']],
    ])
    expect(plan.total).toBe(5)
    expect(plan.descendantCount).toBe(4)
  })

  it('blocks when any descendant is running; counts the whole plan in runningTotal', () => {
    const plan = planCloseTree(RUNNING_TREE, 'lead', isRunning)
    // Gate: descendants only (the pressed session's own state never gates this).
    expect(plan.runningDescendants).toBe(2)
    // Count: whole plan (used in the notice sentence, must match "Close all N").
    expect(plan.runningTotal).toBe(3)
    expect(plan.total).toBe(5)
    expect(plan.blocked).toBe(true)
    // Deepest-first order is kept for the unblocked close path.
    expect(plan.order.indexOf('sub1')).toBeLessThan(plan.order.indexOf('w1'))
    expect(plan.order.at(-1)).toBe('lead')
  })

  it('is not blocked when every descendant has finished', () => {
    const plan = planCloseTree(IDLE_TREE, 'lead', isRunning)
    expect(plan.blocked).toBe(false)
    expect(plan.runningDescendants).toBe(0)
    expect(plan.order).toHaveLength(5)
  })

  it('plans nothing for an unknown key', () => {
    const plan = planCloseTree(RUNNING_TREE, 'gone', isRunning)
    expect(plan).toMatchObject({ total: 0, order: [], levels: [], blocked: false })
  })

  it('titles a session by its key when it has none', () => {
    const plan = planCloseTree([{ key: 'lead', parent: null }], 'lead', () => false)
    expect(plan.levels[0].sessions[0].title).toBe('lead')
  })
})

describe('useCloseSessionTree', () => {
  it('keeps ONE callback identity across a row-list change and still plans over new rows', async () => {
    const seen: Array<(key: string) => void> = []
    function Probe({ rows }: { rows: Row[] }) {
      const { closeSessionTree, closeTreeDialog } = useCloseSessionTree({
        rows, isRunning, closeOne: (key: string) => closeOneSpy(key),
      })
      seen.push(closeSessionTree)
      return (
        <>
          <button data-testid="x" onClick={() => closeSessionTree('lead')}>x</button>
          {closeTreeDialog}
        </>
      )
    }
    const user = userEvent.setup()
    const { rerender } = render(
      <Provider store={store}><Probe rows={[root('lead', 'solo')]} /></Provider>,
    )
    rerender(<Provider store={store}><Probe rows={IDLE_TREE} /></Provider>)
    expect(seen.length).toBeGreaterThan(1)
    expect(seen.at(-1)).toBe(seen[0])
    await user.click(screen.getByTestId('x'))
    await waitFor(() => expect(closedOrder()).toHaveLength(5))
    expect(closeOneSpy).not.toHaveBeenCalled()
  })

  it('delegates a card with no descendants to the existing single close', async () => {
    const user = userEvent.setup()
    render(<Harness rows={[root('lead', 'solo', true)]} />)
    await user.click(screen.getByTestId('x'))
    expect(closeOneSpy).toHaveBeenCalledWith('lead')
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(deleteSlot).not.toHaveBeenCalled()
  })

  it('closes a finished subtree silently with preference off (default)', async () => {
    const user = userEvent.setup()
    render(<Harness rows={IDLE_TREE} />)
    await user.click(screen.getByTestId('x'))
    await waitFor(() => expect(closedOrder()).toHaveLength(5))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(closedOrder()).toEqual(['sub1', 'sub2', 'w1', 'w2', 'lead'])
    expect(closeOneSpy).not.toHaveBeenCalled()
  })

  it('asks once with the in-app confirm when the preference is on', async () => {
    chatConfig.confirmCloseSession = true
    const user = userEvent.setup()
    render(<Harness rows={IDLE_TREE} />)
    await user.click(screen.getByTestId('x'))
    // The in-app confirm opens (not window.confirm).
    const dialog = await screen.findByRole('dialog')
    expect(dialog).toBeInTheDocument()
    // Nothing closed while the question is open.
    expect(deleteSlot).not.toHaveBeenCalled()
    // Confirm closes the whole tree.
    await user.click(screen.getByRole('button', { name: /Close all 5/i }))
    await waitFor(() => expect(closedOrder()).toHaveLength(5))
    expect(closedOrder()).toEqual(['sub1', 'sub2', 'w1', 'w2', 'lead'])
  })

  it('cancelling the preference confirm closes nothing', async () => {
    chatConfig.confirmCloseSession = true
    const user = userEvent.setup()
    render(<Harness rows={IDLE_TREE} />)
    await user.click(screen.getByTestId('x'))
    await user.click(await screen.findByRole('button', { name: /Cancel/i }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(deleteSlot).not.toHaveBeenCalled()
  })

  it('refuses while any descendant runs: notice lists levels, nothing closes', async () => {
    const user = userEvent.setup()
    render(<Harness rows={RUNNING_TREE} />)
    await user.click(screen.getByTestId('x'))
    // The notice opens.
    expect(await screen.findByRole('dialog')).toBeInTheDocument()
    // Nothing closed.
    expect(deleteSlot).not.toHaveBeenCalled()
    // Level headings name depth.
    const levels = screen.getByTestId('close-tree-levels')
    expect(levels.querySelectorAll('[data-testid^="close-tree-level-"]')).toHaveLength(3)
    expect(screen.getByTestId('close-tree-level-0')).toHaveTextContent('This session')
    expect(screen.getByTestId('close-tree-level-1')).toHaveTextContent('Nested 1 deep')
    expect(screen.getByTestId('close-tree-level-2')).toHaveTextContent('Nested 2 deep')
    // Every session named, running ones marked.
    for (const row of RUNNING_TREE) {
      const entry = screen.getByTestId(`close-tree-session-${row.key}`)
      expect(entry).toHaveTextContent(row.title!)
      expect(entry).toHaveTextContent(row.running ? 'Running' : 'Finished')
    }
    // The body sentence counts the whole plan.
    expect(screen.getByText(/3 of 5/)).toBeInTheDocument()
    // Exactly ONE action: dismiss. No "close anyway" button.
    const buttons = screen.getAllByRole('button')
    void buttons // suppress unused lint warning
    expect(screen.getByTestId('close-tree-dismiss')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Close all/i })).toBeNull()
  })

  it('dismissing the notice closes nothing', async () => {
    const user = userEvent.setup()
    render(<Harness rows={RUNNING_TREE} />)
    await user.click(screen.getByTestId('x'))
    await user.click(await screen.findByTestId('close-tree-dismiss'))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(deleteSlot).not.toHaveBeenCalled()
    expect(closeOneSpy).not.toHaveBeenCalled()
  })

  it('reports a refused close by name instead of swallowing it', async () => {
    deleteSlot.mockImplementation((key: string) => () => ({
      unwrap: async () => {
        if (key === 'w1') throw new Error('save failed')
        return key
      },
    }))
    const user = userEvent.setup()
    render(<Harness rows={IDLE_TREE} />)
    await user.click(screen.getByTestId('x'))
    const notice = await screen.findByTestId('close-tree-refused')
    expect(notice).toHaveTextContent('worker - babysit')
    expect(notice).not.toHaveTextContent('save failed')
    expect(notice).not.toHaveTextContent('worker - locale sweep')
    expect(closedOrder()).toEqual(['sub1', 'sub2', 'w1', 'w2', 'lead'])
  })

  it('reports nothing when every close succeeds', async () => {
    const user = userEvent.setup()
    render(<Harness rows={IDLE_TREE} />)
    await user.click(screen.getByTestId('x'))
    await waitFor(() => expect(closedOrder()).toHaveLength(5))
    expect(screen.queryByTestId('close-tree-refused')).toBeNull()
  })
})
