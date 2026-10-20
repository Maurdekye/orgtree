// listenersetting.test.tsx — a project's event-listeners SETTING on the
// desktop (Orgtree 4.4.0; docket
// `project-event-listeners-an-enable-setting-off-by`, user 2026-10-20
// 10:50Z, design approved by coordinator-opus 10:58Z).
//
// WHAT THIS FILE HOLDS THE CODE TO:
//   §1 the desk's Listeners tab (and so the card's Listeners shortcut,
//      which reads the same list) shows exactly while the project's
//      `event_listeners` setting is on: never from the retired
//      listeners_seen mark or from dogs alone, and with nobody listening
//      while it is on;
//   §2 a dog the setting disabled is unwired: no line on the canvas (a dog
//      its owner paused keeps its dimmed line); its chip and its detail say
//      why;
//   §3 the gear: an "Event listeners" switch, off by default; saving sends
//      one set_event_listeners; its hint says what off does and that agents
//      switch it on by registering a listener.
//
// Run:  cd apps/desktop/renderer && node tests/run.mjs listenersetting

import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { FakeServer, flush, inAct, installFetch, mountView } from './harness'
import { ProjectDesk, projectDeskTabs } from '../src/canvas/projectdesk'
import { forgetDeskMemory } from '../src/canvas/desktabs'
import { listenerLinks } from '../src/canvas/listeners'
import { WatchdogSatellite } from '../src/canvas/watchdogchip'
import { watchdogDescription } from '../src/canvas/watchdogdescription'
import { NodeConfig } from '../src/canvas/modals'
import type { CanvasNode, OpRequest, OpResult } from '../src/canvas/shared'
import type { TreePayload, Watchdog } from '../src/types'

const noop = () => {}
const refs = { world: { org: 'org' }, onOpen: noop } as never

function project(scope: Record<string, unknown> = {}, extra: Record<string, unknown> = {}): CanvasNode {
  return {
    id: 'sync', title: 'sync', tier: 'project', kind: 'project', state: 'live', model_id: '',
    seat: 0, grant: 0, free: 0, scope: { tools: {}, add_dirs: [] }, configured_scope: { tools: {}, add_dirs: [], ...scope },
    parent: 'boss', charter: 'A rendezvous.',
    children: [{ id: 'sa', title: 'sa', tier: 'haiku', state: 'live', busy: false, children: [] }],
    lineage: [], turns: [], audiences_held: [], mail_pending: 0, mail_held: 0,
    last_status: null, occupancy: 0, context_window: 0, busy: false, activity: null, ...extra,
  } as unknown as CanvasNode
}

const agentNode = (id: string): CanvasNode => ({
  id, title: id, tier: 'haiku', state: 'live', busy: false, children: [], seat: 1, grant: 0, free: 0,
  scope: { tools: {}, add_dirs: [] }, lineage: [], turns: [], audiences_held: [], last_status: null,
  occupancy: 0, context_window: 0, activity: null, parent: 'sync',
} as unknown as CanvasNode)

const dog = (kind: Watchdog['kind'], owner: string, name: string, extra: Partial<Watchdog> = {}): Watchdog =>
  ({ id: owner + '/' + name, owner, name, kind, target: 'sync', interval_s: 5, state: 'armed',
    at: '2026-10-20T10:00:00.000Z', fired: 0, once: false, spent: false, ...extra } as Watchdog)

const OFF_WHY = "project sync's event listeners were turned off by boss"
const dogs = [
  dog('project_listener', 'sa', 'ready-a'),
  dog('listener_watch', 'boss', 'all-in', { count: 2 }),
]

/* ─── §1 the tab follows the setting ─────────────────────────────────────── */

test('§1 the Listeners tab shows exactly while the setting is on, whatever the dogs or the old mark say', () => {
  const tabs = (nd: CanvasNode, ds: Watchdog[]) => projectDeskTabs(nd, new Map([[nd.id, nd]]), ds)
  assert.equal(tabs(project({}, { listeners_seen: true }), dogs).includes('listeners'), false,
    'off by default: neither the retired listeners_seen mark nor armed dogs show it')
  assert.equal(tabs(project({ event_listeners: false }), dogs).includes('listeners'), false, 'switched off: hidden')
  assert.equal(tabs(project({ event_listeners: true }), []).includes('listeners'), true, 'on: shown with nobody listening')
  assert.equal(tabs(project({ event_listeners: true }), dogs).at(-1), 'listeners', 'still the last tab')
})

function serve(t: TestContext) {
  const had = (globalThis as { fetch?: typeof fetch }).fetch
  installFetch(new FakeServer())
  const inner = globalThis.fetch
  globalThis.fetch = ((url: RequestInfo | URL, init?: RequestInit) => {
    if (new URL(String(url), 'http://x').pathname === '/api/app-settings/runtime')
      return Promise.resolve(new Response(JSON.stringify({ working_checkups_enabled: true }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }))
    return inner(url, init)
  }) as typeof fetch
  t.after(() => { (globalThis as { fetch?: typeof fetch }).fetch = had })
}

async function desk(t: TestContext, nd: CanvasNode, ds: Watchdog[]) {
  serve(t)
  forgetDeskMemory()
  const ops: OpRequest[] = []
  const tree = { slug: 'org', roots: [], watchdogs: ds, slot_leases: [] } as unknown as TreePayload
  const view = await mountView(<ProjectDesk node={nd} slug="org" tree={tree}
    map={new Map([[nd.id, nd], ...['sa', 'boss'].map(id => [id, agentNode(id)] as [string, CanvasNode])])}
    op={(b) => {
      ops.push(b)
      return Promise.resolve((b.op === 'listener_history' ? { project: 'sync', history: [] }
        : b.op === 'mail_queue_history' ? { project: 'sync', ack: false, line: [], history: [] }
          : { project: 'sync', listeners_armed: 0 }) as unknown as OpResult)
    }}
    toast={noop} refs={refs} />, (el) => el)
  t.after(() => view.unmount())
  await flush(2)
  return { view, ops }
}

