/**
 * One-generation user-message rollback with a private Git snapshot journal
 * (standalone plugin edition). The original dsh-internal seam version relied
 * on unpublished core APIs – agent termination, archive restoration, and
 * permanent deletion. This standalone build uses only published dsh APIs:
 * cancellation plus quiescence waiting replaces forced termination, tombstone
 * hiding replaces permanent deletion, and unarchive-based undo restoration is
 * dropped entirely.
 * @module @dsh-undo/rollback-undo
 */

import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import s from '@deepseek-ai/schemastery'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-jobs'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {} from '@dsh-undo/rollback-archive'
import type { SessionForkCut } from '@dsh-undo/rollback-fork'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-terminal'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-workspace'
import { assertSupportedWorkspace, dataComponent, readJson, ShadowGit, writeJson } from './shadow-git.ts'
import { conversationUndoJournalSchema } from './spec.ts'
import { performPluginUpdate, pluginWorkspaceRoot } from './update.ts'
import type {
  ConversationAdmissionFailureRequest, ConversationAdmissionFailureValue, ConversationArchiveActionRequest,
  ConversationArchiveActionValue, ConversationCurrentRequest, ConversationRevokePairRequest,
  ConversationRevokePairValue, ConversationRevokeRequest, ConversationRollbackChildRequest,
  ConversationUndoFailure, ConversationUndoJournal, ConversationUndoLatestRequest, ConversationUndoLayerInspectionRequest,
  ConversationUndoLayerInspectionValue, ConversationUndoLayersRequest, ConversationUndoLayerValue, ConversationUndoResult,
  ConversationUndoThroughRequest,
  ConversationUndoValue, LogicalConversationId,
} from './types.ts'

export type * from './types.ts'

/** Deployment-owned directory for private Shadow Git repositories and journals. */
export interface Config {
  /** Absolute application-data root owned exclusively by this plugin. */
  readonly root: string
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** User-message rollback journal capability. */
    conversationUndo: ConversationUndoService
  }
}

/** Return direct text-only user content; every other submission is ineligible. */
function topLevelText(message: UserMessage): string | undefined {
  if (
    message.source.kind !== 'user'
    || ('delivery' in message.source && message.source.delivery === 'steer')
    || !message.content.every(block => block.type === 'text')
  ) return undefined
  return message.content.map(block => block.text).join('')
}

/** Extract shell-like commands from the dsh tool-call records for one turn. */
function commandsForTurn(
  events: readonly { readonly type: string; readonly data: unknown }[],
  turn: number,
): ConversationUndoLayerInspectionValue['commands'] {
  const commands: ConversationUndoLayerInspectionValue['commands'][number][] = []
  for (const event of events) {
    if (event.type !== 'tool/call' || !isToolCallForTurn(event.data, turn)) continue
    const command = commandFromArguments(event.data.arguments)
    const path = pathFromArguments(event.data.arguments)
    commands.push({ tool: event.data.name, ...(command === undefined ? {} : { command }), ...(path === undefined ? {} : { path }) })
  }
  return commands
}

/** Narrow a serializable tool-call record without relying on a particular tool package. */
function isToolCallForTurn(value: unknown, turn: number): value is { readonly turn: number; readonly name: string; readonly arguments: string } {
  if (value === null || typeof value !== 'object') return false
  const candidate = value as { turn?: unknown; name?: unknown; arguments?: unknown }
  return candidate.turn === turn && typeof candidate.name === 'string' && typeof candidate.arguments === 'string'
}

/** Prefer executable fields over opaque tool JSON, redacting recognisable API-key strings. */
function commandFromArguments(argumentsText: string): string | undefined {
  try {
    const value: unknown = JSON.parse(argumentsText)
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
    const candidate = value as Record<string, unknown>
    const command = [candidate.cmd, candidate.command, candidate.script].find(item => typeof item === 'string')
    if (typeof command !== 'string' || command.trim() === '') return undefined
    return redactSecrets(command)
  } catch {
    return undefined
  }
}

/** Extract a single user-visible workspace path from common read/write tool arguments. */
function pathFromArguments(argumentsText: string): string | undefined {
  try {
    const value: unknown = JSON.parse(argumentsText)
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
    const candidate = value as Record<string, unknown>
    const path = [candidate.path, candidate.filePath, candidate.file_path, candidate.file, candidate.filename, candidate.target].find(item => typeof item === 'string')
    return typeof path === 'string' && path.trim() !== '' ? path : undefined
  } catch {
    return undefined
  }
}

/** Keep inspection output read-only without exposing recognisable API keys from commands or diffs. */
function redactSecrets(value: string): string {
  return value.replace(/\bsk-[a-z0-9_-]{8,}\b/giu, '[API key hidden]')
}

/** Seed a new logical lineage from its first physical Session identity. */
function initialLogicalConversationId(sessionId: SessionId): LogicalConversationId {
  return sessionId as unknown as LogicalConversationId
}

/** Transaction fields a write may clear; omitted keys leave the manifest without the field. */
type ClearableJournalField = 'rollbackSessionId' | 'redoTree' | 'rollbackTree' | 'revokeSessionId' | 'replayPromptOnRevoke' | 'retainedGeneration'

/** Copy one journal with the given optional transaction fields removed.
 * @param journal - Journal to copy.
 * @param fields - Optional fields to omit from the copy.
 * @returns A journal without the requested fields.
 */
function withoutJournalFields(journal: ConversationUndoJournal, fields: readonly ClearableJournalField[]): ConversationUndoJournal {
  const cleared = { ...journal } as Record<ClearableJournalField, unknown>
  for (const field of fields) delete cleared[field]
  return cleared as ConversationUndoJournal
}

/** Select how revoke reconstructs the source transcript.
 * Interrupted turns are cut before their user message so the same prompt can
 * be submitted as fresh work; completed turns remain an immutable prefix.
 */
export function revokeForkCut(journal: Pick<ConversationUndoJournal, 'messageId' | 'replayPromptOnRevoke'>): SessionForkCut {
  return journal.replayPromptOnRevoke === true
    ? { kind: 'before-user-message', messageId: journal.messageId }
    : { kind: 'completed-turn' }
}

/** Recreate interrupted user input with a new identity for one fresh turn. */
export function replayPromptMessage(journal: Pick<ConversationUndoJournal, 'prompt' | 'replayPromptOnRevoke'>): UserMessage | undefined {
  if (journal.replayPromptOnRevoke !== true) return undefined
  return createUserMessage({ content: [{ type: 'text', text: journal.prompt }], source: { kind: 'user' } })
}

/** Count newer layers that must be removed while retaining the selected node.
 * Layers are newest-first, so the selected index is exactly the rollback count.
 */
export function rollbackCountToRetainLayer(
  layers: readonly Pick<ConversationUndoLayerValue, 'messageId'>[],
  messageId: ConversationUndoLayerValue['messageId'],
): number | undefined {
  const index = layers.findIndex(layer => layer.messageId === messageId)
  return index < 0 ? undefined : index
}

/** Find the completed-turn fork boundary that retains one selected prompt. */
export function retainedLayerForkCut(
  events: readonly { readonly type: string; readonly seq: number; readonly data: unknown }[],
  messageId: ConversationUndoLayerValue['messageId'],
): SessionForkCut | undefined {
  const message = events.find(event =>
    event.type === 'user/message'
    && event.data !== null
    && typeof event.data === 'object'
    && (event.data as { id?: unknown }).id === messageId)
  return message === undefined ? undefined : { kind: 'completed-turn', atSeq: message.seq }
}

/** Resolve the exact workspace state a completed rollback published. */
function rollbackTargetTree(journal: Pick<ConversationUndoJournal, 'beforeTree' | 'rollbackTree'>): ConversationUndoJournal['beforeTree'] {
  return journal.rollbackTree ?? journal.beforeTree
}

