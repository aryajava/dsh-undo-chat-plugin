/** Theme-token contract for the undo timeline overlay. */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const css = readFileSync(
  fileURLToPath(new URL('../src/client/UndoTimeline.module.css', import.meta.url)),
  'utf8',
)

describe('undo timeline theme contract', () => {
  it('uses the DSH layer tokens that switch with data-ds-dark-theme', () => {
    expect(css).toContain('--undo-mask-bg: var(--dsw-alias-bg-layer-1,')
    expect(css).toContain('--undo-bg: var(--dsw-alias-bg-layer-2,')
  })

  it('keeps complete light fallbacks when theme aliases are unavailable', () => {
    expect(css).toContain('var(--dsw-alias-bg-l1, var(--dsw-bg, #ffffff))')
    expect(css).toContain('var(--dsw-alias-bg-l2, var(--dsw-bg, #ffffff))')
    expect(css).toContain('--undo-fg: var(--dsw-alias-label-primary, var(--dsw-text-primary, #18181b))')
  })
})
