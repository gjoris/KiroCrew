import { useCallback, useRef, useState, type ReactNode } from 'react'

import ErrorNotice from '../components/ErrorNotice'
import Modal from '../components/Modal'
import { Btn } from '../components/ui'
import { useConfirm } from '../components/ConfirmDialog'
import { useAppDispatch } from '../store'
import { deleteSlot } from '../store/chatSlice'
import { loadChatConfig } from '../pages/chat/ChatSettings'
import { fmtNumber } from '../i18n/format'
import { i18nT } from '../i18n/t'
import { planCloseTree, type CloseTreePlan, type CloseTreeRow } from '../lib/sessionCloseTree'

/**
 * The session tree's ✕, as a close over the whole subtree that REFUSES while any
 * of it is still working (#17253).
 *
 * The card's ✕ takes down the session AND the sessions nested under it, so one press
 * on a lead could end several workers' turns at once, with nothing to undo. So the
 * press has two outcomes and no third:
 *
 *   - nothing under the card is running -> the whole subtree closes, no prompt;
 *   - anything under it is running      -> nothing closes, and a notice lists the
 *                                          sub-levels and marks which are running.
 *
 * There is deliberately no "close anyway" on that notice. A turn cancelled by a
 * tidy-up click cannot be restored, and a button that does it anyway is the same
 * one-click loss with a dialog in front of it. The person stops or finishes those
 * sessions first, then presses ✕ again.
 *
 * The notice is the in-app `Modal`, never `window.confirm` / `alert` (CREW-20787 /
 * #15976): the native sheet is synchronous, unthemeable, and cannot list the
 * sessions that are still running, which is the whole point of showing it.
 */