/** Host owner of an append-only rollback lineage and its private snapshots. */
export class ConversationUndoService extends TypertRemoteService {
  static inject = ['agents', 'sessions', 'sessionArchive', 'sessionFork', 'sessionPersistence', 'workspaceRegistry', 'commands']
  static Config: s<Config> = s.object({ root: s.string().min(1).required() })

  private readonly operationTails = new Map<SessionId, Promise<void>>()
  private readonly rollbackSessions = new Set<SessionId>()
  private readonly rollbackWorkspaces = new Set<string>()
  private readonly admissionFailures = new Map<SessionId, ConversationAdmissionFailureValue>()
  private readonly statWarmers = new Map<string, Promise<void>>()
  private readonly prearms = new Map<string, Promise<void>>()
  private readonly workspaceChecks = new Map<string, Promise<void>>()

  /** @param ctx - Host context with top-level agents and archive/fork capabilities. @param config - journal directory. */
  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'conversationUndo')
  }

  /** Create the journal root, recover durable work, and install admission listeners. */
  protected async [Service.init](): Promise<void> {
    await mkdir(this.config.root, { recursive: true })
    await this.recoverJournals()
    this.ctx.on('agent/pre-step', async (payload, next) => {
      const message = payload.messages.find(candidate => topLevelText(candidate) !== undefined)
      if (message !== undefined && !await this.arm(payload.agent, message, payload.turn)) return { kind: 'reject' }
      return await next()
    })
    this.ctx.on('agent/turn-stopping', async ({ agent, turn }) => {
      await this.markReady(agent, turn)
    })
    this.ctx.commands.register({
      name: 'undo',
      description: 'Roll back to just before the latest completed message, restoring files and conversation',
      handler: invocation => this.rollbackCommand(invocation),
    })
    this.ctx.commands.register({
      name: 'update',
      description: 'Update dsh-undo-plugin: pull the latest code and rebuild (takes effect after a dsh restart)',
      handler: invocation => this.updateCommand(invocation),
    })
  }

  /** Execute `/update`: pull, install, and rebuild this plugin's own workspace.
   * @param invocation - command invocation; no arguments are accepted.
   * @returns A human-facing summary or failure.
   */
  private async updateCommand(invocation: CommandInvocation): Promise<CommandResult> {
    if (invocation.rawInput.trim().length > 0) {
      return { kind: 'error', text: 'Update dsh-undo-plugin: pull the latest code and rebuild (takes effect after a dsh restart)' }
    }
    try {
      return { kind: 'success', text: await performPluginUpdate(pluginWorkspaceRoot()) }
    } catch (error) {
      return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
    }
  }

  /** Execute `/undo` for the receiving agent's latest completed message.
   * @param invocation - command invocation naming the receiving agent.
   * @returns A human-facing success or refusal.
   */
  private async rollbackCommand(invocation: CommandInvocation): Promise<CommandResult> {
    if (invocation.rawInput.trim().length > 0) {
      return { kind: 'error', text: 'Roll back to just before the latest completed message, restoring files and conversation' }
    }
    const workspace = invocation.agent.session.header.cwd
    if (workspace === undefined) {
      return { kind: 'error', text: `Session ${invocation.agent.id} has no workspace, so a rollback point cannot be created. Open a session with a Git workspace first.` }
    }
    const journal = await this.readActiveJournal(invocation.agent.id)
    if (journal === undefined || (journal.phase !== 'armed' && journal.phase !== 'ready')) {
      return {
        kind: 'error',
        text: `Session ${invocation.agent.id} has no message to roll back. Send a plain-text message there and wait for the answer to finish (workspace: ${workspace}).`,
      }
    }
    const result = await this.undoLatest({
      sessionId: invocation.agent.id,
      userMessageId: journal.messageId,
    })
    if (!result.ok) return { kind: 'error', text: result.error.message }
    return { kind: 'success', text: `Rolled back. New session: ${result.value.sessionId}` }
  }

  /** Read the latest rollback point directly owned by one physical Session.
   * @param request - Physical Session to inspect.
   * @returns Its latest Host-approved rollback point, when available.
   */
  @Remote('current')
  async current(request: ConversationCurrentRequest): Promise<ConversationUndoResult> {
    const journal = await this.readActiveJournal(request.sessionId)
    if (journal?.phase === 'recovery-required') {
      return this.failure('recovery-required', 'An earlier rollback still needs host recovery; do not keep working in this workspace.')
    }
    if (journal?.phase !== 'armed' && journal?.phase !== 'ready') return this.success({ sessionId: request.sessionId })
    return this.success(this.viewFor(journal))
  }

  /** Read and clear the last refused-admission failure for one physical Session.
   * @param request - Physical Session that refused a prompt.
   * @returns The redacted failure once; an absent cache entry means no refusal.
   */
  @Remote('admissionFailure')
  async admissionFailure(request: ConversationAdmissionFailureRequest): Promise<ConversationAdmissionFailureValue | undefined> {
    const value = this.admissionFailures.get(request.sessionId)
    this.admissionFailures.delete(request.sessionId)
    return value
  }

  /** Resolve the child Session a completed rollback published for a source Session.
   * @param request - Physical source Session.
   * @returns The published rollback child, when the source journal completed.
   */
  @Remote('rollbackChild')
  async rollbackChild(request: ConversationRollbackChildRequest): Promise<{ rollbackSessionId: SessionId } | undefined> {
    const journal = await this.findLatestJournal(journal =>
      journal.sourceSessionId === request.sessionId
      && journal.phase === 'complete'
      && journal.rollbackSessionId !== undefined,
    )
    if (journal === undefined || journal.rollbackSessionId === undefined) return undefined
    return { rollbackSessionId: journal.rollbackSessionId }
  }

  /** Read the completed rollback pair one child Session may still revoke.
   * @param request - Physical rollback child Session to inspect.
   * @returns The archived source and rolled-back prompt while the pair is retained.
   */
  @Remote('revokePair')
  async revokePair(request: ConversationRevokePairRequest): Promise<ConversationRevokePairValue | undefined> {
    const journal = await this.findCurrentRevokePair(request.sessionId)
    if (journal?.phase !== 'complete') return undefined
    return { sourceSessionId: journal.sourceSessionId, prompt: journal.prompt }
  }

  /** Read the timeline points reachable by repeatedly rolling back the current last message. */
  @Remote('layers')
  async layers(request: ConversationUndoLayersRequest): Promise<readonly ConversationUndoLayerValue[]> {
    return await this.layersFor(request.sessionId)
  }

  /** Read the files and executable tool commands produced by one timeline point. */
  @Remote('inspectLayer')
  async inspectLayer(request: ConversationUndoLayerInspectionRequest): Promise<ConversationUndoLayerInspectionValue> {
    const journal = await this.journalForLayer(request.sessionId, request.userMessageId)
    if (journal === undefined) return { files: [], commands: [] }
    const afterTree = journal.afterTree
    const files = afterTree === undefined
      ? []
      : await (async () => {
        const shadow = new ShadowGit(journal.workspace, this.shadowDirectory(journal))
        const changes = await shadow.changes(journal.beforeTree, afterTree)
        return await Promise.all(changes.map(async change => {
          const diff = redactSecrets(await shadow.diffPreview(journal.beforeTree, afterTree, change.path) ?? '')
          return { ...change, ...(diff === '' ? {} : { diff }) }
        }))
      })()
    const events = await this.eventsForSession(journal.sourceSessionId)
    return {
      files,
      commands: commandsForTurn(events, journal.turn),
      ...journal.completedAt === undefined ? {} : { completedAt: journal.completedAt },
    }
  }

  /** Remove only layers newer than the selected node, retaining that node as the resulting tip. */
  @Remote('undoThrough')
  async undoThrough(request: ConversationUndoThroughRequest): Promise<ConversationUndoResult> {
    const layers = await this.layersFor(request.sessionId)
    const rollbackCount = rollbackCountToRetainLayer(layers, request.userMessageId)
    if (rollbackCount === undefined) return this.failure('no-undo', 'The chosen rollback point is no longer valid; reopen the rollback picker.')
    // Selecting the current tip is a valid zero-step navigation operation.
    if (rollbackCount === 0) return this.success({ sessionId: request.sessionId })
    // Preserve the proven single-edge transaction unchanged. Only true
    // multi-step jumps need the direct private-Git path below.
    if (rollbackCount === 1) {
      const active = await this.readActiveJournal(request.sessionId)
      return active === undefined
        ? this.failure('no-undo', 'The rollback chain changed; reopen the rollback picker.')
        : await this.undoLatest({ sessionId: request.sessionId, userMessageId: active.messageId })
    }
    return await this.undoToRetainedLayer(request)
  }

  /** Jump to a retained historical layer using one fork and one Git restore. */
  private undoToRetainedLayer(request: ConversationUndoThroughRequest): Promise<ConversationUndoResult> {
    if (this.rollbackSessions.has(request.sessionId)) {
      return Promise.resolve(this.failure('rollback-in-progress', 'This session is already rolling back.'))
    }
    this.rollbackSessions.add(request.sessionId)
    return this.enqueue(request.sessionId, async () => {
      const plan = await this.retainedLayerPlan(request.sessionId, request.userMessageId)
      if (plan === undefined) return this.failure('no-undo', 'The rollback chain changed; reopen the rollback picker.')
      let journal = plan.active
      const workspace = journal.workspace
      if (journal.phase !== 'armed' && journal.phase !== 'ready') {
        return this.failure('undo-not-ready', 'This message has not finished yet, so it cannot be rolled back.')
      }
      if (this.rollbackWorkspaces.has(workspace)) {
        return this.failure('rollback-in-progress', 'This workspace is already rolling back.')
      }
      this.rollbackWorkspaces.add(workspace)
      const recoverable = { ...journal, phase: 'ready' as const }
      try {
        await this.writeJournal({ ...journal, phase: 'quiescing' })
        const source = this.ctx.agents.get(journal.sourceSessionId)
        const retainedAgentOptions = source?.options
        if (source !== undefined && (source.status !== 'idle' || this.hasRunningDescendant(source))) {
          try {
            await this.quiesce(source)
          } catch (error) {
            await this.writeJournal(recoverable)
            return this.failure('session-busy', error instanceof Error ? error.message : String(error))
          }
        }
        const quiescingJournal = await this.findJournalByGeneration(journal.logicalConversationId, journal.generation)
        if (quiescingJournal === undefined || quiescingJournal.phase !== 'quiescing') {
          return this.failure('undo-not-ready', 'The session has not settled yet, so it cannot be rolled back.')
        }
        journal = quiescingJournal
        try {
          await this.assertWorkspace(workspace)
        } catch (error) {
          await this.writeJournal(recoverable)
          return this.failure('workspace-unsupported', error instanceof Error ? error.message : String(error))
        }
        const forkCut = retainedLayerForkCut(await this.eventsForSession(journal.sourceSessionId), plan.retained.messageId)
        if (forkCut === undefined) {
          await this.writeJournal(recoverable)
          return this.failure('no-undo', 'The chosen rollback point is not on the current branch of this session; reopen the rollback picker.')
        }
        const shadow = new ShadowGit(workspace, this.shadowDirectory(journal))
        const redoTree = await shadow.capture()
        let child: AgentHandle | undefined
        try {
          const rollbackSessionId = `conversation-undo-${randomUUID()}` as SessionId
          const restoring: ConversationUndoJournal = {
            ...journal,
            rollbackSessionId,
            redoTree,
            rollbackTree: plan.retainedTree,
            retainedGeneration: plan.retained.generation,
            phase: 'restoring',
          }
          await this.writeJournal(restoring)
          const forkTask = this.ctx.sessionFork.fork({
            sourceSessionId: journal.sourceSessionId,
            childSessionId: rollbackSessionId,
            cut: forkCut,
            ...retainedAgentOptions === undefined ? {} : { retainedAgentOptions },
          })
          const restoreTask = shadow.restore(plan.retainedTree, redoTree)
          try {
            child = (await forkTask).handle
            await restoreTask
          } catch (error) {
            if (child === undefined) {
              await restoreTask.catch(() => {})
              try {
                await shadow.restore(redoTree, plan.retainedTree)
              } catch (compensateError) {
                throw new AggregateError([error, compensateError], 'rollback undo could not recover the failed direct rollback')
              }
            }
            throw error
          }
          try {
            await this.ctx.sessionArchive.archive(journal.sourceSessionId)
          } catch (error) {
            try {
              await shadow.restore(redoTree, plan.retainedTree)
            } catch (restoreError) {
              throw new AggregateError([error, restoreError], 'rollback undo could not recover the failed direct archive step')
            }
            throw error
          }
          await this.publishRetainedLayerToChild(restoring, child.agent.id)
          await this.writeJournal({ ...restoring, phase: 'complete' })
          const shadowDir = this.shadowDirectory(journal)
          const warmer = shadow.refreshStats()
            .catch(() => {})
            .finally(() => { this.statWarmers.delete(shadowDir) })
          this.statWarmers.set(shadowDir, warmer)
          const childJournal = {
            workspace: journal.workspace,
            logicalConversationId: journal.logicalConversationId,
            generation: journal.generation + 1,
            shadowLayout: 'lineage' as const,
          }
          const childShadowDir = this.shadowDirectory(childJournal)
          const prearm = new ShadowGit(workspace, childShadowDir).capture()
            .then(() => undefined)
            .catch(() => {})
            .finally(() => { this.prearms.delete(childShadowDir) })
          this.prearms.set(childShadowDir, prearm)
          return this.success({ sessionId: child.agent.id })
        } catch (error) {
          const recoveries: unknown[] = [error]
          if (child !== undefined) {
            try {
              await child.dispose()
            } catch (disposeError) {
              recoveries.push(disposeError)
            }
          }
          try {
            await this.writeJournal(recoverable)
          } catch (journalError) {
            recoveries.push(journalError)
          }
          throw recoveries.length === 1
            ? error
            : new AggregateError(recoveries, 'rollback undo could not recover the failed direct rollback')
        }
      } finally {
        this.rollbackWorkspaces.delete(workspace)
      }
    }).finally(() => { this.rollbackSessions.delete(request.sessionId) })
  }

  /** Restore the archived source's full conversation and its redo tree, then archive the child.
   * @param request - Physical rollback child Session holding the completed pair.
   * @returns The restored replacement Session or a business refusal.
   */
  @Remote('revoke')
  revoke(request: ConversationRevokeRequest): Promise<ConversationUndoResult> {
    if (this.rollbackSessions.has(request.sessionId)) {
      return Promise.resolve(this.failure('rollback-in-progress', 'This session is already revoking a rollback.'))
    }
    this.rollbackSessions.add(request.sessionId)
    return this.enqueue(request.sessionId, async () => {
      const journal = await this.findCurrentRevokePair(request.sessionId)
      if (journal === undefined || journal.phase !== 'complete' || journal.redoTree === undefined) {
        return this.failure('no-undo', 'This session has no rollback to revoke.')
      }
      const workspace = journal.workspace
      if (this.rollbackWorkspaces.has(workspace)) {
        return this.failure('rollback-in-progress', 'This workspace is already rolling back.')
      }
      this.rollbackWorkspaces.add(workspace)
      // A completed journal never carries revokeSessionId, so the journal
      // itself is the recoverable pre-transaction manifest.
      const recoverable: ConversationUndoJournal = journal
      try {
        const child = this.ctx.agents.get(request.sessionId)
        const retainedAgentOptions = child?.options
        if (child !== undefined && (child.status !== 'idle' || this.hasRunningDescendant(child))) {
          try {
            await this.quiesce(child)
          } catch (error) {
            return this.failure('session-busy', error instanceof Error ? error.message : String(error))
          }
        }
        try {
          await this.assertWorkspace(workspace)
        } catch (error) {
          return this.failure('workspace-unsupported', error instanceof Error ? error.message : String(error))
        }
        const shadow = new ShadowGit(workspace, this.shadowDirectory(journal))
        await this.statWarmers.get(this.shadowDirectory(journal))
        const rollbackTree = rollbackTargetTree(journal)
        if (!await shadow.verifyMatches(rollbackTree)) {
          return this.failure('workspace-diverged', 'Workspace files changed after the rollback, so it cannot be revoked safely.')
        }
        const redoTree = journal.redoTree
        const revokeSessionId = `conversation-undo-${randomUUID()}` as SessionId
        await this.writeJournal({ ...journal, revokeSessionId, phase: 'revoking' })
        let restored: AgentHandle | undefined
        try {
          // The fork reads only session persistence while the restore touches
          // only workspace files, so the two run concurrently. The revoking
          // journal above is already durable, so a crash mid-flight lands in
          // the same recovery state the sequential order produced.
          const forkTask = this.ctx.sessionFork.fork({
            sourceSessionId: journal.sourceSessionId,
            childSessionId: revokeSessionId,
            cut: revokeForkCut(journal),
            ...retainedAgentOptions === undefined ? {} : { retainedAgentOptions },
          })
          const restoreTask = shadow.restore(redoTree, rollbackTree)
          try {
            restored = (await forkTask).handle
            await restoreTask
          } catch (error) {
            if (restored === undefined) {
              // The fork failed while the restore may have started moving
              // files: settle it and put the worktree back on the before tree
              // before the generic recovery rewrites the journal.
              await restoreTask.catch(() => {})
              try {
                await shadow.restore(rollbackTree, redoTree)
              } catch (compensateError) {
                throw new AggregateError([error, compensateError], 'rollback revoke could not recover the failed fork')
              }
            }
            throw error
          }
          try {
            await this.ctx.sessionArchive.archive(request.sessionId)
          } catch (error) {
            // The child stays unarchived; compensate the file state only. The
            // outer catch disposes the restored Session and rewrites the
            // recoverable journal, so startup recovery re-evaluates the
            // transaction.
            try {
              await shadow.restore(rollbackTree, redoTree)
            } catch (restoreError) {
              throw new AggregateError([error, restoreError], 'rollback revoke could not recover the failed archive step')
            }
            throw error
          }
          if (journal.replayPromptOnRevoke === true) {
            // The restored transcript ends immediately before the interrupted
            // prompt. Carry only its predecessor; the fresh followup below
            // arms the replayed prompt itself. Re-publishing the interrupted
            // point here would duplicate it in the lineage and make one
            // timeline rollback remove the same prompt twice.
            await this.publishPredecessorToChild(journal, restored.agent.id)
          } else {
            await this.writeJournal({
              ...withoutJournalFields(journal, ['rollbackSessionId', 'redoTree', 'rollbackTree', 'revokeSessionId', 'replayPromptOnRevoke', 'retainedGeneration']),
              sourceSessionId: restored.agent.id,
              phase: 'ready',
            })
          }
          // The verify/restore steps left the shadow index stat cache cold;
          // warm it so a follow-up rollback's redoTree capture skips the
          // full-worktree stat pass, mirroring the undoLatest completion.
          const shadowDir = this.shadowDirectory(journal)
          const warmer = shadow.refreshStats()
            .catch(() => {})
            .finally(() => { this.statWarmers.delete(shadowDir) })
          this.statWarmers.set(shadowDir, warmer)
          const replay = replayPromptMessage(journal)
          if (replay !== undefined) restored.agent.followup(replay)
          return this.success({ sessionId: restored.agent.id })
        } catch (error) {
          const recoveries: unknown[] = [error]
          if (restored !== undefined) {
            try {
              await restored.dispose()
            } catch (disposeError) {
              recoveries.push(disposeError)
            }
          }
          try {
            await this.writeJournal(recoverable)
          } catch (journalError) {
            recoveries.push(journalError)
          }
          throw recoveries.length === 1
            ? error
            : new AggregateError(recoveries, 'rollback revoke could not recover the failed revoke')
        }
      } finally {
        this.rollbackWorkspaces.delete(workspace)
      }
    }).finally(() => { this.rollbackSessions.delete(request.sessionId) })
  }

  /** Select the recovery state the Archive Tasks page may surface for one archived Session.
   * @param request - Archived physical Session to inspect.
   * @returns The journal-derived archive-page action.
   */
  @Remote('archiveAction')
  async archiveAction(request: ConversationArchiveActionRequest): Promise<ConversationArchiveActionValue> {
    const journal = await this.findLatestJournal(journal => journal.sourceSessionId === request.sessionId)
    if (journal?.phase === 'cleanup-pending' || journal?.phase === 'quiescing' || journal?.phase === 'restoring') {
      return { action: 'cleanup-pending' }
    }
    if (journal?.phase === 'recovery-required') return { action: 'recovery-required' }
    return { action: 'archived' }
  }

  /** Fork before the selected message, restore its before-tree, and archive the source.
   * @param request - Source Session and latest approved message to roll back.
   * @returns Replacement Session or a business refusal.
   */
  @Remote('undoLatest')
  undoLatest(request: ConversationUndoLatestRequest): Promise<ConversationUndoResult> {
    if (this.rollbackSessions.has(request.sessionId)) {
      return Promise.resolve(this.failure('rollback-in-progress', 'This session is already rolling back.'))
    }
    this.rollbackSessions.add(request.sessionId)
    return this.enqueue(request.sessionId, async () => {
      let journal = await this.readActiveJournal(request.sessionId)
      if (journal === undefined || journal.sourceSessionId !== request.sessionId) {
        return this.failure('no-undo', 'This conversation has no message that can be rolled back.')
      }
      if (journal.messageId !== request.userMessageId) {
        return this.failure('not-latest-message', 'Only the latest completed message can be rolled back.')
      }
      if (journal.phase !== 'armed' && journal.phase !== 'ready') {
        return this.failure('undo-not-ready', 'This message has not finished yet, so it cannot be rolled back.')
      }
      const workspace = journal.workspace
      if (this.rollbackWorkspaces.has(workspace)) {
        return this.failure('rollback-in-progress', 'This workspace is already rolling back.')
      }
      this.rollbackWorkspaces.add(workspace)
      const replayPromptOnRevoke = journal.phase === 'armed'
      const recoverable = { ...journal, phase: 'ready' as const }
      try {
        await this.writeJournal({ ...journal, phase: 'quiescing' })
        const source = this.ctx.agents.get(journal.sourceSessionId)
        const retainedAgentOptions = source?.options
        if (source !== undefined && (source.status !== 'idle' || this.hasRunningDescendant(source))) {
          try {
            await this.quiesce(source)
          } catch (error) {
            await this.writeJournal(recoverable)
            return this.failure('session-busy', error instanceof Error ? error.message : String(error))
          }
        }
        // Historical points stay ready so a rollback child can inherit them.
        // Resume this transaction by its immutable generation, not by the
        // generic "current" lookup (which would otherwise select its parent).
        journal = await this.findJournalByGeneration(journal.logicalConversationId, journal.generation)
        if (journal === undefined || journal.phase !== 'quiescing') {
          return this.failure('undo-not-ready', 'The session has not settled yet, so it cannot be rolled back.')
        }
        try {
          await this.assertWorkspace(journal.workspace)
        } catch (error) {
          await this.writeJournal(recoverable)
          return this.failure('workspace-unsupported', error instanceof Error ? error.message : String(error))
        }
        const shadow = new ShadowGit(journal.workspace, this.shadowDirectory(journal))
        const redoTree = await shadow.capture()
        let child: AgentHandle | undefined
        try {
          const rollbackSessionId = `conversation-undo-${randomUUID()}` as SessionId
          const restoring: ConversationUndoJournal = {
            ...journal,
            rollbackSessionId,
            redoTree,
            ...replayPromptOnRevoke ? { replayPromptOnRevoke: true } : {},
            phase: 'restoring',
          }
          await this.writeJournal(restoring)
          // The fork reads only session persistence while the restore touches
          // only workspace files, so the two run concurrently. The restoring
          // journal above is already durable, so a crash mid-flight lands in
          // the same recovery state the sequential order produced.
          const forkTask = this.ctx.sessionFork.fork({
            sourceSessionId: journal.sourceSessionId,
            childSessionId: rollbackSessionId,
            cut: { kind: 'before-user-message', messageId: journal.messageId },
            ...retainedAgentOptions === undefined ? {} : { retainedAgentOptions },
          })
          const restoreTask = shadow.restore(journal.beforeTree, redoTree)
          try {
            child = (await forkTask).handle
            await restoreTask
          } catch (error) {
            if (child === undefined) {
              // The fork failed while the restore may have started moving
              // files: settle it and put the worktree back on the redo tree
              // before the generic recovery rewrites the journal.
              await restoreTask.catch(() => {})
              try {
                await shadow.restore(redoTree, journal.beforeTree)
              } catch (compensateError) {
                throw new AggregateError([error, compensateError], 'rollback undo could not recover the failed fork')
              }
            }
            throw error
          }
          try {
            await this.ctx.sessionArchive.archive(journal.sourceSessionId)
          } catch (error) {
            // The source stays unarchived; compensate the file state only.
            // The outer catch disposes the child and rewrites the recoverable
            // journal, so startup recovery re-evaluates the transaction.
            try {
              await shadow.restore(redoTree, journal.beforeTree)
            } catch (restoreError) {
              throw new AggregateError([error, restoreError], 'rollback undo could not recover the failed archive step')
            }
            throw error
          }
          // Carry the preceding message point into the freshly forked child.
          // The completed journal above remains the revocable edge; the child
          // receives a new active record that points at the same private tree.
          // This is what makes rollback #2, #3, ... available without another
          // model admission.
          await this.publishPredecessorToChild(journal, child.agent.id)
          await this.writeJournal({ ...restoring, phase: 'complete' })
          // Warm the shadow index stat cache in the background and remember
          // the promise: a later revoke waits for it (or finds it done) and
          // its verify then skips the full-worktree stat pass. Failure is
          // harmless — verify falls back to a cold pass.
          const shadowDir = this.shadowDirectory(journal)
          const warmer = shadow.refreshStats()
            .catch(() => {})
            .finally(() => { this.statWarmers.delete(shadowDir) })
          this.statWarmers.set(shadowDir, warmer)
          // Pre-initialize the child generation's shadow repository in the
          // background: its first arm capture would otherwise pay the cold
          // `git add` over the whole worktree. The pre-captured tree equals
          // beforeTree (restore just materialized it), which is exactly the
          // child's first before-tree unless the user edits files first —
          // arm's incremental add then corrects it. arm awaits this promise
          // so the two never contend for the shadow index.
          const childJournal = {
            workspace: journal.workspace,
            logicalConversationId: journal.logicalConversationId,
            generation: journal.generation + 1,
            shadowLayout: 'lineage' as const,
          }
          const childShadowDir = this.shadowDirectory(childJournal)
          const prearm = new ShadowGit(workspace, childShadowDir).capture()
            .then(() => undefined)
            .catch(() => {})
            .finally(() => { this.prearms.delete(childShadowDir) })
          this.prearms.set(childShadowDir, prearm)
          return this.success({ sessionId: child.agent.id })
        } catch (error) {
          const recoveries: unknown[] = [error]
          if (child !== undefined) {
            try {
              await child.dispose()
            } catch (disposeError) {
              recoveries.push(disposeError)
            }
          }
          try {
            await this.writeJournal(recoverable)
          } catch (journalError) {
            recoveries.push(journalError)
          }
          throw recoveries.length === 1
            ? error
            : new AggregateError(recoveries, 'rollback undo could not recover the failed rollback')
        }
      } finally {
        this.rollbackWorkspaces.delete(workspace)
      }
    }).finally(() => { this.rollbackSessions.delete(request.sessionId) })
  }

  /** Capture an eligible prompt's before-tree before delegating model admission. */
  private async arm(agent: Agent, message: UserMessage, turn: number): Promise<boolean> {
    if (agent.session.header.origin === 'subagent') return true
    const prompt = topLevelText(message)
    const workspace = agent.session.header.cwd
    if (prompt === undefined || workspace === undefined) return true
    if (this.rollbackWorkspaces.has(workspace)) {
      this.recordAdmissionFailure(agent.id, prompt, 'A rollback is in progress; try again in a moment.')
      return false
    }
    return await this.enqueue(agent.id, async () => {
      try {
        if (this.rollbackWorkspaces.has(workspace)) {
          this.recordAdmissionFailure(agent.id, prompt, 'A rollback is in progress; try again in a moment.')
          return false
        }
        await this.assertWorkspace(workspace)
        // Every eligible prompt is retained.  A physical Session can therefore
        // expose its newest point while a child produced by rollback inherits
        // the preceding point without requiring another prompt admission.
        const journals = await this.readJournals()
        const active = this.selectLatest(journals.filter(journal =>
          journal.sourceSessionId === agent.id
          && (journal.phase === 'armed' || journal.phase === 'ready'),
        ))
        const inherited = active ?? this.selectLatest(journals.filter(journal =>
          journal.rollbackSessionId === agent.id
          && journal.phase === 'complete',
        ))
        // A rollback child may admit its first replacement prompt before the
        // asynchronous predecessor publication completes.  In that brief
        // window `active` is absent but `inherited` is the completed edge;
        // link to its predecessor rather than starting a truncated chain.
        const predecessorGeneration = active?.generation ?? inherited?.predecessorGeneration
        const draft: ConversationUndoJournal = {
          schemaVersion: 1,
          logicalConversationId: inherited?.logicalConversationId ?? initialLogicalConversationId(agent.id),
          generation: this.nextGeneration(journals, inherited?.logicalConversationId ?? initialLogicalConversationId(agent.id)),
          ...(predecessorGeneration === undefined ? {} : { predecessorGeneration }),
          shadowLayout: 'lineage',
          sourceSessionId: agent.id,
          messageId: message.id,
          prompt,
          workspace,
          beforeTree: '' as ConversationUndoJournal['beforeTree'],
          turn,
          phase: 'armed',
        }
        // A rollback may be pre-initializing this journal's shadow
        // repository in the background; wait for it (usually already
        // settled) so the two never contend for the shadow index.
        await this.prearms.get(this.shadowDirectory(draft))
        const beforeTree = await new ShadowGit(workspace, this.shadowDirectory(draft)).capture()
        await this.writeJournal({ ...draft, beforeTree })
        // A new branch makes prior rollback edges non-revocable, but archived
        // Sessions remain visible until the user explicitly deletes them from
        // Archive Tasks. Timeline manifests stay intact for older nodes.
        void this.expireRevokePairsForBranch(draft.logicalConversationId)
        return true
      } catch (error) {
        this.ctx.logger.warn(`rollback undo: refusing prompt because its before-tree snapshot failed: ${String(error)}`)
        this.recordAdmissionFailure(agent.id, prompt, 'Local snapshot failed (snapshot-failed).')
        return false
      }
    })
  }

  /** Cache one refused admission for the browser composer to poll once. */
  private recordAdmissionFailure(sessionId: SessionId, prompt: string, detail: string): void {
    this.admissionFailures.set(sessionId, { prompt, detail })
    this.ctx.emit('undo/admission-failed', { sessionId, prompt, detail })
  }

  /** Mark an admitted prompt ready after its turn closes. */
  private async markReady(agent: Agent, turn: number): Promise<void> {
    const journal = await this.readActiveJournal(agent.id)
    if (journal?.phase !== 'armed' || journal.turn !== turn) return
    try {
      const afterTree = await new ShadowGit(journal.workspace, this.shadowDirectory(journal)).capture()
      await this.writeJournal({ ...journal, afterTree, completedAt: Date.now(), phase: 'ready' })
    } catch (error) {
      // This read-only inspector is an enhancement; its snapshot must never
      // take away an otherwise valid rollback point after the answer finishes.
      this.ctx.logger.warn(`rollback undo: step-change snapshot unavailable: ${String(error)}`)
      await this.writeJournal({ ...journal, completedAt: Date.now(), phase: 'ready' })
    }
  }

  /** Expire old revoke actions after a new branch prompt without deleting archived Sessions. */
  private async expireRevokePairsForBranch(logicalConversationId: LogicalConversationId): Promise<void> {
    const journals = await this.readJournals()
    const revocable = journals.filter(journal =>
      journal.logicalConversationId === logicalConversationId
      && journal.phase === 'complete'
      && journal.revokeExpired !== true)
    await Promise.all(revocable.map(journal => this.writeJournal({ ...journal, revokeExpired: true })))
  }

  /** Recover or surface every durable operation interrupted before Host shutdown. */
  private async recoverJournals(): Promise<void> {
    for (const journal of await this.readJournals()) {
      if (journal.sourceTombstoned === true) continue
      if (journal.sourceTombstonePending === true) {
        await this.recoverDeferredCleanup(journal)
        continue
      }
      switch (journal.phase) {
        case 'cleanup-pending':
          await this.recoverDeferredCleanup(journal)
          break
        case 'quiescing':
          await this.writeJournal({ ...journal, phase: 'ready' })
          this.ctx.logger.warn(`rollback undo: reset interrupted pre-publication rollback for "${journal.sourceSessionId}"`)
          break
        case 'restoring':
          await this.recoverRestoring(journal)
          break
        case 'revoking':
          await this.recoverRevoking(journal)
          break
        default:
          break
      }
    }
  }

  /** Retry one deferred tombstone without preventing unrelated Host startup. */
  private async recoverDeferredCleanup(journal: ConversationUndoJournal): Promise<void> {
    try {
      if (await this.sessionExists(journal.sourceSessionId)) {
        const result = await this.ctx.sessionArchive.tombstone(journal.sourceSessionId)
        if (!result.ok) throw new Error(result.error.message)
      }
      const siblings = (await this.readJournals()).filter(candidate =>
        candidate.logicalConversationId === journal.logicalConversationId
        && candidate.sourceSessionId === journal.sourceSessionId)
      await Promise.all(siblings.map(candidate => this.writeJournal({
        ...candidate,
        sourceTombstoned: true,
      })))
    } catch (error) {
      this.ctx.logger.warn(`rollback undo: startup tombstone for "${journal.sourceSessionId}" is still deferred: ${String(error)}`)
    }
  }

  /** Complete only an independently verified restoring transaction; otherwise preserve an explicit recovery state. */
  private async recoverRestoring(journal: ConversationUndoJournal): Promise<void> {
    if (journal.rollbackSessionId === undefined || journal.redoTree === undefined) {
      await this.requireRecovery(journal, 'manifest has no rollback Session or redo tree')
      return
    }
    try {
      await this.assertWorkspace(journal.workspace)
      const shadow = new ShadowGit(journal.workspace, this.shadowDirectory(journal))
      const sourceArchived = this.ctx.workspaceRegistry.archivedSessionIds.includes(journal.sourceSessionId)
      const rollbackArchived = this.ctx.workspaceRegistry.archivedSessionIds.includes(journal.rollbackSessionId ?? ('' as SessionId))
      const rollbackExists = await this.sessionExists(journal.rollbackSessionId ?? ('' as SessionId))
      if (sourceArchived && !rollbackArchived && rollbackExists && await shadow.verifyMatches(rollbackTargetTree(journal))) {
        await this.publishRetainedLayerToChild(journal, journal.rollbackSessionId)
        await this.writeJournal({ ...journal, phase: 'complete' })
        return
      }
      if (!sourceArchived && await shadow.verifyMatches(journal.redoTree ?? journal.beforeTree)) {
        if (rollbackExists) await this.hideUnpublishedChild(journal.rollbackSessionId ?? ('' as SessionId))
        await this.writeJournal({ ...journal, phase: 'ready' })
        return
      }
      await this.requireRecovery(journal, 'archive membership or private Shadow Git tree does not describe a safe publication state')
    } catch (error) {
      await this.requireRecovery(journal, error instanceof Error ? error.message : String(error))
    }
  }

  /** Determine whether a rollback child is present in either live or durable session ownership. */
  private async sessionExists(sessionId: SessionId): Promise<boolean> {
    return this.ctx.sessions.get(sessionId) !== undefined
      || (await this.ctx.sessionPersistence.list()).some(snapshot => snapshot.header.id === sessionId)
  }

  /** Hide an unpublished rollback child; without a termination API it stays on disk but out of every UI. */
  private async hideUnpublishedChild(sessionId: SessionId): Promise<void> {
    const agent = this.ctx.agents.get(sessionId)
    if (agent !== undefined) {
      if (agent.status !== 'idle') {
        agent.cancel({ kind: 'user' })
        await this.waitForAgentIdle(agent, Date.now() + 2000)
      }
      if (agent.status !== 'idle') throw new Error(`rollback child "${sessionId}" did not quiesce and cannot be hidden`)
    }
    await this.ctx.sessionArchive.archive(sessionId)
  }

  /** Complete only an independently verified revoke transaction; otherwise preserve an explicit recovery state. */
  private async recoverRevoking(journal: ConversationUndoJournal): Promise<void> {
    if (journal.rollbackSessionId === undefined || journal.revokeSessionId === undefined || journal.redoTree === undefined) {
      await this.requireRecovery(journal, 'revoke manifest is missing its child Session, restored Session, or redo tree')
      return
    }
    const revokeSessionId: SessionId = journal.revokeSessionId
    try {
      await this.assertWorkspace(journal.workspace)
      const shadow = new ShadowGit(journal.workspace, this.shadowDirectory(journal))
      const revokeExists = await this.sessionExists(revokeSessionId)
      const childArchived = this.ctx.workspaceRegistry.archivedSessionIds.includes(journal.rollbackSessionId)
      const revokeArchived = this.ctx.workspaceRegistry.archivedSessionIds.includes(revokeSessionId)
      if (childArchived && !revokeArchived && revokeExists && await shadow.verifyMatches(journal.redoTree)) {
        await this.writeJournal({
          ...withoutJournalFields(journal, ['rollbackSessionId', 'redoTree', 'rollbackTree', 'revokeSessionId', 'replayPromptOnRevoke', 'retainedGeneration']),
          sourceSessionId: revokeSessionId,
          phase: 'ready',
        })
        return
      }
      if (!childArchived && await shadow.verifyMatches(rollbackTargetTree(journal))) {
        if (revokeExists) await this.hideUnpublishedChild(revokeSessionId)
        await this.writeJournal({ ...withoutJournalFields(journal, ['revokeSessionId']), phase: 'complete' })
        return
      }
      await this.requireRecovery(journal, 'archive membership or private Shadow Git tree does not describe a safe revoke state')
    } catch (error) {
      await this.requireRecovery(journal, error instanceof Error ? error.message : String(error))
    }
  }

  /** Preserve a recovery-required manifest instead of claiming an ambiguous transaction succeeded. */
  private async requireRecovery(journal: ConversationUndoJournal, detail: string): Promise<void> {
    await this.writeJournal({ ...journal, phase: 'recovery-required' })
    this.ctx.logger.error(`rollback undo: rollback for "${journal.sourceSessionId}" requires recovery: ${detail}`)
  }

  /** Detect live child work that makes a file restoration unsafe. */
  private hasRunningDescendant(root: Agent): boolean {
    return this.ownedAgentTree(root).some(agent => agent !== root && agent.status !== 'idle')
  }

  /** Request cooperative stop and force-stop registered work before touching tracked files. */
  private async quiesce(source: Agent): Promise<void> {
    const agents = this.ownedAgentTree(source)
    for (const agent of agents) {
      if (agent.status !== 'idle') agent.cancel({ kind: 'user' })
    }
    await this.waitForQuiescence(agents)
    if (agents.some(agent => agent.status !== 'idle') || this.hasControlledActivity(agents)) {
      await this.forceStopControlledActivity(agents)
    }
    const deadline = Date.now() + 2000
    while ((agents.some(agent => agent.status !== 'idle') || this.hasControlledActivity(agents)) && Date.now() < deadline) {
      await new Promise<void>(resolve => { setTimeout(resolve, 50) })
    }
    const runningAgents = agents.filter(agent => this.ctx.agents.get(agent.id) !== undefined && agent.status !== 'idle')
    if (runningAgents.length > 0 || this.hasControlledActivity(agents)) {
      throw new Error(`The session still has ${String(runningAgents.length)} running tasks or managed processes, so it cannot be rolled back safely.`)
    }
  }

  /** Check whether registered job or terminal providers still own work for the Agent tree. */
  private hasControlledActivity(agents: readonly Agent[]): boolean {
    const jobs = this.ctx.get('jobs')
    const terminals = this.ctx.get('terminals')
    return agents.some(agent =>
      (jobs?.list(agent.id).some(job => job.status === 'running' || job.status === 'stopping') ?? false)
      || (terminals?.hasOwnerActivity(agent) ?? false),
    )
  }

  /** Force-stop registered jobs and PTYs only after the cooperative grace period elapses. */
  private async forceStopControlledActivity(agents: readonly Agent[]): Promise<void> {
    const jobs = this.ctx.get('jobs')
    const terminals = this.ctx.get('terminals')
    const stops: Promise<unknown>[] = []
    for (const agent of agents) {
      if (jobs !== undefined) {
        for (const job of jobs.list(agent.id)) {
          if (job.status === 'running' || job.status === 'stopping') jobs.kill(job.id, agent.id, 'rollback quiescence')
        }
      }
      if (terminals !== undefined) {
        for (const terminal of terminals.list(agent)) {
          if (terminal.status.kind === 'running') stops.push(terminals.kill(agent, terminal.sessionId, 'rollback quiescence'))
        }
      }
    }
    await Promise.all(stops)
  }

  /** Resolve the source and all transitive runtime-owned descendants. */
  private ownedAgentTree(root: Agent): Agent[] {
    const descendants = new Set<Agent>([root])
    const agents = this.ctx.agents.list()
    let changed = true
    while (changed) {
      changed = false
      for (const candidate of agents) {
        if (descendants.has(candidate)) continue
        if ([...descendants].some(parent => this.ctx.agents.isOwnedBy(candidate.id, parent))) {
          descendants.add(candidate)
          changed = true
        }
      }
    }
    return [...descendants]
  }

  /** Give Agents, registered jobs, and PTYs a short chance to stop cooperatively. */
  private async waitForQuiescence(agents: readonly Agent[]): Promise<void> {
    const deadline = Date.now() + 500
    while ((agents.some(agent => agent.status !== 'idle') || this.hasControlledActivity(agents)) && Date.now() < deadline) {
      await new Promise<void>(resolve => { setTimeout(resolve, 25) })
    }
  }

  /** Poll one Agent until idle or the deadline passes. */
  private async waitForAgentIdle(agent: Agent, deadline: number): Promise<void> {
    while (Date.now() < deadline) {
      await new Promise<void>(resolve => { setTimeout(resolve, 50) })
      if (agent.status === 'idle') return
    }
  }

  /** Assert workspace support once per workspace per Host run.
   * The worktree and submodule facts a passing check establishes cannot
   * regress while this Host owns the workspace, and the check's
   * `ls-files --stage` output scales with the whole tracked tree, so every
   * prompt admission re-running it dominates the arm cost. A failing check
   * is not cached.
   * @param workspace - Candidate worktree root.
   * @returns Resolution only for a supported non-bare, submodule-free worktree.
   */
  private assertWorkspace(workspace: string): Promise<void> {
    let check = this.workspaceChecks.get(workspace)
    if (check === undefined) {
      check = assertSupportedWorkspace(workspace)
      this.workspaceChecks.set(workspace, check)
      void check.catch(() => { this.workspaceChecks.delete(workspace) })
    }
    return check
  }

  /** Select the newest durable record by lineage generation. */
  private selectLatest(journals: readonly ConversationUndoJournal[]): ConversationUndoJournal | undefined {
    return journals.reduce<ConversationUndoJournal | undefined>((latest, journal) =>
      latest === undefined || journal.generation > latest.generation ? journal : latest,
    undefined)
  }

  /** Allocate a never-reused record generation inside one logical lineage. */
  private nextGeneration(journals: readonly ConversationUndoJournal[], logicalConversationId: LogicalConversationId): number {
    const latest = this.selectLatest(journals.filter(journal => journal.logicalConversationId === logicalConversationId))
    return (latest?.generation ?? -1) + 1
  }

  /** Read the physical Session's currently actionable latest point. */
  private async readActiveJournal(sourceSessionId: SessionId): Promise<ConversationUndoJournal | undefined> {
    return this.selectLatest((await this.readJournals()).filter(journal =>
      journal.sourceSessionId === sourceSessionId
      && (journal.phase === 'armed' || journal.phase === 'ready')))
  }

  /** Find the newest journal matching an arbitrary durable predicate. */
  private async findLatestJournal(
    predicate: (journal: ConversationUndoJournal) => boolean,
  ): Promise<ConversationUndoJournal | undefined> {
    return this.selectLatest((await this.readJournals()).filter(predicate))
  }

  /** Resolve one immutable point reference in a logical rollback path. */
  private async findJournalByGeneration(
    logicalConversationId: LogicalConversationId,
    generation: number,
  ): Promise<ConversationUndoJournal | undefined> {
    return this.selectLatest((await this.readJournals()).filter(journal =>
      journal.logicalConversationId === logicalConversationId && journal.generation === generation))
  }

  /** Publish the retained layer for a direct jump, or the usual predecessor for one-edge rollback. */
  private async publishRetainedLayerToChild(journal: ConversationUndoJournal, childSessionId: SessionId): Promise<void> {
    const generation = journal.retainedGeneration ?? journal.predecessorGeneration
    if (generation === undefined) return
    const retained = await this.findJournalByGeneration(journal.logicalConversationId, generation)
    if (retained === undefined) return
    await this.publishJournalToChild(journal, retained, childSessionId)
  }

  /** Give a completed one-edge rollback child the point immediately before the removed message. */
  private async publishPredecessorToChild(journal: ConversationUndoJournal, childSessionId: SessionId): Promise<void> {
    if (journal.predecessorGeneration === undefined) return
    const predecessor = await this.findJournalByGeneration(journal.logicalConversationId, journal.predecessorGeneration)
    if (predecessor === undefined) return
    await this.publishJournalToChild(journal, predecessor, childSessionId)
  }

  /** Copy exactly one ready historical point into a newly published child Session. */
  private async publishJournalToChild(
    rollback: ConversationUndoJournal,
    retained: ConversationUndoJournal,
    childSessionId: SessionId,
  ): Promise<void> {
    const existing = await this.readActiveJournal(childSessionId)
    if (existing?.messageId === retained.messageId && existing.logicalConversationId === rollback.logicalConversationId) return
    const generations = await this.readJournals()
    const inherited: ConversationUndoJournal = {
      ...withoutJournalFields(retained, ['rollbackSessionId', 'redoTree', 'rollbackTree', 'revokeSessionId', 'replayPromptOnRevoke', 'retainedGeneration']),
      generation: this.nextGeneration(generations, rollback.logicalConversationId),
      shadowLayout: 'lineage',
      sourceSessionId: childSessionId,
      phase: 'ready',
    }
    await this.writeJournal(inherited)
  }

  /** Resolve one direct-jump plan and the exact retained workspace tree. */
  private async retainedLayerPlan(
    sessionId: SessionId,
    messageId: ConversationUndoThroughRequest['userMessageId'],
  ): Promise<{ active: ConversationUndoJournal; retained: ConversationUndoJournal; retainedTree: ConversationUndoJournal['beforeTree'] } | undefined> {
    const journals = await this.readJournals()
    let current = this.selectLatest(journals.filter(candidate =>
      candidate.sourceSessionId === sessionId
      && (candidate.phase === 'armed' || candidate.phase === 'ready')))
    if (current === undefined) return undefined
    const active = current
    const reachable: ConversationUndoJournal[] = []
    const visited = new Set<number>()
    while (current !== undefined && !visited.has(current.generation)) {
      visited.add(current.generation)
      reachable.push(current)
      if (current.predecessorGeneration === undefined) break
      const generation = current.predecessorGeneration
      current = this.selectLatest(journals.filter(candidate =>
        candidate.logicalConversationId === active.logicalConversationId
        && candidate.generation === generation))
    }
    const index = reachable.findIndex(candidate => candidate.messageId === messageId)
    if (index < 2) return undefined
    const retained = reachable[index]
    const newer = reachable[index - 1]
    if (retained === undefined || newer === undefined) return undefined
    return { active, retained, retainedTree: newer.beforeTree }
  }

  /** Read events from a live Session when possible, otherwise its immutable persisted copy. */
  private async eventsForSession(sessionId: SessionId): Promise<readonly { readonly type: string; readonly seq: number; readonly data: unknown }[]> {
    const live = this.ctx.sessions.get(sessionId)
    if (live !== undefined) return live.snapshotEvents()
    const handle = await this.ctx.sessionPersistence.open(sessionId, 'read')
    try {
      return (await handle.read()).events
    } finally {
      await handle.close()
    }
  }

  /** Enumerate the active point followed by each reachable predecessor. */
  private async layersFor(sessionId: SessionId): Promise<ConversationUndoLayerValue[]> {
    const journals = await this.readJournals()
    let journal = this.selectLatest(journals.filter(candidate =>
      candidate.sourceSessionId === sessionId
      && (candidate.phase === 'armed' || candidate.phase === 'ready')))
    const layers: ConversationUndoLayerValue[] = []
    const visited = new Set<number>()
    while (journal !== undefined && !visited.has(journal.generation)) {
      visited.add(journal.generation)
      layers.push({ messageId: journal.messageId, prompt: journal.prompt })
      const predecessorGeneration = journal.predecessorGeneration
      if (predecessorGeneration === undefined) break
      const logicalConversationId = journal.logicalConversationId
      journal = this.selectLatest(journals.filter(candidate =>
        candidate.logicalConversationId === logicalConversationId
        && candidate.generation === predecessorGeneration))
    }
    return layers
  }

  /** Resolve the retained journal belonging to one selectable timeline point. */
  private async journalForLayer(sessionId: SessionId, messageId: ConversationUndoLayerInspectionRequest['userMessageId']): Promise<ConversationUndoJournal | undefined> {
    const journals = await this.readJournals()
    let journal = this.selectLatest(journals.filter(candidate =>
      candidate.sourceSessionId === sessionId
      && (candidate.phase === 'armed' || candidate.phase === 'ready')))
    const visited = new Set<number>()
    while (journal !== undefined && !visited.has(journal.generation)) {
      visited.add(journal.generation)
      if (journal.messageId === messageId) return journal
      const predecessorGeneration = journal.predecessorGeneration
      if (predecessorGeneration === undefined) return undefined
      const logicalConversationId = journal.logicalConversationId
      journal = this.selectLatest(journals.filter(candidate =>
        candidate.logicalConversationId === logicalConversationId
        && candidate.generation === predecessorGeneration))
    }
    return undefined
  }

  /** Find the one topmost completed rollback that the current branch may revoke. */
  private async findCurrentRevokePair(sessionId: SessionId): Promise<ConversationUndoJournal | undefined> {
    const journals = await this.readJournals()
    const direct = this.selectLatest(journals.filter(journal =>
      journal.rollbackSessionId === sessionId
      && journal.phase === 'complete'
      && journal.revokeExpired !== true))
    if (direct !== undefined) return direct
    const active = this.selectLatest(journals.filter(journal =>
      journal.sourceSessionId === sessionId
      && (journal.phase === 'armed' || journal.phase === 'ready')))
    if (active === undefined) return undefined
    return this.selectLatest(journals.filter(journal =>
      journal.logicalConversationId === active.logicalConversationId
      && journal.phase === 'complete'
      && journal.revokeExpired !== true))
  }

  /** Read every durable journal; an absent private directory is empty state. */
  private async readJournals(): Promise<ConversationUndoJournal[]> {
    let workspaceDirectories: string[]
    try {
      workspaceDirectories = await readdir(join(this.config.root, 'undo'))
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    const journals: ConversationUndoJournal[] = []
    for (const workspaceDirectory of workspaceDirectories) {
      let conversationDirectories: string[]
      try {
        conversationDirectories = await readdir(join(this.config.root, 'undo', workspaceDirectory))
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
        throw error
      }
      for (const conversationDirectory of conversationDirectories) {
        let generationDirectories: string[]
        try {
          generationDirectories = await readdir(join(this.config.root, 'undo', workspaceDirectory, conversationDirectory))
        } catch (error: unknown) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
          throw error
        }
        for (const generationDirectory of generationDirectories) {
          const journal = await readJson(
            join(this.config.root, 'undo', workspaceDirectory, conversationDirectory, generationDirectory, 'manifest.json'),
            conversationUndoJournalSchema,
          )
          if (journal !== undefined) journals.push(journal)
        }
      }
    }
    return journals
  }

  /** Convert one journal into the message-action response. */
  private viewFor(journal: ConversationUndoJournal): ConversationUndoValue {
    return { sessionId: journal.sourceSessionId, messageId: journal.messageId, prompt: journal.prompt }
  }

  /** Create a stable success response. */
  private success(value: ConversationUndoValue): ConversationUndoResult {
    return { ok: true, value }
  }

  /** Create a stable business refusal. */
  private failure(code: ConversationUndoFailure['code'], message: string): ConversationUndoResult {
    return { ok: false, error: { code, message } }
  }

  /** One private journal path, partitioned by workspace, lineage, and generation. */
  private journalDirectory(journal: Pick<ConversationUndoJournal, 'workspace' | 'logicalConversationId' | 'generation'>): string {
    return join(this.lineageDirectory(journal), String(journal.generation))
  }

  /** Private lineage directory shared by every durable point in a conversation. */
  private lineageDirectory(journal: Pick<ConversationUndoJournal, 'workspace' | 'logicalConversationId'>): string {
    return join(
      this.config.root,
      'undo',
      createHash('sha256').update(journal.workspace).digest('hex'),
      dataComponent(journal.logicalConversationId),
    )
  }

  /** Private Shadow Git repository; new lineages share one object store across all points. */
  private shadowDirectory(journal: Pick<ConversationUndoJournal, 'workspace' | 'logicalConversationId' | 'generation' | 'shadowLayout'>): string {
    if (journal.shadowLayout === 'lineage') {
      return join(this.lineageDirectory(journal), 'shadow-git')
    }
    return join(this.journalDirectory(journal), 'shadow-git')
  }

  /** Persist one journal phase transition. */
  private async writeJournal(journal: ConversationUndoJournal): Promise<void> {
    await writeJson(join(this.journalDirectory(journal), 'manifest.json'), conversationUndoJournalSchema.parse(journal))
  }

  /** Serialize all journal mutations for one physical source Session. */
  private enqueue<T>(sessionId: SessionId, operation: () => Promise<T>): Promise<T> {
    const prior = this.operationTails.get(sessionId) ?? Promise.resolve()
    const result = prior.then(operation, operation)
    const tail = result.then(() => undefined, () => undefined)
    this.operationTails.set(sessionId, tail)
    return result.finally(() => {
      if (this.operationTails.get(sessionId) === tail) this.operationTails.delete(sessionId)
    })
  }
}

export default ConversationUndoService
