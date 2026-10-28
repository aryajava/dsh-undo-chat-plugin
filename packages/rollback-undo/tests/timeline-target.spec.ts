import { describe, expect, it } from 'vitest'
import type { MessageId } from '@deepseek-ai/dsh-llm/brand'
import { rollbackCountToRetainLayer } from '../src/index.ts'

const id = (value: string): MessageId => value as MessageId
const layers = [
  { messageId: id('latest') },
  { messageId: id('middle') },
  { messageId: id('earliest') },
]

describe('/undo selected-node semantics', () => {
  it('retains the selected node and removes only newer nodes', () => {
    expect(rollbackCountToRetainLayer(layers, id('latest'))).toBe(0)
    expect(rollbackCountToRetainLayer(layers, id('middle'))).toBe(1)
    expect(rollbackCountToRetainLayer(layers, id('earliest'))).toBe(2)
  })

  it('rejects a node that is no longer in the active timeline', () => {
    expect(rollbackCountToRetainLayer(layers, id('missing'))).toBeUndefined()
  })
})
