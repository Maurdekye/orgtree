import './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import type { CanvasNode } from '../src/canvas/shared'
import { USER } from '../src/canvas/shared'
import { AgentTray, trayRows } from '../src/canvas/agenttray'
import { DEFAULT_PREFERENCES, preferencesPatch } from '../../main/policy'
import { flush, inAct, mountView } from './harness'

const node = (id: string, parent: string | null, busy = false): CanvasNode => ({
  id, parent, tier: 'opus', state: 'live', children: [], busy,
} as CanvasNode)

const map = () => new Map<string, CanvasNode>([
  [USER, node(USER, null)],
  ['idle-root', node('idle-root', USER)],
  ['active-root', node('active-root', USER, true)],
  ['idle-parent', node('idle-parent', USER)],
  ['active-child', node('active-child', 'idle-parent', true)],
])

test('active-only rows include only busy agents and retain idle ancestors as ghosts', () => {
  const rows = trayRows(map(), { activeOnly: true })
  assert.deepEqual(rows.map(row => row.node.id), ['active-root', 'idle-parent', 'active-child'])
  assert.equal(rows[0]!.ghost, false)
  assert.equal(rows[1]!.ghost, true, 'an idle ancestor remains only to preserve hierarchy')
  assert.equal(rows[2]!.ghost, false)
  assert.deepEqual(trayRows(map()).map(row => row.node.id),
    ['idle-root', 'active-root', 'idle-parent', 'active-child'],
    'turning the active-only filter off restores every live agent')
})

test('the shared agents tray exposes an active-only toggle', async t => {
  let picked: boolean | undefined
  const agents = map()
  const view = await mountView(<AgentTray map={agents} rows={trayRows(agents)}
    query="" onQuery={() => {}} archived={false} onArchived={() => {}}
    activeOnly={false} onActiveOnly={value => { picked = value }} onPick={() => {}} />,
  host => host)
  t.after(async () => { await view.unmount() })
  await flush()
  const toggle = view.el.querySelector('.tray-active') as HTMLButtonElement | null
  assert.ok(toggle, 'the shared tray renders the active-only filter control')
  assert.equal(toggle!.getAttribute('aria-pressed'), 'false')
  await inAct(() => toggle!.click())
  assert.equal(picked, true, 'turning the control on requests the active-only preference')
})

test('active-only preference is persisted as a strict boolean and defaults off', () => {
  assert.equal(DEFAULT_PREFERENCES.activeAgentsOnly, false)
  assert.deepEqual(preferencesPatch({ activeAgentsOnly: true }), { activeAgentsOnly: true })
  assert.deepEqual(preferencesPatch({ activeAgentsOnly: false }), { activeAgentsOnly: false })
  assert.throws(() => preferencesPatch({ activeAgentsOnly: 'yes' }), /Invalid preference/)
})
