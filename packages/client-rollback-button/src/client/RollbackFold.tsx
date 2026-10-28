/** Collapsible revoke strip above the composer, shown only by a rollback child Session. */

import { useEffect, useState } from 'react'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ConversationUndoController } from './controller.ts'
import css from './RollbackFold.module.css'

/** Injected callbacks and observable source for the composer fold strip. */
export interface RollbackFoldInjected {
  hooks: { undo: ConversationUndoController }
  refresh: () => void
  /** Revoke the rollback that published this Session and open the restored Session. */
  revoke: () => Promise<void>
}

/** Full fold props, derived from the declared input-dock slot. */
export type RollbackFoldProps = PropsRuntime<'conversation.input.dock'> & InjectFace<RollbackFoldInjected>

/** Truncate one prompt to a one-line preview without splitting surrogate pairs. */
export function previewLine(prompt: string, max: number): string {
  if (prompt.length <= max) return prompt
  return `${prompt.slice(0, max)}…`
}

/** Render the revoke strip while this Session retains the completed rollback pair that published it. */
export function RollbackFold({
  useSession, useUndo, refresh, revoke,
}: RollbackFoldProps) {
  const session = useSession(value => value)
  const view = useUndo(value => value)
  const [pending, setPending] = useState(false)
  const [expanded, setExpanded] = useState(false)
  useEffect(() => {
    if (!session.running) refresh()
  }, [refresh, session.running])
  const pair = view.revokePair
  // A newly admitted prompt finalizes the pair Host-side; hide for the whole
  // turn immediately instead of waiting for the refresh to land.
  if (pair === undefined || session.running) return null
  const collapsible = pair.prompt.length > 48
  const shown = expanded ? pair.prompt : previewLine(pair.prompt, 48)
  return (
    <div className={css.fold} role="group" aria-label="Revocable rollback">
      <button
        type="button"
        className={css.summary}
        aria-expanded={expanded}
        onClick={() => { if (collapsible) setExpanded(value => !value) }}
      >
        <span className={css.label}>↩ Rolled back</span>
        <span className={css.preview}>{shown}</span>
        {collapsible && <span className={css.toggle}>{expanded ? 'Collapse' : 'Expand'}</span>}
      </button>
      <button
        type="button"
        className={css.undo}
        disabled={pending}
        title="Restore the files and conversation from before the rollback. If workspace files changed after it, it cannot be revoked."
        onClick={() => {
          setPending(true)
          void revoke().finally(() => { setPending(false) })
        }}
      >
        {pending ? 'Revoking' : 'Revoke rollback'}
      </button>
    </div>
  )
}
