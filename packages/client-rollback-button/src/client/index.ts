/** Browser-half Cordis composition for the rollback header action. */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-api-workspace-controller/client'
import type {} from '@deepseek-ai/dsh-client-ui-commands/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import TYPERT_REMOTE from '@dsh-undo/rollback-undo/remote'
import type {} from '@dsh-undo/rollback-undo/remote'
import { ConversationUndoController } from './controller.ts'
import type { ConversationUndoRemote } from './controller.ts'
import { RollbackHeaderAction } from './RollbackHeaderAction.tsx'
import type { RollbackActionInjected } from './RollbackHeaderAction.tsx'
import { RollbackFold } from './RollbackFold.tsx'
import type { RollbackFoldInjected } from './RollbackFold.tsx'
import { UndoTimeline, requestUndoTimeline } from './UndoTimeline.tsx'
import type { UndoTimelineInjected } from './UndoTimeline.tsx'
import { mountMessageActionsPatch } from './messageActionsPatch.ts'
import type { ArmedPoint } from './messageActionsPatch.ts'
import { keepRollbackChildOpen, openNativeTrajectory, TRAJECTORY_VIEW_ID } from './navigation.ts'
import type { RollbackSessionNavigation } from './navigation.ts'

/** Required service and slot declarations. The Remote namespaces are mounted by this apply, so only the `remote` service is injected. */
export const inject = ['slots', 'remote', 'sessions']

/**
 * Service key of the generated conversationUndo Remote namespace. Typed as a
 * plain string because the Cordis `get` overload only accepts declared keys,
 * and this one is installed at runtime by the contribution this apply mounts.
 */
const UNDO_ENDPOINT: string = 'remote.conversationUndo'

/** Browser surface of the workspaces runtime list store. */
interface WorkspacesListPort {
  getSnapshot(): { archivedSessionIds: readonly SessionId[] }
  subscribe(fn: () => void): () => void
}

/** Browser surface of the workspaces runtime service. */
interface WorkspacesPort {
  list: WorkspacesListPort
}

/** Browser surface of the typert client Remote host. */
interface RemotePort {
  $mount(contribution: TypertRemoteContribution): Promise<() => Promise<void>>
}

/**
 * Mount one generated contribution at most once across sibling client plugins.
 * Both rollback browser packages mount the conversationUndo contribution; the
 * typert registry rejects a duplicate endpoint, so the later apply must
 * observe the earlier mount and skip.
 * @param ctx - client Cordis context.
 * @param contribution - generated Remote contribution.
 * @param probe - one endpoint the contribution declares, used to test the registry.
 * @returns the contribution disposer (a no-op when a sibling already mounted it).
 */
async function mountOnce(
  ctx: Context,
  contribution: TypertRemoteContribution,
  probe: string,
): Promise<() => Promise<void>> {
  if (ctx.get('typert')?.remotes.get(probe) !== undefined) return async () => {}
  return await (ctx.get('remote') as unknown as RemotePort).$mount(contribution)
}

