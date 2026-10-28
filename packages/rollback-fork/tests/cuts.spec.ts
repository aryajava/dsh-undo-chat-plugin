import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { MessageId } from '@deepseek-ai/dsh-llm/brand'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { DefaultSessionForkService } from '../src/index.ts'

interface CutReader {
  beforeUserMessagePrefix(source: { id: SessionId; events: readonly SessionEvent[] }, messageId: MessageId): SessionEvent[]
}

function reader(): CutReader {
  return DefaultSessionForkService.prototype as unknown as CutReader
}

describe('Session fork before-user-message cut', () => {
  it('excludes the complete target turn from the child seed', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create(SessionId('session-fork-prefix'))
    const retained = createUserMessage({ content: [{ type: 'text', text: 'retain' }], source: { kind: 'user' } })
    const target = createUserMessage({ content: [{ type: 'text', text: 'remove' }], source: { kind: 'user' } })
    session.append('turn/start', { turn: 1 })
    session.append('user/message', retained, { surfaceOp: 'append' })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    session.append('turn/start', { turn: 2 })
    session.append('user/message', target, { surfaceOp: 'append' })
    session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })

    const prefix = reader().beforeUserMessagePrefix({ id: session.id, events: session.snapshotEvents() }, target.id)

    expect(prefix).toEqual(session.snapshotEvents().slice(0, 3))
  })

  it('cuts before a steer by retaining and safely closing the preceding output segment', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create(SessionId('session-fork-steer'))
    const retained = createUserMessage({ content: [{ type: 'text', text: 'retain this segment' }], source: { kind: 'user' } })
    const steered = createUserMessage({
      content: [{ type: 'text', text: 'remove this steer' }],
      // Persisted claimed steer messages are ordinary `source.kind=user`;
      // their later step inside the same turn is the durable distinction.
      source: { kind: 'user' },
    })
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    session.append('user/message', retained, { surfaceOp: 'append' })
    session.append('step/end', { turn: 1, step: 1 })
    session.append('step/start', { turn: 1, step: 2 })
    session.append('user/message', steered, { surfaceOp: 'append' })
    session.append('step/end', { turn: 1, step: 2 })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

    const prefix = reader().beforeUserMessagePrefix({ id: session.id, events: session.snapshotEvents() }, steered.id)

    expect(prefix.some(event => event.type === 'user/message' && event.data.id === retained.id)).toBe(true)
    expect(prefix.some(event => event.type === 'user/message' && event.data.id === steered.id)).toBe(false)
    expect(prefix.at(-1)?.type).toBe('turn/end')
    expect(prefix.map(event => event.seq)).toEqual(prefix.map((_, index) => index))
    expect(() => Session.create(SessionId('validated-steer-prefix'), prefix)).not.toThrow()
  })
})
