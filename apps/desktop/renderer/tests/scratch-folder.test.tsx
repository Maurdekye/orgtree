import './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { agentMenuEntries } from '../src/canvas/agentmenu'
import { scratchFolderAction } from '../src/scratch-folder'
import type { CanvasNode } from '../src/canvas/shared'
import type { NativeDesktop } from '../src/desktop'

const nativeWindow = window as Window & { orgtreeDesktop?: NativeDesktop }
test('native action is absent in browsers/old shells, appears for live/archived agents and passes identity', async () => {
  const original = nativeWindow.orgtreeDesktop
  const toasts: string[][] = [], calls: string[][] = []
  const toast = (lines: string[]) => { toasts.push(lines) }
  try {
    delete nativeWindow.orgtreeDesktop
    assert.equal(scratchFolderAction('mine', 'agent', toast), undefined)
    nativeWindow.orgtreeDesktop = {} as NativeDesktop
    assert.equal(scratchFolderAction('mine', 'agent', toast), undefined)
    nativeWindow.orgtreeDesktop = { openAgentScratchFolder: async (org: string, node: string) => {
      calls.push([org, node]); return { ok: true }
    } } as NativeDesktop
    for (const state of ['live', 'archived']) {
      const action = scratchFolderAction('mine', 'agent', toast)
      const entries = agentMenuEntries({ id: 'agent', state, children: [] } as unknown as CanvasNode,
        { onInbox() {}, onSettings() {}, onScratchFolder: action })
      const branch = entries.find(e => typeof e !== 'string' && e.label === 'Open')
      assert.ok(branch && typeof branch !== 'string')
      const entry = branch.children?.find(e => typeof e !== 'string' && e.label === 'Scratch folder')
      assert.ok(entry && typeof entry !== 'string')
      entry.onSelect()
    }
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(calls, [['mine', 'agent'], ['mine', 'agent']]); assert.deepEqual(toasts, [])
    nativeWindow.orgtreeDesktop.openAgentScratchFolder = async () => ({ ok: false, error: 'folder missing' })
    scratchFolderAction('mine', 'agent', toast)!()
    await new Promise(resolve => setImmediate(resolve))
    assert.match(toasts[0][0], /folder missing/)
    nativeWindow.orgtreeDesktop.openAgentScratchFolder = async () => { throw new Error('IPC refused') }
    scratchFolderAction('mine', 'agent', toast)!()
    await new Promise(resolve => setImmediate(resolve))
    assert.match(toasts[1][0], /IPC refused/)
  } finally { nativeWindow.orgtreeDesktop = original }
})
