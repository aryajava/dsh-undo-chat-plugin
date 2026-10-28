/** Session-header action that starts a reversible rollback of the latest completed message. */

import { useEffect, useRef, useState } from 'react'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ConversationAdmissionFailureValue } from '@dsh-undo/rollback-undo/types'
import type { ConversationUndoController } from './controller.ts'
import css from './RollbackHeaderAction.module.css'

/** Injected callbacks and observable source for the header action. */
export interface RollbackActionInjected {
  hooks: { undo: ConversationUndoController }
  refresh: () => void
  /** Read and clear one refused-admission failure for this Session. */
  checkAdmissionFailure: () => Promise<ConversationAdmissionFailureValue | undefined>
  /** Roll back the latest approved message and open the replacement Session. */
  undo: () => Promise<void>
}

/** Full action props, derived from the declared header-actions slot. */
export type RollbackActionProps = PropsRuntime<'conversation.session.header.actions'> & InjectFace<RollbackActionInjected>

/** Compose the non-durable draft restored after snapshot admission fails.
 * @param prompt - Original rejected text.
 * @param detail - Redacted Host failure detail.
 * @returns Composer draft recovery text.
 */
export function formatAdmissionFailureDraft(prompt: string, detail: string): string {
  return `${prompt}\n---------\nFailure reason:\n${detail}`
}

/** Render while the Host holds a rollback point for this Session's latest eligible message. */
export function RollbackHeaderAction({
  useSession, inputActions, useUndo, refresh, checkAdmissionFailure, undo,
}: RollbackActionProps) {
  const session = useSession(value => value)
  const view = useUndo(value => value)
  const [pending, setPending] = useState(false)
  const previousRunning = useRef(session.running)
  useEffect(() => {
    if (previousRunning.current && !session.running) {
      void checkAdmissionFailure().then(failure => {
        if (failure !== undefined) {
          inputActions?.setDraft(formatAdmissionFailureDraft(failure.prompt, failure.detail))
        }
      })
    }
    previousRunning.current = session.running
  }, [checkAdmissionFailure, inputActions, session.running])
  useEffect(() => {
    refresh()
    // Session.running can flip before the Host has persisted the new armed
    // journal. An existing Session still exposes its previous messageId in
    // that window, so polling only while messageId is absent leaves the new
    // prompt unmatched. Keep synchronising throughout generation.
    if (!session.running) return
    const timer = window.setInterval(refresh, 250)
    return () => { window.clearInterval(timer) }
  }, [refresh, session.running])
  const messageId = view.value?.messageId
  if (messageId === undefined) return null
  return (
    <button
      type="button"
      className={css.action}
      disabled={pending}
      title="Restore the files and conversation from just before this message; if it is still generating, generation stops first. Local changes made after it are lost."
      aria-label="Roll back to before this message"
      onClick={() => {
        setPending(true)
        void undo().finally(() => { setPending(false) })
      }}
    >
      {pending ? 'Rolling back' : 'Roll back'}
    </button>
  )
}

/** Re-export the session identity type for the apply closure. */
export type { SessionId }
