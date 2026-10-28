/**
 * Message-actions rollback button for the dsh web conversation (main-tree
 * parity): one icon button in the qualified user message's actions row, right
 * after Copy, carrying the composer's enter-key glyph verbatim.
 *
 * rc.7 has no user-message actions slot (only the turn-tail assistant-actions
 * strip), so this is the navIconPatch pattern applied to the chat flow:
 *
 *   - rc.7's chat flow publishes one stable contract per node —
 *     `[data-chat-flow-kind]` plus a `data-chat-flow-key` whose
 *     `input-message<uuid>` tail IS the durable message id (verified against
 *     the rollback journal's messageId). The armed rollback point therefore
 *     matches exactly one user row: `key.endsWith(messageId)`.
 *   - The button is a FOREIGN node React never reconciles; a MutationObserver
 *     re-inserts after any remount the diff discards (virtualization, session
 *     switch), and subscriptions (sessions list + controller views) drive the
 *     same idempotent rescan.
 *   - The icon is the composer send key's own inline SVG path (ui-conversation
 *     carries a private copy whose coordinates differ from the primitives
 *     export in the third decimal), inlined verbatim so the glyph the user
 *     sees is byte-identical to the enter key.
 */

import type { MessageId } from '@deepseek-ai/dsh-client-connection/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ConversationUndoView } from './controller.ts'
import css from './messageActions.module.css'

/** Marker attribute on the foreign button (kebab-case literal: the selector
 * must match the attribute exactly; a dataset write would mangle camelCase). */
const MARK = 'data-dsh-rollback-message-action'

/** The composer send key's inline glyph (dsh-client-ui-conversation InputBar),
 * copied verbatim so the message-action button matches the enter key exactly. */
const ENTER_KEY_ICON_PATH = 'M8.3125 0.980183C8.66767 1.0531 8.97902 1.20418 9.2627 1.43233C9.48724 1.61297 9.73029 1.85793 9.97949 2.10714L14.707 6.83468L13.293 8.24874L9 3.95577V15.0417H7V3.95577L2.70703 8.24874L1.29297 6.83468L6.02051 2.10714C6.26971 1.85793 6.51277 1.61297 6.7373 1.43233C6.97662 1.23986 7.28445 1.04402 7.6875 0.980183C7.8973 0.947006 8.1031 0.95516 8.3125 0.980183Z'

/** One armed rollback point published by a Session-scoped controller. */
export interface ArmedPoint {
  readonly sessionId: SessionId
  readonly messageId: MessageId
}

/** Minimal controller face this patch consumes. */
export interface UndoControllerPort {
  getSnapshot(): ConversationUndoView
  subscribe(fn: () => void): () => void
}

/** Wiring the patch needs from the owning apply. */
export interface MessageActionsPatchDeps {
  /**
   * Every armed rollback point this client currently knows about.
   *
   * dsh 0.2.1 stopped publishing the current Session selection (`SessionListState`
   * has no `current`), so the patch no longer asks "which Session is open?". It
   * asks "which Sessions hold an armed point?" instead: a flow key is
   * `input-message<messageId>` with a globally unique message id, so the armed
   * point of a Session that is not on screen simply matches no row.
   */
  readonly points: () => readonly ArmedPoint[]
  /** Rescan signal: session-list changes and every controller publication. */
  readonly subscribe: (fn: () => void) => () => void
  /** Roll back one message: undo and open the replacement session. */
  readonly undo: (sessionId: SessionId, messageId: MessageId) => Promise<void>
}

/** The enter-key glyph as a fresh svg element (cloned per button). */
function buildEnterKeyIcon(): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', '0 0 16 16')
  svg.setAttribute('width', '16')
  svg.setAttribute('height', '16')
  svg.setAttribute('aria-hidden', 'true')
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
  path.setAttribute('d', ENTER_KEY_ICON_PATH)
  path.setAttribute('fill', 'currentColor')
  svg.append(path)
  return svg
}

/** The user row's actions container: the child of the hover root that holds buttons. */
function findActionsRow(flowItem: HTMLElement): HTMLElement | null {
  const hoverRoot = flowItem.querySelector('[data-time-hover-root]')
  if (!(hoverRoot instanceof HTMLElement)) return null
  for (const child of hoverRoot.children) {
    if (child.querySelector('button') !== null && child instanceof HTMLElement) return child
  }
  return null
}

/**
 * Mount the message-actions rollback button for the lifetime of the plugin.
 * @param deps - armed points, rescan subscription, and the undo verb.
 * @returns Disposer removing the observer, subscriptions, and every button.
 */
export function mountMessageActionsPatch(deps: MessageActionsPatchDeps): () => void {
  const icon = buildEnterKeyIcon()
  let pending = false
  const owned = new Set<HTMLElement>()

  const removeButton = (button: HTMLElement): void => {
    button.remove()
    owned.delete(button)
  }

  const armedFor = (flowKey: string): ArmedPoint | undefined =>
    deps.points().find(point => flowKey.endsWith(point.messageId))

  const scan = (): void => {
    const disabled = pending
    for (const flowItem of [...document.querySelectorAll<HTMLElement>('[data-chat-flow-kind="user"]')]) {
      const key = flowItem.getAttribute('data-chat-flow-key') ?? ''
      const point = armedFor(key)
      const existing = flowItem.querySelector<HTMLButtonElement>(`[${MARK}]`)
      if (point === undefined) {
        if (existing !== null) removeButton(existing)
        continue
      }
      const row = findActionsRow(flowItem)
      if (row === null) continue
      let button: HTMLButtonElement | null = existing
      if (button === null) {
        button = document.createElement('button')
        button.type = 'button'
        button.className = css.action ?? ''
        button.setAttribute(MARK, 'true')
        button.setAttribute('aria-label', 'Roll back to before this message')
        button.setAttribute('title', 'Restore the files and conversation from just before this message; if it is still generating, generation stops first. Local changes made after it are lost.')
        button.appendChild(icon.cloneNode(true))
        button.addEventListener('click', () => {
          if (pending) return
          const live = armedFor(key)
          if (live === undefined) return
          pending = true
          scan()
          void deps.undo(live.sessionId, live.messageId).finally(() => {
            pending = false
            scan()
          })
        })
        owned.add(button)
        row.appendChild(button)
      } else if (button.parentElement !== row) {
        row.appendChild(button)
      }
      button.disabled = disabled
    }
    // Buttons whose flow item left the DOM entirely (session switch).
    for (const button of [...owned]) {
      if (!button.isConnected) removeButton(button)
    }
  }

  scan()
  const observer = new MutationObserver(scan)
  observer.observe(document.body, { childList: true, subtree: true })
  const disposeSubscribe = deps.subscribe(scan)

  return () => {
    observer.disconnect()
    disposeSubscribe()
    for (const button of [...owned]) removeButton(button)
  }
}
