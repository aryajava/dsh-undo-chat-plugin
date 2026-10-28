/** `/undo` timeline picker: one visual entry to the same continuous rollback chain. */

import { useEffect, useState, useSyncExternalStore } from 'react'
import type { MessageId } from '@deepseek-ai/dsh-client-connection/client'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ConversationUndoLayerValue } from '@dsh-undo/rollback-undo/types'
import css from './UndoTimeline.module.css'

export interface UndoTimelineInjected {
  layers: () => Promise<readonly ConversationUndoLayerValue[]>
  openTrajectory: (prompt?: string) => boolean
  open: (messageId: MessageId) => Promise<void>
}

export type UndoTimelineProps = PropsRuntime<'conversation.input.dock'> & InjectFace<UndoTimelineInjected>

const requestedSessions = new Set<string>()
const requestListeners = new Set<() => void>()

function publishRequestChange(): void { for (const listener of requestListeners) listener() }

/** Open the custom picker after the public slash-command pipeline claims `/undo`. */
export function requestUndoTimeline(sessionId: string): void {
  requestedSessions.add(sessionId)
  publishRequestChange()
}

function clearUndoTimelineRequest(sessionId: string): void {
  if (!requestedSessions.delete(sessionId)) return
  publishRequestChange()
}

function useUndoTimelineRequest(sessionId: string): boolean {
  return useSyncExternalStore(
    listener => { requestListeners.add(listener); return () => { requestListeners.delete(listener) } },
    () => requestedSessions.has(sessionId),
    () => false,
  )
}

export function timelinePreview(prompt: string): string {
  const firstLine = prompt.split(/\r?\n/u, 1)[0] ?? ''
  return firstLine.length <= 42 ? firstLine : `${firstLine.slice(0, 42)}…`
}

function timelineDensity(count: number): string {
  if (count > 12) return css.timelineDense ?? ''
  if (count > 6) return css.timelineCompact ?? ''
  return ''
}

function rollbackErrorMessage(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : ''
  if (message.includes('spawn git ENOENT')) return 'Rollback unavailable: the original workspace of this session is gone or unreachable.'
  return message || 'Rollback did not finish; try again.'
}