/** Mount the plugin Remote and register the session-header rollback action. */
export async function apply(ctx: Context): Promise<() => void> {
  const disposeRemote = await mountOnce(ctx, TYPERT_REMOTE, 'conversationUndo/current')
  const sessions = ctx.sessions
  const workspaces = ctx.get('workspaces') as WorkspacesPort | undefined
  const navigation = ctx.get('uiWorkspace') as RollbackSessionNavigation | undefined
  const undoRemote = ctx.get(UNDO_ENDPOINT) as unknown as ConversationUndoRemote
  const commandUi = ctx.get('commandUi')
  const controllers = new Map<SessionId, ConversationUndoController>()
  /** Rescan fan-out for the message-actions patch; controllers join it as they appear. */
  const rescanListeners = new Set<() => void>()
  const notifyRescan = (): void => {
    for (const listener of [...rescanListeners]) listener()
  }
  const controllerFor = (sessionId: SessionId): ConversationUndoController => {
    let controller = controllers.get(sessionId)
    if (controller === undefined) {
      controller = new ConversationUndoController(undoRemote, sessionId)
      controllers.set(sessionId, controller)
      controller.subscribe(notifyRescan)
      void controller.ensure()
    }
    return controller
  }
  /**
   * Every armed rollback point this client knows about. dsh 0.2.1 keeps the
   * current Session selection private to `UiWorkspaceService`, so the DOM patch
   * matches by the globally unique message id instead of asking "which Session
   * is open?".
   */
  const armedPoints = (): ArmedPoint[] => {
    const points: ArmedPoint[] = []
    for (const [sessionId, controller] of controllers) {
      const messageId = controller.getSnapshot().value?.messageId
      if (messageId !== undefined) points.push({ sessionId, messageId })
    }
    return points
  }
  let autoFollowSuspendedUntil = 0
  const disposeFollow = followRollbackChild(workspaces, navigation, undoRemote, () => Date.now() >= autoFollowSuspendedUntil)
  const disposeRegistration = ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
    name: 'conversation.session.header.actions',
    id: 'rollback',
    order: 60,
    inject: (sessionId: SessionId): RollbackActionInjected => {
      const controller = controllerFor(sessionId)
      return {
        hooks: { undo: controller },
        refresh: () => { void controller.refresh() },
        checkAdmissionFailure: () => controller.admissionFailure(),
        undo: async () => {
          // The journal can advance while a response is streaming. Refresh at
          // click time so rollback targets the live prompt, not the previous
          // completed message cached by the header action.
          await controller.refresh()
          const messageId = controller.getSnapshot().value?.messageId
          if (messageId === undefined) return
          const result = await controller.undo(messageId)
          if (result !== undefined) openRollbackChild(navigation, result.sessionId)
        },
      }
    },
  }, RollbackHeaderAction))

  const disposeFold = ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name: 'conversation.input.dock',
    id: 'rollback-fold',
    order: 60,
    inject: (sessionId: SessionId): RollbackFoldInjected => {
      const controller = controllerFor(sessionId)
      return {
        hooks: { undo: controller },
        refresh: () => { void controller.refresh() },
        revoke: async () => {
          const result = await controller.revoke()
          if (result !== undefined) openRollbackChild(navigation, result.sessionId)
        },
      }
    },
  }, RollbackFold))

  // `/undo` is consumed through the public input dock before it reaches the
  // Host command handler. The timeline then invokes the same undo transaction
  // repeatedly and opens only its final child.
  const disposeTimeline = ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name: 'conversation.input.dock',
    id: 'undo-timeline',
    order: 61,
    inject: (sessionId: SessionId): UndoTimelineInjected => {
      const controller = controllerFor(sessionId)
      return {
        layers: () => controller.layers(),
        openTrajectory: (prompt?: string) => openNativeTrajectory(prompt, () => {
          ctx.uiConversation.binding(sessionId).activate(TRAJECTORY_VIEW_ID)
        }),
        open: async (messageId) => {
          autoFollowSuspendedUntil = Number.POSITIVE_INFINITY
          try {
            const result = await controller.undoThrough(messageId)
            if (result === undefined) throw new Error(controller.getSnapshot().error ?? 'Rollback did not finish; try again.')
            openRollbackChild(navigation, result.sessionId)
          } finally {
            // Archive projections race the Remote response; keep their
            // intermediate child opens suppressed through the next paint.
            autoFollowSuspendedUntil = Date.now() + 5000
          }
        },
      }
    },
  }, UndoTimeline))

  // A dock component observes the already-settled input snapshot, which is
  // too late to stop the Host's own bare `/undo` command.  The supported
  // decoration point claims that bare invocation first, then signals the
  // custom visual picker and clears the command token from its public input
  // action.  Arguments still belong to the Host command unchanged.
  const disposeUndoDecoration = commandUi?.decorate({
    name: 'undo',
    available: () => true,
    ui: {
      kind: 'popupSelect',
      options: async (session, _signal) => {
        requestUndoTimeline(String(session.sessionId))
        return []
      },
      onSelect: () => {},
    },
  }) ?? (() => {})

  ctx.on('connection/reset', () => {
    for (const controller of controllers.values()) void controller.refresh()
  })

  // Message-level rollback entry (main-tree parity): the enter-key glyph next
  // to Copy on the qualified user message's actions row.
  const disposeMessageActions = mountMessageActionsPatch({
    points: armedPoints,
    subscribe: (fn) => {
      rescanListeners.add(fn)
      const disposeList = sessions.list.subscribe(fn)
      return () => {
        rescanListeners.delete(fn)
        disposeList()
      }
    },
    undo: async (sessionId, messageId) => {
      const result = await controllerFor(sessionId).undo(messageId)
      if (result !== undefined) openRollbackChild(navigation, result.sessionId)
    },
  })

  return () => {
    disposeMessageActions()
    disposeRegistration()
    disposeFold()
    disposeTimeline()
    disposeUndoDecoration()
    disposeFollow()
    for (const controller of controllers.values()) controller.dispose()
    controllers.clear()
    rescanListeners.clear()
    void disposeRemote()
  }
}

/**
 * Open one rollback child when the browser publishes the Workspace navigation
 * service. Rollback itself stays useful without it (the child is published
 * Host-side), so a runtime without ui-workspace degrades to no navigation.
 * @param navigation - Workspace navigation service, when present.
 * @param sessionId - child Session the Host created.
 */
function openRollbackChild(navigation: RollbackSessionNavigation | undefined, sessionId: SessionId): void {
  if (navigation !== undefined) keepRollbackChildOpen(navigation, sessionId)
}

/**
 * Open the rollback child of every freshly archived Session that carries a
 * completed rollback journal. A text-command rollback archives its source
 * through the Host; following it into the published child keeps the workflow
 * continuous. Manual archives without a journal are untouched.
 * @param workspaces - workspaces runtime service, when present.
 * @param navigation - Workspace navigation service, when present.
 * @param undoRemote - mounted conversationUndo Remote.
 * @returns Disposer for the archive listener.
 */
function followRollbackChild(
  workspaces: WorkspacesPort | undefined,
  navigation: RollbackSessionNavigation | undefined,
  undoRemote: ConversationUndoRemote,
  shouldFollow: () => boolean = () => true,
): () => void {
  if (workspaces === undefined || navigation === undefined) return () => {}
  let prevArchived: readonly SessionId[] = workspaces.list.getSnapshot().archivedSessionIds
  return workspaces.list.subscribe(() => {
    const archived = workspaces.list.getSnapshot().archivedSessionIds
    for (const id of archived) {
      if (prevArchived.includes(id)) continue
      if (!shouldFollow()) continue
      void undoRemote.rollbackChild({ sessionId: id }).then(carried => {
        const child = carried.ok ? carried.value : undefined
        if (child !== undefined) openRollbackChild(navigation, child.rollbackSessionId)
      })
    }
    prevArchived = archived
  })
}