test('§1 the desk: on with nobody listening shows the tab and its fire control', async (t) => {
  const on = await desk(t, project({ event_listeners: true }), [])
  const tab = on.view.el.querySelector<HTMLButtonElement>('.cc-tabs button[data-tab="listeners"]')
  assert.ok(tab, 'the tab, empty')
  await inAct(async () => { tab!.click(); await flush(3) })
  assert.ok(on.view.el.querySelector('.project-listeners button[data-action="fire-event"]'), 'the fire control on the tab')
})

test('§1 the desk: off hides the tab and the cards, whatever its dogs and the old mark', async (t) => {
  const off = await desk(t, project({}, { listeners_seen: true }), [
    dog('project_listener', 'sa', 'ready-a', { state: 'paused', disabled: OFF_WHY }),
    dog('listener_watch', 'boss', 'all-in', { count: 2, state: 'paused', disabled: OFF_WHY }),
  ])
  assert.equal(off.view.el.querySelector('.cc-tabs button[data-tab="listeners"]') === null, true, 'off: no tab')
  assert.equal(off.view.el.querySelector('.project-listeners-card') === null, true, 'no cyan card: nothing is armed')
})

/* ─── §2 a disabled dog is unwired ───────────────────────────────────────── */

test('§2 a dog the setting disabled draws no line; one its owner paused keeps its dimmed line', () => {
  const links = listenerLinks([
    dog('project_listener', 'sa', 'ready-a', { state: 'paused', disabled: OFF_WHY }),
    dog('project_listener', 'sb', 'ready-b', { state: 'paused' }),
    dog('listener_watch', 'boss', 'all-in', { count: 2, state: 'paused', disabled: OFF_WHY }),
    dog('project_listener', 'sc', 'ready-c'),
  ], (p) => p === 'sync')
  assert.deepEqual(links.map((l) => [l.owner, l.watch, l.paused]), [['sb', false, true], ['sc', false, false]],
    'the disabled listener and watch are unwired')
})

test('§2 its chip and its detail say it is disabled, and why', async (t) => {
  const off = dog('project_listener', 'sa', 'ready-a', { state: 'paused', disabled: OFF_WHY })
  const view = await mountView(<WatchdogSatellite dog={off} dogs={[off]} org="org" onOpen={noop} />, (el) => el)
  t.after(() => view.unmount())
  const chip = view.el.querySelector<HTMLButtonElement>('.wd-chip')!
  assert.equal(chip.classList.contains('disabled'), true, 'drawn disabled')
  assert.match(chip.getAttribute('title') ?? '', /disabled: project sync's event listeners were turned off by boss/)
  assert.match(watchdogDescription(off, [off]).summary,
    /^Disabled: project sync's event listeners were turned off by boss\. It listens for nothing until they are on again, then re-arms by itself\./)
  const own = dog('project_listener', 'sb', 'ready-b', { state: 'paused' })
  assert.doesNotMatch(watchdogDescription(own, [own]).summary, /Disabled/, 'an owner-paused dog is not disabled')
})

/* ─── §3 the gear ────────────────────────────────────────────────────────── */

const row = (label: string) => [...document.querySelectorAll<HTMLElement>('.set-row, .set-block')]
  .find((r) => r.querySelector('.set-label')?.textContent?.trim() === label)

async function gear(t: TestContext, nd: CanvasNode) {
  serve(t)
  const ops: OpRequest[] = []
  const view = await mountView(<NodeConfig node={nd} map={new Map([[nd.id, nd]])} tree={{ slug: 'org', roots: [] } as unknown as TreePayload}
    slug="org" op={async (b) => { ops.push(b); return {} as OpResult }} toast={noop} close={noop} />, (el) => el)
  t.after(() => view.unmount())
  await inAct(async () => { await flush(6) })
  return { view, ops }
}
const save = async () => {
  const b = [...document.querySelectorAll('button')].find((x) => x.textContent === 'save')!
  await inAct(async () => { b.click(); await flush(4) })
}

test('§3 the gear: an Event listeners switch, off by default; switching it on and saving sends one set_event_listeners', async (t) => {
  const { ops } = await gear(t, project())
  const sw = document.querySelector<HTMLInputElement>('input[aria-label="Event listeners"]')
  assert.ok(sw, 'an Event listeners switch')
  assert.equal(sw!.checked, false, 'off by default')
  const hint = row('Event listeners')?.textContent ?? ''
  assert.match(hint, /Listeners tab/, 'the hint says it controls the tab')
  assert.match(hint, /registering a listener/, 'and that agents switch it on by registering one')
  assert.match(hint, /Off disables every event listener and listener watch on the project/, 'and what off does')
  await inAct(() => { sw!.click() })
  await save()
  assert.deepEqual(ops, [{ op: 'set_event_listeners', node: 'sync', enabled: true }])
})

test('§3 a project whose setting is on shows it on; switching it off and saving sends enabled false, nothing else', async (t) => {
  const { ops } = await gear(t, project({ event_listeners: true }))
  const sw = document.querySelector<HTMLInputElement>('input[aria-label="Event listeners"]')!
  assert.equal(sw.checked, true)
  await save()
  assert.deepEqual(ops, [], 'an untouched switch sends nothing')
  await inAct(() => { sw.click() })
  await save()
  assert.deepEqual(ops, [{ op: 'set_event_listeners', node: 'sync', enabled: false }])
})
