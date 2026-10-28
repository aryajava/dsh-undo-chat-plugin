import type { SessionId } from '@deepseek-ai/dsh-session/types'
import css from './UndoTimeline.module.css'

/** Registered id of dsh's built-in trajectory Conversation View. */
export const TRAJECTORY_VIEW_ID = 'trajectory'

/** Stock English label of that view, used only when no binding is available. */
const TRAJECTORY_TAB_LABEL = 'Trajectory'

let highlightedTrajectoryRows: HTMLElement[] = []

function normalizedText(value: string): string { return value.replace(/\s+/gu, ' ').trim() }

function isTrajectoryUserRow(row: HTMLElement): boolean {
  const leadingCell = row.querySelector<HTMLElement>('td, [role="cell"]')
  const label = normalizedText(leadingCell?.textContent ?? '')
  return label === 'USER' || label.endsWith('USER')
}

function focusTrajectoryPrompt(prompt: string, attempt = 0): void {
  const expected = normalizedText(prompt)
  const rows = [...document.querySelectorAll<HTMLElement>('tr, [role="row"]')]
  const selectedIndex = rows.findIndex(candidate => normalizedText(candidate.textContent ?? '').includes(expected))
  if (selectedIndex === -1) {
    if (attempt < 8) window.setTimeout(() => { focusTrajectoryPrompt(prompt, attempt + 1) }, 70)
    return
  }
  const nextTurnIndex = rows.findIndex((candidate, index) => index > selectedIndex && isTrajectoryUserRow(candidate))
  const turnRows = rows.slice(selectedIndex, nextTurnIndex === -1 ? undefined : nextTurnIndex)
  const selectionClass = css.trajectorySelected
  if (selectionClass === undefined) return
  for (const row of highlightedTrajectoryRows) row.classList.remove(selectionClass)
  for (const row of turnRows) row.classList.add(selectionClass)
  highlightedTrajectoryRows = turnRows
  turnRows[0]?.scrollIntoView({ block: 'center', behavior: 'smooth' })
}

/**
 * Activate dsh's own trajectory view for the current conversation.
 *
 * The view store deliberately remains owned by ui-conversation.  Its public
 * surface exposes `ConversationBinding.activate(target)`, so the trajectory
 * view is selected by its registered view id instead of its localized tab
 * label.  Callers without a binding fall back to clicking the tab whose label
 * is the stock English one.  Reuse that action instead of keeping a competing
 * inspection viewer in this plugin.
 *
 * @param prompt - prompt text to reveal once the view is visible.
 * @param activate - optional view activation through the ui-conversation service.
 * @returns whether the trajectory view could be activated.
 */
export function openNativeTrajectory(prompt?: string, activate?: () => void): boolean {
  let activated = false
  if (activate !== undefined) {
    try {
      activate()
      activated = true
    } catch {
      activated = false
    }
  }
  if (!activated) {
    const tab = [...document.querySelectorAll<HTMLButtonElement>('[data-conversation-tabs] button[role="tab"]')]
      .find(candidate => candidate.textContent?.trim() === TRAJECTORY_TAB_LABEL)
    if (tab === undefined || tab.disabled) return false
    tab.click()
  }
  if (prompt !== undefined && prompt !== '') window.setTimeout(() => { focusTrajectoryPrompt(prompt) }, 0)
  return true
}

/** Minimal navigation surface needed to keep a freshly created rollback child selected. */
export interface RollbackSessionNavigation {
  openSession(sessionId: SessionId): void
}

/**
 * Open a rollback child and keep asserting it while delayed archive projections
 * settle. Multi-step timeline rollback can publish several archive updates after
 * the Remote response, and the archive of the source Session used to clear the
 * current selection afterwards.
 *
 * dsh 0.2.1 keeps that selection private to `UiWorkspaceService` (the session
 * list snapshot no longer carries `current`), so this cannot compare against the
 * live selection any more. It re-asserts on a short bounded schedule instead of
 * following list emissions for the whole hold window, which keeps the reopen
 * cheap and stops before a slow archive would yank a user who navigated away.
 */
export function keepRollbackChildOpen(
  navigation: RollbackSessionNavigation,
  sessionId: SessionId,
  holdMilliseconds = 5_000,
): () => void {
  const delays = [0, 150, 500, 1_200].filter(delay => delay <= holdMilliseconds)
  const timers: ReturnType<typeof setTimeout>[] = []
  for (const delay of delays) {
    timers.push(setTimeout(() => { navigation.openSession(sessionId) }, delay))
  }
  return () => {
    for (const timer of timers) clearTimeout(timer)
  }
}
