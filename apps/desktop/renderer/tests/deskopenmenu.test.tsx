import './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { agentMenuEntries } from '../src/canvas/agentmenu'
import type { AgentMenuHandlers } from '../src/canvas/agentmenu'
import type { CanvasNode } from '../src/canvas/shared'
import type { MenuEntry } from '../src/canvas/contextmenu'

const noop = () => {}
const node = (project: boolean) => ({ id: 'synthetic', state: 'live', tier: project ? 'project' : 'sol',
  kind: project ? 'project' : undefined, children: [] } as unknown as CanvasNode)
const open = (entries: MenuEntry[]) => {
  const entry = entries.find(e => e !== 'sep' && e.label === 'Open')
  assert.equal(!!entry && entry !== 'sep', true)
  return entry !== 'sep' ? entry!.children! : []
}
const labels = (entries: MenuEntry[]) => entries.map(e => e === 'sep' ? 'sep' : e.label)

for (const project of [false, true]) for (const placed of [false, true]) {
  test(`${project ? 'project' : 'agent'} Open keeps exact desk labels/order and ${placed ? 'existing-window' : 'new-window'} actions`, () => {
    const calls: string[] = []
    const handlers: AgentMenuHandlers = {
      onInbox: noop, onSettings: noop,
      onOpenTemporary: () => calls.push('temporary'), onPin: () => calls.push('pin'),
      onShowPin: () => calls.push('show-pin'), onPopout: () => calls.push('popout'),
      onShowWindow: () => calls.push('show-window'), onTeam: () => calls.push('team'),
    }
    const entries = open(agentMenuEntries(node(project), handlers, { pinned: placed, detached: placed }))
    assert.deepEqual(labels(entries.slice(0, 4)), ['Desk', 'Desk as a pinned window', 'Desk in a separate window', 'sep'])
    for (const entry of entries.slice(0, 3)) { assert.notEqual(entry, 'sep'); if (entry !== 'sep') entry.onSelect() }
    assert.deepEqual(calls, ['temporary', placed ? 'show-pin' : 'pin', placed && !project ? 'show-window' : 'popout'])
    assert.equal(labels(entries).indexOf('Team') > 3, true, 'Team remains below the desk entries')
  })
}

test('unsupported desk actions stay absent', () => {
  for (const project of [false, true]) {
    const entries = open(agentMenuEntries(node(project), { onInbox: noop, onSettings: noop, onTeam: noop }))
    assert.equal(labels(entries).some(label => label.startsWith('Desk')), false)
  }
})
