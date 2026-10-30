// retiredlisteners.test.tsx - A RETIRED AGENT'S LISTENERS ARE NOT IN A PROJECT'S
// LISTENER LISTS (docket project-listeners-list-shows-retired-agents-paus; USER
// 2026-10-30 08:37:43Z m401e6ff93d21, verbatim: "retired listeners should not
// show up in this list").
//
// Retiring an agent PAUSES its watchdogs ("its owner was archived") and a rehire
// re-arms them (engine runtime/watchdogs.rs pause_owned / resume_owned), so the
// dogs stay in the tree's watchdog list for good, and the listeners lists drew
// every one of them as a "paused" row: on a queue with hundreds of workers
// over its life, a long run of rows for agents that no longer exist. This holds
// the DISPLAY to the rule: a listener whose owner is not a live agent (retired
// and kept in the map, or retired and no longer in the tree at all) is not in the
// Mail tab's listeners folder, the Events tab, or the "is anyone listening?"
// answer; a LIVE agent's paused listener stays, and so does the user's own.
//
// Run:  cd apps/desktop/renderer && node tests/run.mjs retiredlisteners

import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { FakeServer, flush, inAct, installFetch, mountView } from './harness'
import { ProjectDesk } from '../src/canvas/projectdesk'
import { forgetDeskMemory } from '../src/canvas/desktabs'
import type { CanvasNode } from '../src/canvas/shared'
import type { OpResult, TreePayload, Watchdog } from '../src/types'

const noop = () => {}
const refs = { world: { org: 'org' }, onOpen: noop } as never

const agent = (id: string, state = 'live'): CanvasNode => ({
  id, title: id, state, tier: 'haiku', model_id: 'haiku', children: [], seat: 1, grant: 0, free: 0,
  scope: { tools: {}, add_dirs: [] },
} as unknown as CanvasNode)
const site = (scope: Record<string, unknown> = {}): CanvasNode => ({
  id: 'sync', title: 'sync', tier: 'project', kind: 'project', state: 'live', model_id: '',
  seat: 0, grant: 0, free: 0, scope: { tools: {}, add_dirs: [] },
  configured_scope: { tools: {}, add_dirs: [], event_listeners: true, ...scope },
  parent: 'boss', charter: 'A rendezvous.', children: [agent('sa'), agent('sc')],
  lineage: [], turns: [], audiences_held: [], mail_pending: 0, mail_held: 0,
  last_status: null, occupancy: 0, context_window: 0, busy: false, activity: null,
} as unknown as CanvasNode)

const dog = (kind: Watchdog['kind'], owner: string, name: string, extra: Partial<Watchdog> = {}): Watchdog =>
  ({ id: owner + '/' + name, owner, name, kind, target: 'sync', interval_s: 5, state: 'armed',
    at: '2026-10-19T07:00:00.000Z', fired: 0, once: false, spent: false, ...extra } as Watchdog)

/** sa and sc are live; ra is retired and still in the tree; rb is retired and gone from it */
const MAP_AGENTS = [agent('sa'), agent('sc'), agent('boss'), agent('ra', 'archived')]
const mailDogs = [
  dog('fair_queue', 'sa', 'mail-a'),
  dog('fair_queue', 'sc', 'mail-c', { state: 'paused' }),
  dog('fair_queue', 'ra', 'mail-ra', { state: 'paused' }),
  dog('fair_queue', 'rb', 'mail-rb', { state: 'paused' }),
]
const eventDogs = [
  dog('project_listener', 'sa', 'ready-a'),
  dog('project_listener', 'sc', 'ready-c', { state: 'paused' }),
  dog('project_listener', 'ra', 'ready-ra', { state: 'paused' }),
  dog('project_listener', 'rb', 'ready-rb', { state: 'paused' }),
  dog('listener_watch', 'boss', 'all-in', { count: 2 }),
  dog('listener_watch', 'ra', 'old-watch', { count: 3, state: 'paused' }),
]

