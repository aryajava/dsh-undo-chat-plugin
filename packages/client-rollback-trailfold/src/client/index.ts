/**
 * Browser half of the trailfold plugin: mount the per-turn fold into the live
 * document. No services are required — the fold reads the chat flow's stable
 * data attributes and never touches React-owned state.
 */

import { mountTrailFold } from './trailfold.ts'
import css from './trailfold.module.css'

/** No services required: the fold is a self-contained DOM patch. */
export const inject: readonly string[] = []

export { mountTrailFold, planTurns, foldable } from './trailfold.ts'
export type { FlowItem, TurnPlan } from './trailfold.ts'

/**
 * Mount the conversation trail fold.
 * @returns Disposer removing the observer and every foreign bar.
 */
export async function apply(): Promise<() => void> {
  if (typeof document === 'undefined') return () => {}
  return mountTrailFold(document, css, {
    title: 'Reasoning and actions',
    running: 'Running…',
    counts: (think, tools) => {
      const parts: string[] = []
      if (think > 0) parts.push(`${think} thinking`)
      if (tools > 0) parts.push(`${tools} tools`)
      return parts.join(' · ')
    },
  })
}