/** The levels, with each session marked running or finished. */
function CloseTreeLevels({ plan }: { plan: CloseTreePlan }) {
  return (
    <div
      className="max-h-[40vh] overflow-y-auto rounded-lg border border-border bg-bg-elevated"
      data-testid="close-tree-levels"
    >
      {plan.levels.map(level => (
        <div
          key={level.depth}
          className="px-2.5 py-1.5 border-b border-border last:border-b-0"
          data-testid={`close-tree-level-${level.depth}`}
        >
          <div className="font-mono text-[10px] font-semibold uppercase tracking-wider text-muted">
            {level.depth === 0
              ? i18nT('hooks.useCloseSessionTree.level_self')
              : i18nT('hooks.useCloseSessionTree.level', { depth: fmtNumber(level.depth) })}
          </div>
          {level.sessions.map(session => (
            <div
              key={session.key}
              className="flex items-center gap-2 pt-0.5"
              data-testid={`close-tree-session-${session.key}`}
            >
              {/* The ACCENT, the same hue the lane behind this notice paints a
                  running row's status line with, so the two never read as two
                  different states for one session. */}
              <span
                className={`w-1.5 h-1.5 rounded-full shrink-0 ${session.running ? 'bg-accent' : 'bg-muted-strong'}`}
                aria-hidden="true"
              />
              <span className="text-[12.5px] text-text truncate min-w-0">{session.title}</span>
              <span
                className={`ml-auto shrink-0 font-mono text-[10px] font-semibold uppercase tracking-wider ${
                  session.running ? 'text-accent' : 'text-muted-strong'
                }`}
              >
                {i18nT(session.running
                  ? 'hooks.useCloseSessionTree.running'
                  : 'hooks.useCloseSessionTree.finished')}
              </span>
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}

export interface CloseSessionTreeOptions<R extends CloseTreeRow> {
  /** The rows currently on screen, in the lane's own order, keyed by slot key. */
  rows: readonly R[]
  /** The caller's own "still working" predicate — see `planCloseTree`. */
  isRunning: (row: R) => boolean
  /**
   * Today's single-session close, used verbatim for a card with no descendants.
   *
   * Delegated rather than reimplemented so a leaf card keeps the exact behaviour it
   * has now, including the `confirmCloseSession` preference's own prompt. Nothing
   * about a session with nothing under it changed in #17253.
   */
  closeOne: (key: string) => void
}

export interface CloseSessionTree {
  /** Close *key* and its subtree — or refuse, with a notice, while any of it runs. */
  closeSessionTree: (key: string) => void
  /** The still-running notice. Render once in the owning component's JSX. */
  closeTreeDialog: ReactNode
  /**
   * The sessions a subtree close could NOT close, or nothing.
   *
   * The endpoint refuses a close while a guarded history write is still running,
   * and asks for it to be retried in a moment. The only other trace of that is the
   * row staying in the list, which reads as the press having missed. Render it
   * where the surface puts its own failures.
   */
  closeTreeError: ReactNode
}

export function useCloseSessionTree<R extends CloseTreeRow>(
  { rows, isRunning, closeOne }: CloseSessionTreeOptions<R>,
): CloseSessionTree {
  const dispatch = useAppDispatch()
  const { confirm, confirmDialog: prefConfirmDialog } = useConfirm()
  /** The plan a press refused, while its notice is open. */
  const [blocked, setBlocked] = useState<CloseTreePlan | null>(null)
  /** Kept through the notice's exit animation: `Modal` stays mounted with
   *  `open=false` so it can play out, and still needs its contents to do so. */
  const lastBlocked = useRef<CloseTreePlan | null>(null)
  /** Titles of the sessions the last subtree close could not close. */
  const [refusal, setRefusal] = useState<string[] | null>(null)

  // The inputs are read through a ref so `closeSessionTree` has a STABLE identity.
  // `rows` is the live slot list, so it is a new array on every slot push: as a
  // dependency it would make this callback new on every push, and the sidebar
  // passes it into each row's memoized menu props. That bust the row memo
  // boundary wholesale — one insertion re-rendered 21 rows instead of 1 and
  // rebuilt every row's menus (`ChatSidebar.rowMemo.test.tsx`). A press reads the
  // ref at call time, so it still plans over the rows on screen at that moment.
  const inputs = useRef({ rows, isRunning, closeOne })
  inputs.current = { rows, isRunning, closeOne }

  const closeSessionTree = useCallback((key: string) => {
    const { rows: liveRows, isRunning: live, closeOne: closeThisOne } = inputs.current
    const plan = planCloseTree(liveRows, key, live)
    // A press on a row that has since left the list closes nothing.
    if (plan.total === 0) return
    if (plan.descendantCount === 0) {
      closeThisOne(key)
      return
    }
    // Anything under the card still working: refuse, and say which. Nothing is
    // dispatched on this path at all, so there is no partial state to undo.
    if (plan.blocked) {
      lastBlocked.current = plan
      setBlocked(plan)
      return
    }
    const run = async () => {
      // Before closing, honour the user's "confirm before closing a session"
      // preference. The preference applies to the whole tree as one question:
      // one ask for all N sessions is what the person opted into, not one per
      // row. `useConfirm` is the in-app dialog, never `window.confirm` (the
      // native sheet is synchronous and cannot name what it is about to close).
      if (loadChatConfig().confirmCloseSession) {
        const confirmed = await confirm({
          title: i18nT('hooks.useCloseSessionTree.pref_title', { number: fmtNumber(plan.total) }),
          body: i18nT('hooks.useCloseSessionTree.pref_body', { total: fmtNumber(plan.total) }),
          confirmLabel: i18nT('hooks.useCloseSessionTree.pref_confirm', { number: fmtNumber(plan.total) }),
        })
        if (!confirmed) return
      }
      // Sequential, because `plan.order` is deepest-first and that ordering only
      // holds if each close completes before the next begins: no parent is
      // archived while a child still cites it as a live creator.
      //
      // A refused close leaves that one session open and does not abort the rest,
      // and it is REPORTED: its only other trace is the row staying put, and the
      // store's rejected-close path releases the hold without telling anyone.
      const titleOf = new Map(
        plan.levels.flatMap(level => level.sessions.map(s => [s.key, s.title] as const)),
      )
      // Names only. `deleteSlot` rejects with a fixed `save failed` whatever the
      // server said, so forwarding the thunk's message would print a cause that
      // is not the cause.
      const refused: string[] = []
      for (const slot of plan.order) {
        try {
          await dispatch(deleteSlot(slot)).unwrap()
        } catch {
          refused.push(titleOf.get(slot) ?? slot)
        }
      }
      setRefusal(refused.length > 0 ? refused : null)
    }
    void run()
    // `dispatch`, `confirm`, and both setters are stable, so this callback is created once.
  }, [dispatch, confirm])

  const shown = blocked ?? lastBlocked.current
  const closeTreeDialog = (
    <>
      {shown ? (
        <Modal
          open={!!blocked}
          onClose={() => setBlocked(null)}
          title={i18nT('hooks.useCloseSessionTree.title')}
          maxWidth={440}
          // One action, and it closes nothing: there is no "close anyway" here.
          footer={
            <Btn primary onClick={() => setBlocked(null)} data-testid="close-tree-dismiss">
              {i18nT('hooks.useCloseSessionTree.dismiss')}
            </Btn>
          }
        >
          <p className="text-sm text-text m-0 mb-3">
            {i18nT('hooks.useCloseSessionTree.body', {
              running: fmtNumber(shown.runningTotal),
              number: fmtNumber(shown.total),
            })}
          </p>
          <CloseTreeLevels plan={shown} />
        </Modal>
      ) : null}
      {/* Preference confirm — only mounted when the pref is on and the tree is
          not blocked. `useConfirm` keeps it null until a press triggers it. */}
      {prefConfirmDialog}
    </>
  )

  const closeTreeError = (
    <ErrorNotice
      title={i18nT('hooks.useCloseSessionTree.refused_title')}
      // Named, not counted: which sessions are still open is the thing the person
      // has to go back to, and a bare number would send them to compare lists.
      message={refusal ? i18nT('hooks.useCloseSessionTree.refused', { names: refusal.join(', ') }) : null}
      messagePlacement="below"
      // A hand-off loses nothing here: this surface holds no draft, and the
      // sessions that did close are already gone.
      askAgent
      // Dismissable: a refusal is a moment, and pressing the row's own close
      // again is the retry the server asked for.
      onDismiss={() => setRefusal(null)}
      className="mx-2 mt-2 shrink-0"
      testId="close-tree-refused"
    />
  )

  return { closeSessionTree, closeTreeDialog, closeTreeError }
}