function serve(t: TestContext) {
  const had = (globalThis as { fetch?: typeof fetch }).fetch
  installFetch(new FakeServer())
  t.after(() => { (globalThis as { fetch?: typeof fetch }).fetch = had })
}
async function desk(t: TestContext, node: CanvasNode, watchdogs: Watchdog[]) {
  serve(t)
  forgetDeskMemory()
  const tree = { slug: 'org', roots: [], watchdogs, slot_leases: [] } as unknown as TreePayload
  const view = await mountView(<ProjectDesk node={node} slug="org" tree={tree}
    map={new Map([[node.id, node], ...MAP_AGENTS.map(a => [a.id, a] as [string, CanvasNode])])}
    op={() => Promise.resolve({ project: 'sync', history: [], working: [], history_next: null, ack: false } as unknown as OpResult)}
    toast={noop} refs={refs} />, el => el)
  t.after(() => view.unmount())
  await flush(2)
  return view
}
const show = (el: Element, tab: string) => inAct(async () => {
  el.querySelector<HTMLButtonElement>(`.cc-tabs button[data-tab="${tab}"]`)!.click(); await flush(4)
})
const folder = (el: Element, name: string) => inAct(async () => {
  [...el.querySelectorAll<HTMLButtonElement>('.mail-folders > button')].find(b => b.textContent?.startsWith(name))!.click()
  await flush(3)
})
const agentsIn = (rows: Element[]) => rows.map(r => r.querySelector('[data-copy-agent-name]')?.getAttribute('data-copy-agent-name'))

test('the Mail tab\'s listeners folder lists live listeners, armed or paused, and no retired agent\'s', async (t) => {
  const view = await desk(t, site(), [...mailDogs, ...eventDogs])
  await show(view.el, 'inbox')
  await folder(view.el, 'listeners')
  const rows = [...view.el.querySelectorAll('.mail-listeners-table .mail-line tr.listener-row')]
  assert.deepEqual(agentsIn(rows), ['sa', 'sc'], 'sa (armed) and sc (live, paused); ra and rb are retired')
  assert.match(rows[1]?.textContent ?? '', /paused/, 'the live agent\'s paused listener is still there, as paused')
  assert.equal(view.el.querySelector('.mail-listeners-table')?.textContent?.includes('mail-ra'), false)
})

test('the Events tab lists live listeners and watches, and no retired agent\'s', async (t) => {
  const view = await desk(t, site(), [...mailDogs, ...eventDogs])
  await show(view.el, 'listeners')
  const text = view.el.querySelector('.project-listeners')?.textContent ?? ''
  assert.match(text, /ready-a/)
  assert.match(text, /ready-c/, 'a live agent\'s paused listener stays')
  assert.match(text, /all-in/, 'a live agent\'s watch stays')
  assert.doesNotMatch(text, /ready-ra|ready-rb/, 'no retired agent\'s listener')
  assert.doesNotMatch(text, /old-watch/, 'nor its watch')
})

test('a project whose only mail listeners are retired agents\' says nobody listens', async (t) => {
  const retiredOnly = mailDogs.filter(w => w.owner === 'ra' || w.owner === 'rb')
  const view = await desk(t, site(), retiredOnly)
  assert.ok(view.el.querySelector('.inbox-no-listeners'),
    'the message box warns that mail may not be read: paused rows of agents that no longer exist are not listeners')
  await show(view.el, 'inbox')
  await folder(view.el, 'listeners')
  assert.match(view.el.querySelector('.mail-listeners-table .mail-line td.slot-empty')?.textContent ?? '', /Nobody listens for sync's mail/)
})

test('control: a live agent\'s paused listener keeps the box quiet and the folder row', async (t) => {
  const view = await desk(t, site(), mailDogs.filter(w => w.owner === 'sc'))
  assert.equal(view.el.querySelector('.inbox-no-listeners'), null, 'a paused listener is attached; the engine says mail waits for it')
  await show(view.el, 'inbox')
  await folder(view.el, 'listeners')
  assert.deepEqual(agentsIn([...view.el.querySelectorAll('.mail-listeners-table .mail-line tr.listener-row')]), ['sc'])
})
