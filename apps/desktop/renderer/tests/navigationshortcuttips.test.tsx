import { inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { NavChip } from '../src/canvas/desk'
import { registerAgentNativeTooltipDocument } from '../src/canvas/agentnav'
import { orgNavigationTooltip, ORG_NAV_KEYS } from '../src/shell/orgnavigationbindings'
import type { CanvasNode } from '../src/types'

test('shortcut tips use the same live binding rows as org navigation', () => {
  for (const row of ORG_NAV_KEYS) assert.equal(orgNavigationTooltip('jump', row.id), `jump\n${row.keys.join(' / ')} — ${row.action}`)
  assert.match(orgNavigationTooltip('last desk', 'lastDesk'), /Shift\+F7/)
  assert.equal(orgNavigationTooltip('identity', 'not-navigation'), 'identity')
})
test('superior and subordinate chips preserve canonical identity hover with the relevant shortcut hint', async () => {
  for (const dir of ['up', 'down'] as const) {
    const node = { id: 'target', tier: 'sol', state: 'live', children: [], audiences_held: [] } as unknown as CanvasNode
    const view = await mountView(<NavChip n={node} dir={dir} onJump={() => {}} />, el => el)
    const stop = registerAgentNativeTooltipDocument(view.el.ownerDocument, () => ({ title: 'Canonical Sol identity' }))
    try {
      const button = view.el.querySelector('button')!
      await inAct(async () => button.dispatchEvent(new window.MouseEvent('pointerover', { bubbles: true })))
      assert.match(button.title, /^Canonical Sol identity\nShift\+Alt\+Arrow/)
      assert.match(button.title, dir === 'up' ? /visible parent/ : /centre-most visible direct child/)
    } finally { stop(); await view.unmount() }
  }
})
