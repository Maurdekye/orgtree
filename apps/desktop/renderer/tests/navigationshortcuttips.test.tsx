import { inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { NavChip } from '../src/canvas/desk'
import { registerAgentNativeTooltipDocument } from '../src/canvas/agentnav'
import { orgNavigationTooltip, ORG_NAV_KEYS } from '../src/shell/orgnavigationbindings'
import { USER, type CanvasNode } from '../src/canvas/shared'

test('command tips show compact same-line bindings with Unicode directions', () => {
  const keys = ['Shift+Alt+↑', 'Shift+Alt+↓', 'Shift+Alt+←', 'Shift+Alt+→', 'Shift+Alt+Space', 'Shift+Alt+Backspace', 'Shift+Alt+S']
  ORG_NAV_KEYS.forEach((row, i) => assert.equal(orgNavigationTooltip('command', row.id), `command (${keys[i]})`))
  assert.equal(orgNavigationTooltip('last desk', 'lastDesk'), 'last desk (Shift+F7)')
  assert.equal(orgNavigationTooltip('identity', 'not-navigation'), 'identity')
})
test('agent and project jump chips retain exact plain and canonical identity hover', async () => {
  for (const kind of ['agent', 'project'] as const) {
    for (const dir of ['up', 'down'] as const) {
      const node = { id: 'target', kind, tier: 'sol', state: 'live', children: [], audiences_held: [] } as unknown as CanvasNode
      const view = await mountView(<NavChip n={node} dir={dir} onJump={() => {}} />, el => el)
      const stop = registerAgentNativeTooltipDocument(view.el.ownerDocument, () => ({ title: 'Canonical Sol identity' }))
      try {
        const button = view.el.querySelector('button')!
        assert.equal(button.title, 'jump to target')
        await inAct(async () => button.dispatchEvent(new window.MouseEvent('pointerover', { bubbles: true })))
        assert.equal(button.title, 'Canonical Sol identity')
      } finally { stop(); await view.unmount() }
    }
  }
})

test('the switchboard jump command keeps its compact shortcut', async () => {
  const node = { id: USER, state: 'live', children: [] } as unknown as CanvasNode
  const view = await mountView(<NavChip n={node} dir="up" onJump={() => {}} />, el => el)
  try { assert.equal(view.el.querySelector('button')!.title, 'jump to the switchboard (Shift+Alt+S)') }
  finally { await view.unmount() }
})
