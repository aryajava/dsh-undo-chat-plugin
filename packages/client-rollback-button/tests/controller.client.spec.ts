import { describe, expect, it, vi } from 'vitest'
import type { MessageId } from '@deepseek-ai/dsh-client-connection/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { ConversationUndoController } from '../src/client/controller.ts'
import type { ConversationUndoRemote } from '../src/client/controller.ts'
import { formatAdmissionFailureDraft } from '../src/client/RollbackHeaderAction.tsx'
import { previewLine } from '../src/client/RollbackFold.tsx'
import { timelinePreview } from '../src/client/UndoTimeline.tsx'

const SESSION = 'session-a' as SessionId
const MESSAGE = 'message-a' as MessageId
const RESTORED = 'session-restored' as SessionId

function remote(overrides: Partial<ConversationUndoRemote> = {}): ConversationUndoRemote {
  const ready = {
    ok: true as const,
    value: {
      ok: true as const,
      value: { sessionId: SESSION, messageId: MESSAGE, prompt: 'restore this' },
    },
  }
  return {
    current: vi.fn(() => Promise.resolve(ready)),
    undoLatest: vi.fn(() => Promise.resolve(ready)),
    layers: vi.fn(() => Promise.resolve({ ok: true as const, value: [{ messageId: MESSAGE, prompt: 'restore this' }] })),
    inspectLayer: vi.fn(() => Promise.resolve({ ok: true as const, value: { files: [], commands: [] } })),
    undoThrough: vi.fn(() => Promise.resolve(ready)),
    admissionFailure: vi.fn(() => Promise.resolve({ ok: true as const, value: undefined })),
    rollbackChild: vi.fn(() => Promise.resolve({ ok: true as const, value: undefined })),
    revokePair: vi.fn(() => Promise.resolve({ ok: true as const, value: undefined })),
    revoke: vi.fn(() => Promise.resolve({
      ok: true as const,
      value: { ok: true as const, value: { sessionId: RESTORED } },
    })),
    ...overrides,
  }
}

