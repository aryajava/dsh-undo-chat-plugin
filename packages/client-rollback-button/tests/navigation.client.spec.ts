// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { keepRollbackChildOpen, openNativeTrajectory } from '../src/client/navigation.ts'

const CHILD = 'child' as SessionId

afterEach(() => { vi.useRealTimers() })

function navigation() {
  return { openSession: vi.fn((sessionId: SessionId) => { void sessionId }) }
}

describe('rollback child navigation', () => {
  it('re-asserts the child selection across the archive projection settles', () => {
    vi.useFakeTimers()
    const state = navigation()
    const dispose = keepRollbackChildOpen(state, CHILD)
    vi.runOnlyPendingTimers()

    // dsh 0.2.1 keeps the selection private to UiWorkspaceService, so the port
    // re-opens the child on each settle delay instead of watching the list
    // store for a cleared `current`.
    expect(state.openSession.mock.calls.map(call => call[0])).toEqual([CHILD, CHILD, CHILD, CHILD])
    dispose()
    vi.runOnlyPendingTimers()
    expect(state.openSession).toHaveBeenCalledTimes(4)
  })

  it('drops every delayed re-assert when disposed before the settles', () => {
    vi.useFakeTimers()
    const state = navigation()
    const dispose = keepRollbackChildOpen(state, CHILD)
    dispose()
    vi.runOnlyPendingTimers()
    expect(state.openSession).not.toHaveBeenCalled()
  })

  it('clamps the re-assert window to the requested hold', () => {
    vi.useFakeTimers()
    const state = navigation()
    keepRollbackChildOpen(state, CHILD, 500)
    vi.runOnlyPendingTimers()
    expect(state.openSession).toHaveBeenCalledTimes(3)
  })
})

describe('native trajectory navigation', () => {
  afterEach(() => { document.body.replaceChildren() })

  it('activates dsh’s trajectory tab instead of rendering a second inspection view', () => {
    const tabs = document.createElement('div')
    tabs.setAttribute('data-conversation-tabs', '')
    const chat = document.createElement('button')
    chat.setAttribute('role', 'tab')
    chat.textContent = 'Chat'
    const trajectory = document.createElement('button')
    trajectory.setAttribute('role', 'tab')
    trajectory.textContent = 'Trajectory'
    const click = vi.spyOn(trajectory, 'click')
    tabs.append(chat, trajectory)
    document.body.append(tabs)

    expect(openNativeTrajectory()).toBe(true)
    expect(click).toHaveBeenCalledOnce()
  })

  it('activates the registered trajectory view through the ui-conversation binding', () => {
    const activate = vi.fn()
    expect(openNativeTrajectory(undefined, activate)).toBe(true)
    expect(activate).toHaveBeenCalledOnce()
  })

  it('falls back to the tab when the binding is unavailable', () => {
    const tabs = document.createElement('div')
    tabs.setAttribute('data-conversation-tabs', '')
    const trajectory = document.createElement('button')
    trajectory.setAttribute('role', 'tab')
    trajectory.textContent = 'Trajectory'
    const click = vi.spyOn(trajectory, 'click')
    tabs.append(trajectory)
    document.body.append(tabs)

    const activate = (): void => { throw new Error('no binding') }
    expect(openNativeTrajectory(undefined, activate)).toBe(true)
    expect(click).toHaveBeenCalledOnce()
  })

  it('centers and highlights every trajectory row in the selected undo turn', () => {
    vi.useFakeTimers()
    const trajectory = document.createElement('button')
    trajectory.setAttribute('role', 'tab')
    trajectory.textContent = 'Trajectory'
    const table = document.createElement('table')
    const user = document.createElement('tr')
    const userCell = document.createElement('td')
    userCell.textContent = 'USER'
    const userText = document.createElement('td')
    userText.textContent = 'selected undo prompt'
    user.append(userCell, userText)
    Object.assign(user, { scrollIntoView: vi.fn() })
    const assistant = document.createElement('tr')
    const assistantCell = document.createElement('td')
    assistantCell.textContent = 'ASSISTANT'
    const assistantText = document.createElement('td')
    assistantText.textContent = 'selected response'
    assistant.append(assistantCell, assistantText)
    const tool = document.createElement('tr')
    const toolCell = document.createElement('td')
    toolCell.textContent = 'TOOL'
    const toolText = document.createElement('td')
    toolText.textContent = 'selected command'
    tool.append(toolCell, toolText)
    const nextUser = document.createElement('tr')
    const nextUserCell = document.createElement('td')
    nextUserCell.textContent = 'USER'
    const nextUserText = document.createElement('td')
    nextUserText.textContent = 'next prompt'
    nextUser.append(nextUserCell, nextUserText)
    table.append(user, assistant, tool, nextUser)
    const tabs = document.createElement('div')
    tabs.setAttribute('data-conversation-tabs', '')
    tabs.append(trajectory)
    document.body.append(tabs, table)

    expect(openNativeTrajectory('selected undo prompt')).toBe(true)
    vi.runAllTimers()
    expect(user.className).not.toBe('')
    expect(assistant.className).toBe(user.className)
    expect(tool.className).toBe(user.className)
    expect(nextUser.className).toBe('')
    expect(user.scrollIntoView).toHaveBeenCalledWith({ block: 'center', behavior: 'smooth' })
  })
})