/** The custom picker is mounted in the input dock so it can claim bare `/undo` before host submission. */
export function UndoTimeline({ sessionId, inputActions, layers: readLayers, openTrajectory, open }: UndoTimelineProps) {
  const [visible, setVisible] = useState(false)
  const [layers, setLayers] = useState<readonly ConversationUndoLayerValue[]>([])
  const [selected, setSelected] = useState<MessageId | undefined>()
  const [loading, setLoading] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | undefined>()
  const [hoveredAction, setHoveredAction] = useState<'rollback' | 'inspect' | undefined>()
  const timelineRequested = useUndoTimelineRequest(String(sessionId))

  const dismissSelection = (): void => {
    if (pending || selected === undefined) return
    setSelected(undefined); setHoveredAction(undefined)
  }

  useEffect(() => {
    if (!timelineRequested) return
    inputActions.setDraft('')
    setLoading(true); setVisible(true)
    clearUndoTimelineRequest(String(sessionId))
  }, [inputActions, sessionId, timelineRequested])

  useEffect(() => {
    if (!visible) return
    let active = true
    setLoading(true); setError(undefined)
    void readLayers().then(value => {
      if (!active) return
      setLayers(value); setSelected(undefined); setHoveredAction(undefined)
    }).catch((cause: unknown) => {
      if (active) setError(cause instanceof Error ? cause.message : 'Could not read the rollback layers.')
    }).finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [readLayers, visible])

  useEffect(() => {
    if (!visible) return
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || pending) return
      if (selected !== undefined) dismissSelection()
      else setVisible(false)
    }
    document.addEventListener('keydown', closeOnEscape)
    return () => { document.removeEventListener('keydown', closeOnEscape) }
  }, [pending, selected, visible])

  if (!visible) return null
  const closeTimeline = (): void => { if (!pending) setVisible(false) }
  const dismissSelectionOrClose = (): void => { if (selected !== undefined) dismissSelection(); else closeTimeline() }
  const showPetals = (messageId: MessageId): void => { setSelected(messageId) }
  const hidePetals = (messageId: MessageId): void => { if (selected === messageId) dismissSelection() }
  const inspectSelected = (): void => {
    if (pending) return
    const selectedLayer = layers.find(layer => layer.messageId === selected)
    if (selectedLayer === undefined || !openTrajectory(selectedLayer.prompt)) {
      setError('Could not open the dsh Trajectory view.')
      return
    }
    setHoveredAction(undefined)
    setVisible(false)
  }
  const rollbackSelected = (): void => {
    if (selected === undefined || pending) return
    setPending(true); setError(undefined)
    void open(selected).then(() => { setVisible(false) }).catch(cause => {
      setError(rollbackErrorMessage(cause))
    }).finally(() => { setPending(false) })
  }
  return (
    <div className={css.mask} role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) dismissSelectionOrClose() }}>
      <section className={css.dialog} role="dialog" aria-modal="true" aria-labelledby="dsh-undo-timeline-title" onMouseDown={event => { event.stopPropagation() }}>
        <h2 className={css.srOnly} id="dsh-undo-timeline-title">Rollback timeline</h2>
        {loading && <><p className={css.srOnly} aria-live="polite">Reading the messages that can be rolled back.</p><div className={`${css.timeline} ${css.loadingTimeline}`} aria-hidden="true"><div className={`${css.axis} ${css.loadingAxis}`}><span className={`${css.node} ${css.loadingNode}`}><span className={`${css.dot} ${css.loadingDot}`} /></span></div></div></>}
        {error !== undefined && <p className={css.errorNotice} role="alert">{error}</p>}
        {!loading && layers.length === 0 && <p className={css.srOnly}>This session has no completed message that can be rolled back.</p>}
        {!loading && layers.length > 0 && <div className={`${css.timeline} ${timelineDensity(layers.length)}${layers.length > 12 ? ` ${css.timelineScrollable}` : ''}`} aria-label="Rollback layers, newest message at the bottom" tabIndex={layers.length > 12 ? 0 : undefined} onMouseDown={event => { if (event.target === event.currentTarget) dismissSelection() }}>
          <div className={css.axis}>
            {layers.map((layer, index) => {
              const chosen = selected === layer.messageId
              const preview = timelinePreview(layer.prompt)
              return <div className={`${css.node}${chosen ? ` ${css.selected}` : ''}`} key={layer.messageId} onPointerEnter={() => { showPetals(layer.messageId) }} onPointerLeave={() => { hidePetals(layer.messageId) }} onFocusCapture={() => { showPetals(layer.messageId) }} onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget)) hidePetals(layer.messageId) }}>
                <button type="button" aria-label={`Select: ${preview} (layer ${index + 1})`} aria-pressed={chosen} className={css.point} disabled={pending} onClick={() => { showPetals(layer.messageId) }} title={layer.prompt}>
                  <span className={css.dot} aria-hidden="true" /><span className={css.srOnly}>{`prompt ${index + 1}: ${preview}`}</span>
                </button>
                {chosen && <>
                  <svg className={css.fan} viewBox="0 0 120 120" role="group" aria-label={`Actions for “${preview}”`}>
                    <path aria-disabled={pending} aria-label={pending ? 'Rolling back' : 'Roll back'} className={`${css.sector}${hoveredAction === 'rollback' ? ` ${css.sectorHovered}` : ''}`} d="M 83.78 52.27 L 107.55 44.55 A 50 50 0 0 0 54.77 10.27 L 57.39 35.14 A 25 25 0 0 1 83.78 52.27 Z" onPointerEnter={() => { setHoveredAction('rollback') }} onPointerLeave={() => { setHoveredAction(current => current === 'rollback' ? undefined : current) }} onFocus={() => { setHoveredAction('rollback') }} onBlur={() => { setHoveredAction(current => current === 'rollback' ? undefined : current) }} onClick={rollbackSelected} onKeyDown={event => { if (!pending && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); rollbackSelected() } }} role="button" tabIndex={pending ? -1 : 0} />
                    <path className={css.fanIcon} d="m82 23 7 7-7 7m6-7H75a9 9 0 0 0-8 5" aria-hidden="true" />
                    <path aria-disabled={pending} aria-label="View the dsh trajectory" className={`${css.sector} ${css.inspectSector}${hoveredAction === 'inspect' ? ` ${css.sectorHovered}` : ''}`} d="M 83.78 67.73 L 107.55 75.45 A 50 50 0 0 1 54.77 109.73 L 57.39 84.86 A 25 25 0 0 0 83.78 67.73 Z" onPointerEnter={() => { setHoveredAction('inspect') }} onPointerLeave={() => { setHoveredAction(current => current === 'inspect' ? undefined : current) }} onFocus={() => { setHoveredAction('inspect') }} onBlur={() => { setHoveredAction(current => current === 'inspect' ? undefined : current) }} onClick={inspectSelected} onKeyDown={event => { if (!pending && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); inspectSelected() } }} role="button" tabIndex={pending ? -1 : 0} />
                    <path className={css.fanIcon} d="m82 91 6 6m-9-15a7 7 0 1 0 0 14 7 7 0 0 0 0-14Zm-3 7h7m-3.5-3.5v7" aria-hidden="true" />
                  </svg>
                  {hoveredAction !== undefined && <span className={`${css.fanLabel} ${hoveredAction === 'inspect' ? css.inspectLabel : ''}`}>{hoveredAction === 'rollback' ? 'Roll back' : 'View trajectory'}</span>}
                </>}
              </div>
            })}
          </div>
        </div>}
      </section>
    </div>
  )
}