describe('ConversationUndoController', () => {
  it('keeps the rejected prompt and its safe snapshot detail in the replacement draft', () => {
    expect(formatAdmissionFailureDraft('retry this', 'Local snapshot failed (snapshot-failed).'))
      .toBe('retry this\n---------\nFailure reason:\nLocal snapshot failed (snapshot-failed).')
  })

  it('reads the physical Session once and sends it to the rollback operation', async () => {
    const service = remote()
    const controller = new ConversationUndoController(service, SESSION)

    await Promise.all([controller.ensure(), controller.ensure()])
    await controller.undo(MESSAGE)

    expect(service.current).toHaveBeenCalledTimes(1)
    expect(service.current).toHaveBeenCalledWith({ sessionId: SESSION })
    expect(service.undoLatest).toHaveBeenCalledWith({ sessionId: SESSION, userMessageId: MESSAGE })
    expect(controller.getSnapshot()).toMatchObject({ status: 'ready', value: { messageId: MESSAGE } })
  })

  it('retains the prior view and surfaces a business refusal', async () => {
    const service = remote({
      undoLatest: vi.fn(() => Promise.resolve({
        ok: true as const,
        value: { ok: false as const, error: { code: 'session-busy' as const, message: 'wait for the turn' } },
      })),
    })
    const controller = new ConversationUndoController(service, SESSION)

    await controller.ensure()
    await expect(controller.undo(MESSAGE)).resolves.toBeUndefined()

    expect(controller.getSnapshot()).toMatchObject({
      status: 'error',
      value: { messageId: MESSAGE },
      error: 'wait for the turn',
    })
  })

  it('lists and continuously rolls back to a selected timeline point', async () => {
    const service = remote()
    const controller = new ConversationUndoController(service, SESSION)

    await expect(controller.layers()).resolves.toEqual([{ messageId: MESSAGE, prompt: 'restore this' }])
    await expect(controller.undoThrough(MESSAGE)).resolves.toEqual({ sessionId: SESSION, messageId: MESSAGE, prompt: 'restore this' })

    expect(service.layers).toHaveBeenCalledWith({ sessionId: SESSION })
    expect(service.undoThrough).toHaveBeenCalledWith({ sessionId: SESSION, userMessageId: MESSAGE })
  })

  it('reads the selected step inspection without changing the rollback state', async () => {
    const service = remote({
      inspectLayer: vi.fn(() => Promise.resolve({
        ok: true as const,
        value: {
          completedAt: 1_700_000_000_000,
          files: [{ path: 'src/app.ts', status: 'modified' as const, addedBytes: 12, deletedBytes: 3 }],
          commands: [{ tool: 'exec_command', command: 'pnpm test' }],
        },
      })),
    })
    const controller = new ConversationUndoController(service, SESSION)

    await expect(controller.inspectLayer(MESSAGE)).resolves.toEqual({
      completedAt: 1_700_000_000_000,
      files: [{ path: 'src/app.ts', status: 'modified', addedBytes: 12, deletedBytes: 3 }],
      commands: [{ tool: 'exec_command', command: 'pnpm test' }],
    })
    expect(service.inspectLayer).toHaveBeenCalledWith({ sessionId: SESSION, userMessageId: MESSAGE })
  })

  it('reads and clears a cached admission failure', async () => {
    const failure = { prompt: 'retry this', detail: 'Local snapshot failed (snapshot-failed).' }
    const service = remote({
      admissionFailure: vi.fn()
        .mockResolvedValueOnce({ ok: true as const, value: failure })
        .mockResolvedValue({ ok: true as const, value: undefined }),
    })
    const controller = new ConversationUndoController(service, SESSION)

    await expect(controller.admissionFailure()).resolves.toEqual(failure)
    await expect(controller.admissionFailure()).resolves.toBeUndefined()
  })

  it('keeps short prompts whole and truncates long ones with an ellipsis', () => {
    expect(previewLine('Reply with just "ok".', 48)).toBe('Reply with just "ok".')
    expect(previewLine('x'.repeat(60), 48)).toBe(`${'x'.repeat(48)}…`)
  })

  it('uses the first line and truncates long timeline prompts', () => {
    expect(timelinePreview('first line\nsecond line')).toBe('first line')
    expect(timelinePreview('x'.repeat(43))).toBe(`${'x'.repeat(42)}…`)
  })

  it('publishes the retained revoke pair alongside the rollback point', async () => {
    const service = remote({
      revokePair: vi.fn(() => Promise.resolve({
        ok: true as const,
        value: { sourceSessionId: 'session-source' as SessionId, prompt: 'remove me' },
      })),
    })
    const controller = new ConversationUndoController(service, SESSION)

    await controller.ensure()

    expect(service.revokePair).toHaveBeenCalledWith({ sessionId: SESSION })
    expect(controller.getSnapshot()).toMatchObject({
      status: 'ready',
      revokePair: { sourceSessionId: 'session-source', prompt: 'remove me' },
    })
  })

  it('revokes a completed rollback and clears the pair on success', async () => {
    const service = remote({
      revokePair: vi.fn(() => Promise.resolve({
        ok: true as const,
        value: { sourceSessionId: 'session-source' as SessionId, prompt: 'remove me' },
      })),
    })
    const controller = new ConversationUndoController(service, SESSION)

    await controller.ensure()
    await expect(controller.revoke()).resolves.toEqual({ sessionId: RESTORED })

    expect(service.revoke).toHaveBeenCalledWith({ sessionId: SESSION })
    expect(controller.getSnapshot()).toMatchObject({
      status: 'ready',
      value: { sessionId: SESSION },
      revokePair: undefined,
    })
  })

  it('retains the revoke pair and surfaces a revoke refusal', async () => {
    const service = remote({
      revokePair: vi.fn(() => Promise.resolve({
        ok: true as const,
        value: { sourceSessionId: 'session-source' as SessionId, prompt: 'remove me' },
      })),
      revoke: vi.fn(() => Promise.resolve({
        ok: true as const,
        value: { ok: false as const, error: { code: 'workspace-diverged' as const, message: 'Workspace files were modified' } },
      })),
    })
    const controller = new ConversationUndoController(service, SESSION)

    await controller.ensure()
    await expect(controller.revoke()).resolves.toBeUndefined()

    expect(controller.getSnapshot()).toMatchObject({
      status: 'error',
      revokePair: { sourceSessionId: 'session-source' },
      error: 'Workspace files were modified',
    })
  })
})
