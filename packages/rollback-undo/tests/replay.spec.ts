import { describe, expect, it } from 'vitest'
import type { MessageId } from '@deepseek-ai/dsh-llm/brand'
import { replayPromptMessage, revokeForkCut } from '../src/index.ts'

describe('revoke of a rollback performed during generation', () => {
  it('cuts before the interrupted prompt and recreates it as fresh user input', () => {
    const journal = {
      messageId: 'interrupted-message' as MessageId,
      prompt: 'answer this again',
      replayPromptOnRevoke: true,
    }

    expect(revokeForkCut(journal)).toEqual({
      kind: 'before-user-message',
      messageId: 'interrupted-message',
    })
    const replay = replayPromptMessage(journal)
    expect(replay?.content).toEqual([{ type: 'text', text: 'answer this again' }])
    expect(replay?.source).toEqual({ kind: 'user' })
    expect(replay?.id).not.toBe('interrupted-message')
  })

  it('retains a normally completed turn without replaying its prompt', () => {
    const journal = { messageId: 'completed-message' as MessageId, prompt: 'already answered' }
    expect(revokeForkCut(journal)).toEqual({ kind: 'completed-turn' })
    expect(replayPromptMessage(journal)).toBeUndefined()
  })
})
