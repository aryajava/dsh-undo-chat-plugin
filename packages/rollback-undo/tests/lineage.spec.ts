import { describe, expect, it } from 'vitest'
import { ConversationUndoService, retainedLayerForkCut } from '../src/index.ts'
import type { ConversationUndoJournal } from '../src/types.ts'

const TREE_A = 'a'.repeat(40)
const TREE_B = 'b'.repeat(40)

function journal(overrides: Partial<ConversationUndoJournal>): ConversationUndoJournal {
  return {
    schemaVersion: 1,
    logicalConversationId: 'lineage-a' as ConversationUndoJournal['logicalConversationId'],
    generation: 0,
    shadowLayout: 'lineage',
    sourceSessionId: 'source-a' as ConversationUndoJournal['sourceSessionId'],
    messageId: 'message-a' as ConversationUndoJournal['messageId'],
    prompt: 'message a',
    workspace: 'C:/workspace',
    beforeTree: TREE_A as ConversationUndoJournal['beforeTree'],
    turn: 1,
    phase: 'ready',
    ...overrides,
  }
}

type LineageMethods = {
  layersFor(sessionId: ConversationUndoJournal['sourceSessionId']): Promise<unknown>
  findCurrentRevokePair(sessionId: ConversationUndoJournal['sourceSessionId']): Promise<unknown>
  expireRevokePairsForBranch(logicalConversationId: ConversationUndoJournal['logicalConversationId']): Promise<void>
  selectLatest(journals: readonly ConversationUndoJournal[]): ConversationUndoJournal | undefined
}

function methods(): LineageMethods {
  return ConversationUndoService.prototype as unknown as LineageMethods
}

function serviceWith(journals: ConversationUndoJournal[]) {
  const selected = methods()
  return {
    readJournals: async () => journals,
    selectLatest: selected.selectLatest,
  }
}

describe('continuous rollback lineage', () => {
  it('cuts at the selected prompt turn so a direct jump retains that completed prompt', () => {
    expect(retainedLayerForkCut([
      { type: 'turn/start', seq: 10, data: {} },
      { type: 'user/message', seq: 11, data: { id: 'message-1' } },
      { type: 'turn/end', seq: 12, data: {} },
    ], 'message-1' as ConversationUndoJournal['messageId']))
      .toEqual({ kind: 'completed-turn', atSeq: 11 })
  })

  it('lists the tip followed by each predecessor rather than discarded historical points', async () => {
    const journals = [
      journal({ generation: 0, sourceSessionId: 'archived-source' as ConversationUndoJournal['sourceSessionId'], messageId: 'message-1' as ConversationUndoJournal['messageId'], prompt: 'first' }),
      journal({ generation: 1, predecessorGeneration: 0, sourceSessionId: 'archived-source' as ConversationUndoJournal['sourceSessionId'], messageId: 'message-2' as ConversationUndoJournal['messageId'], prompt: 'second', beforeTree: TREE_B as ConversationUndoJournal['beforeTree'] }),
      journal({ generation: 2, predecessorGeneration: 1, sourceSessionId: 'active-child' as ConversationUndoJournal['sourceSessionId'], messageId: 'message-3' as ConversationUndoJournal['messageId'], prompt: 'third' }),
    ]

    await expect(methods().layersFor.call(serviceWith(journals), 'active-child' as ConversationUndoJournal['sourceSessionId']))
      .resolves.toEqual([
        { messageId: 'message-3', prompt: 'third' },
        { messageId: 'message-2', prompt: 'second' },
        { messageId: 'message-1', prompt: 'first' },
      ])
  })

  it('keeps every reachable point when a conversation has more than three prompts', async () => {
    const journals = Array.from({ length: 8 }, (_, generation) => journal({
      generation,
      ...(generation === 0 ? {} : { predecessorGeneration: generation - 1 }),
      sourceSessionId: 'active-session' as ConversationUndoJournal['sourceSessionId'],
      messageId: `message-${generation}` as ConversationUndoJournal['messageId'],
      prompt: `prompt ${generation}`,
    }))

    await expect(methods().layersFor.call(serviceWith(journals), 'active-session' as ConversationUndoJournal['sourceSessionId']))
      .resolves.toEqual(Array.from({ length: 8 }, (_, offset) => {
        const generation = 7 - offset
        return { messageId: `message-${generation}`, prompt: `prompt ${generation}` }
      }))
  })

  it('expires the old revoke edge without deleting its archived source Session', async () => {
    const archived = journal({
      generation: 0,
      sourceSessionId: 'archived-source' as ConversationUndoJournal['sourceSessionId'],
      rollbackSessionId: 'active-source' as NonNullable<ConversationUndoJournal['rollbackSessionId']>,
      redoTree: TREE_B as NonNullable<ConversationUndoJournal['redoTree']>,
      phase: 'complete',
    })
    const tip = journal({ generation: 1, predecessorGeneration: 0, sourceSessionId: 'active-source' as ConversationUndoJournal['sourceSessionId'] })
    const journals = [archived, tip]
    const writes: ConversationUndoJournal[] = []
    const service = {
      readJournals: async () => journals,
      writeJournal: async (value: ConversationUndoJournal) => { writes.push(value) },
    }

    await methods().expireRevokePairsForBranch.call(service, archived.logicalConversationId)

    expect(writes).toEqual([{ ...archived, revokeExpired: true }])
    expect(journals).toHaveLength(2)
  })

  it('does not offer an expired rollback edge for revoke', async () => {
    const journals = [journal({
      generation: 1,
      sourceSessionId: 'old-source' as ConversationUndoJournal['sourceSessionId'],
      rollbackSessionId: 'active-child' as NonNullable<ConversationUndoJournal['rollbackSessionId']>,
      redoTree: TREE_B as NonNullable<ConversationUndoJournal['redoTree']>,
      phase: 'complete',
      revokeExpired: true,
    })]

    await expect(methods().findCurrentRevokePair.call(serviceWith(journals), 'active-child' as ConversationUndoJournal['sourceSessionId']))
      .resolves.toBeUndefined()
  })

  it('advances the single revoke strip to the next completed edge after its child was restored', async () => {
    const journals = [
      journal({ generation: 1, sourceSessionId: 'old-source' as ConversationUndoJournal['sourceSessionId'], rollbackSessionId: 'old-child' as NonNullable<ConversationUndoJournal['rollbackSessionId']>, redoTree: TREE_B as NonNullable<ConversationUndoJournal['redoTree']>, phase: 'complete' }),
      journal({ generation: 2, predecessorGeneration: 1, sourceSessionId: 'restored-tip' as ConversationUndoJournal['sourceSessionId'], messageId: 'message-2' as ConversationUndoJournal['messageId'], prompt: 'second' }),
    ]

    await expect(methods().findCurrentRevokePair.call(serviceWith(journals), 'restored-tip' as ConversationUndoJournal['sourceSessionId']))
      .resolves.toMatchObject({ sourceSessionId: 'old-source', generation: 1 })
  })
})
