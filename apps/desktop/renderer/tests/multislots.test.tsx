import test from 'node:test'
import assert from 'node:assert/strict'
import { mountView, inAct, flush } from './harness'
import { projectSlotState, slotBadgeText, slotHeaderText, slotLeadText, slotsFull, slotLinks } from '../src/canvas/slots'
import { SlotsView } from '../src/canvas/slotsdesk'
import { watchdogDescription } from '../src/canvas/watchdogdescription'
import type { Watchdog, OpResult } from '../src/types'
import type { CanvasNode } from '../src/canvas/shared'

const dog = (slots = 3) => ({ id: 'b/claim', owner: 'b', name: 'claim', kind: 'slot', target: 'build', slots,
  state: 'armed', fired: 0, once: true, spent: false, interval_s: 5, at: '2026-10-19T07:00:00Z', queued_at: '2026-10-19T07:00:00Z' } as Watchdog)
const lease = { project: 'build', agent: 'a', lease: 's-two', slot: 37, slots: 2, since: '2026-10-19T06:00:00Z' }
const node = { id: 'build', kind: 'project', state: 'live', children: [] } as unknown as CanvasNode

test('slot counts use capacity units while links remain one per lease', () => {
  const state = projectSlotState('build', 2, [lease], [dog()])
  assert.match(slotBadgeText(state)!, /^2\/2 held/)
  assert.match(slotHeaderText(state), /^slots 2\/2/)
  assert.equal(slotLeadText(state), '2 of 2 concurrency slots held')
  assert.equal(slotsFull(state), true)
  assert.equal(state.line[0].slots, 3)
  assert.equal(slotLinks([], [lease], () => true).length, 1)
  assert.equal(slotBadgeText(projectSlotState('build', 2, [{ ...lease, slots: undefined }], [])), '1/2 held')
})
test('slot descriptions distinguish waiting and holding multiple units', () => {
  const waiting = dog()
  assert.match(watchdogDescription(waiting, [waiting]).summary, /waiting for 3 slots/)
  const granted = { ...dog(2), lease: 's-two', spent: true, state: 'spent', fired: 1 }
  assert.match(watchdogDescription(granted, [], { state: 'held' }).summary, /holds 2 slots/)
  assert.match(watchdogDescription(granted, [], { state: 'ended', how: 'released' }).summary, /2 concurrency slots/)
  assert.doesNotMatch(watchdogDescription(granted, [], { state: 'ended', how: 'released' }).summary, /holds 2 slots/)
})
test('slot table has quantities for holders, waiting claims and ended leases', async t => {
  const state = projectSlotState('build', 3, [lease], [dog()])
  const answer = { project: 'build', slots: 3, held: 2, holders: [lease],
    line: [{ agent: 'b', dog: 'claim', position: 1, slots: 3 }], history: [{ ...lease, lease: 's-old', slots: 1, ended: '2026-10-19T07:00:00Z', how: 'released' }] }
  const view = await mountView(<SlotsView node={node} state={state} map={new Map([['build', node]])}
    op={async () => answer as unknown as OpResult} toast={() => {}} />, el => el)
  t.after(() => view.unmount())
  await inAct(async () => { await flush(3) })
  assert.ok(Array.from(view.el.querySelectorAll('thead th')).some(el => el.textContent === 'Slots'))
  assert.deepEqual(Array.from(view.el.querySelectorAll('.slot-quantity')).map(el => el.textContent), ['2', '3', '1'])
  assert.equal(view.el.querySelectorAll('[data-action="force-release"]').length, 1)
  assert.equal(view.el.textContent?.includes('37'), false, 'private slot ordinal is not a quantity')
})
