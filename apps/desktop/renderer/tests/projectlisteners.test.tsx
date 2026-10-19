// projectlisteners.test.tsx — a project's EVENT LISTENERS on the desktop
// (Orgtree 4.4.0; docket `project-event-listeners-sync-monitor-watchdogs-l`,
// user 2026-10-19 07:40Z + 07:41Z: cyan listener lines completing the CMY
// triplet, cyan header/near-zoom cards, a magenta mail-queue card, and a
// "listeners" desk tab).
//
// WHAT THIS FILE HOLDS THE CODE TO:
//   §1 the listener state and cards from the tree's watchdogs: armed dogs
//      count (paused do not), a dark count card, one bright x/y card per
//      armed watch, nothing when nobody listens;
//   §2 the canvas lines (listener and watch, paused dimmed) and the
//      mail-queue card: waiting count, the ack-mode in-flight count only
//      in ack mode, nothing when the queue is empty;
//   §3 the two kinds' own words in the watchdog detail description,
//      including the fire-time tool calls;
//   §4 the desk: no listeners tab and no cards without any dog; with dogs,
//      the header cards, the tab's badge, its rows (agent, dog, mode,
//      count, fire actions) and the fire control sending fire_project_event;
//   §5 the near-zoom card's listener and queue badges.
//   §6 the magenta mail-listeners card (fair-queue count, user 2026-10-19
//      17:11Z): beside the queue card on desk + near card, opens inbox.
//
// Run:  cd apps/desktop/renderer && node tests/run.mjs projectlisteners

import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { FakeServer, flush, inAct, installFetch, mountView } from './harness'
import { ProjectDesk } from '../src/canvas/projectdesk'
import { ProjectSquare } from '../src/canvas/projectcard'
import {
  fireActionTools, listenerCards, listenerLinks, mailListenerCard, projectListenerState, queueAckMode, queueCard,
} from '../src/canvas/listeners'
import { watchdogDescription } from '../src/canvas/watchdogdescription'
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

const dog = (kind: Watchdog['kind'], owner: string, name: string, extra: Partial<Watchdog> = {}): Watchdog =>
  ({ id: owner + '/' + name, owner, name, kind, target: 'sync', interval_s: 5, state: 'armed',
    at: '2026-10-19T07:00:00.000Z', fired: 0, once: true, spent: false, ...extra } as Watchdog)

// two armed listeners, one paused, one on another project; one armed watch
// carrying the sync's fire action, one paused
const dogs = [
  dog('project_listener', 'sa', 'ready-a'),
  dog('project_listener', 'sb', 'ready-b', { once: false }),
  dog('project_listener', 'sc', 'ready-c', { state: 'paused' }),
  { ...dog('project_listener', 'sx', 'elsewhere'), target: 'other' },
  dog('listener_watch', 'boss', 'all-in', { count: 2,
    fire_actions: [{ tool: 'orgtree_project', args: { action: 'fire_event', name: 'sync' } }] }),
  dog('listener_watch', 'boss', 'later', { count: 3, state: 'paused' }),
  dog('project_listener', 'gone', 'spent', { state: 'spent', spent: true }),
  // the mail listeners (§6): two armed fair-queue watchers, one paused
  dog('fair_queue', 'sa', 'mail-a', { once: false }),
  dog('fair_queue', 'sb', 'mail-b', { once: false }),
  dog('fair_queue', 'sc', 'mail-c', { state: 'paused', once: false }),
]

/* ─── §1 the state and the cards ─────────────────────────────────────────── */

test('§1 armed listeners count (paused, spent and other projects do not); cards read the same', () => {
  const s = projectListenerState('sync', dogs)
  assert.deepEqual(s.armed.map((w) => w.owner), ['sa', 'sb'], 'only the armed listeners on this project')
  assert.deepEqual(s.armedWatches.map((w) => w.name), ['all-in'], 'the paused watch is out')
  assert.equal(s.listeners.length, 3, 'the tab lists the paused listener too')
  const cards = listenerCards('sync', s)
  assert.equal(cards.length, 1, 'one card for the one armed watch')
  assert.equal(cards[0].text, 'listeners 2/2')
  assert.equal(cards[0].bright, true, 'a watch card is the bright cyan')
  assert.match(cards[0].title, /boss's listener watch "all-in" fires when 2 event listeners are armed on project sync/)
  // no watch: the dark count card; nobody listening: no card
  const bare = projectListenerState('sync', dogs.filter((w) => w.kind === 'project_listener'))
  const dark = listenerCards('sync', bare)
  assert.deepEqual(dark.map((c) => [c.text, c.bright]), [['listeners 2', false]], 'darker cyan without a watch')
  assert.match(dark[0].title, /2 event listeners armed on project sync: sa, sb/)
  assert.deepEqual(listenerCards('sync', projectListenerState('sync', [])), [], 'nothing when nobody listens')
  // two watches: one card each
  const two = listenerCards('sync', projectListenerState('sync', [
    dogs[0], dogs[4], dog('listener_watch', 'boss2', 'three', { count: 3, once: false }),
  ]))
  assert.deepEqual(two.map((c) => c.text), ['listeners 1/2', 'listeners 1/3'], 'one cyan card per watch, count over threshold')
})

/* ─── §2 the lines and the queue card ────────────────────────────────────── */

test('§2 one cyan line per listener and watch on canvas; paused dimmed; spent and off-canvas nothing', () => {
  const links = listenerLinks(dogs, (p) => p === 'sync')
  assert.deepEqual(links.map((l) => [l.owner, l.watch, l.paused]), [
    ['sa', false, false], ['sb', false, false], ['sc', false, true], ['boss', true, false], ['boss', true, true],
  ], 'listeners then watches, the paused marked')
  assert.equal(new Set(links.map((l) => l.key)).size, links.length, 'unique keys')
  assert.deepEqual(listenerLinks(dogs, () => false), [], 'no project on canvas, no lines')
})

test('§2 the queue card counts waiting mail and, only in ack mode, the in-flight jobs', () => {
  assert.equal(queueAckMode(project({ mail_queue: 'ack' })), true)
  assert.equal(queueAckMode(project()), false, 'round-robin by default')
  assert.equal(queueCard('sync', 0, 0, false), null, 'an empty queue shows nothing')
  assert.equal(queueCard('sync', 0, 0, true), null)
  const plain = queueCard('sync', 3, 2, false)!
  assert.equal(plain.text, 'mail queue 3', 'no in-flight outside ack mode')
  assert.match(plain.title, /3 mails waiting in project sync's mail queue/)
  const ack = queueCard('sync', 3, 2, true)!
  assert.equal(ack.text, 'mail queue 3 waiting · 2 in flight')
  assert.match(ack.title, /2 handed out awaiting an ack/)
  const heldOnly = queueCard('sync', 0, 1, true)!
  assert.equal(heldOnly.text, 'mail queue 0 waiting · 1 in flight', 'in-flight alone still shows in ack mode')
  assert.equal(queueCard('sync', 0, 1, false), null, 'and never outside it')
  assert.deepEqual(fireActionTools(dogs[4]), ['orgtree_project'])
  assert.deepEqual(fireActionTools(dogs[0]), [])
})

/* ─── §3 the detail words ────────────────────────────────────────────────── */

test('§3 both kinds describe themselves, with the fire-time tool calls', () => {
  const l = watchdogDescription(dogs[1], dogs)
  assert.equal(l.type, 'Project event listener')
  assert.match(l.summary, /Listens on project sync and wakes sb each time its event is fired/)
  assert.match(l.cadence, /no polling interval/)
  const w = watchdogDescription(dogs[4], dogs)
  assert.equal(w.type, 'Project listener watch')
  assert.match(w.summary, /fires when their count reaches 2|when their count reaches 2/)
  assert.match(w.summary, /also runs orgtree_project as boss/)
  assert.match(w.fireMode, /armed listener count reaches its count/)
  assert.equal(l.polling, false, 'pushed kinds never claim a next check')
  assert.equal(w.polling, false)
})

/* ─── §4 the desk ────────────────────────────────────────────────────────── */

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

const agentNode = (id: string): CanvasNode => ({
  id, state: 'live', tier: 'haiku', model_id: 'haiku', children: [], seat: 1, grant: 0, free: 0,
  scope: { tools: {}, add_dirs: [] },
} as unknown as CanvasNode)

async function desk(t: TestContext, nd: CanvasNode, withDogs = true) {
  serve(t)
  const ops: OpRequest[] = []
  const tree = { slug: 'org', roots: [], watchdogs: withDogs ? dogs : [], slot_leases: [] } as unknown as TreePayload
  const view = await mountView(<ProjectDesk node={nd} slug="org" tree={tree}
    map={new Map([[nd.id, nd], ...['sa', 'sb', 'sc', 'boss'].map(id => [id, agentNode(id)] as [string, CanvasNode])])}
    op={(b) => { ops.push(b); return Promise.resolve({ project: 'sync', listeners_armed: 2 } as unknown as OpResult) }}
    toast={noop} refs={refs} />, (el) => el)
  t.after(() => view.unmount())
  await flush(2)
  return { view, ops }
}

test('§4 no listeners tab and no cards while nobody listens', async (t) => {
  const { view } = await desk(t, project(), false)
  assert.equal(Boolean(view.el.querySelector('.cc-tabs button[data-tab="listeners"]')), false, 'no listeners tab')
  assert.equal(Boolean(view.el.querySelector('.project-listeners-card')), false, 'no cyan card')
  assert.equal(Boolean(view.el.querySelector('.project-queue-card')), false, 'no queue card')
})

test('§4 the header cards, the tab, its rows and the fire control', async (t) => {
  const nd = project({ mail_queue: 'ack' }, { mail_pending: 3, mail_held: 1 })
  const { view, ops } = await desk(t, nd)
  const cyan = view.el.querySelector<HTMLButtonElement>('.project-listeners-card')
  assert.equal(cyan?.textContent, 'listeners 2/2', 'the bright watch card in the header')
  assert.equal(cyan?.classList.contains('bright'), true)
  const queue = view.el.querySelector<HTMLButtonElement>('.project-queue-card')
  assert.equal(queue?.textContent, 'mail queue 3 waiting · 1 in flight', 'the magenta queue card beside it')
  const tab = view.el.querySelector<HTMLButtonElement>('.cc-tabs button[data-tab="listeners"]')
  assert.ok(tab, 'the listeners tab')
  assert.match(tab!.textContent ?? '', /^listeners 2$/, 'its badge counts the armed listeners')
  await inAct(async () => { cyan!.click(); await flush(3) })
  assert.equal(view.el.querySelector('.cc-tabs button[data-tab="listeners"]')?.classList.contains('on'), true,
    'the card opens the listeners tab')
  const panel = view.el.querySelector('.project-listeners')!
  assert.ok(panel, 'the listeners panel')
  const sections = [...panel.querySelectorAll('h4')].map((h) => h.textContent)
  assert.deepEqual(sections, ['Event listeners', 'Listener watches'])
  const rows = [...panel.querySelectorAll('.listener-row')].map((r) => r.textContent ?? '')
  assert.equal(rows.length, 5, 'three listeners and two watches, paused included')
  assert.match(rows[0], /ready-a/); assert.match(rows[0], /one-shot/)
  assert.match(rows[1], /continuous/)
  assert.match(rows[3], /all-in/); assert.match(rows[3], /2\/2/); assert.match(rows[3], /runs orgtree_project on fire/)
  // the fire control sends the op, message first as written
  const input = panel.querySelector<HTMLInputElement>('.listener-fire input')!
  Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(input, 'go now')
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await inAct(async () => { panel.querySelector<HTMLButtonElement>('button[data-action="fire-event"]')!.click(); await flush(3) })
  assert.deepEqual(ops.filter((o) => o.op === 'fire_project_event'),
    [{ op: 'fire_project_event', node: 'sync', body: 'go now' }], 'firing from the desk runs the same op as the agent tool')
})

/* ─── §5 the near-zoom card ──────────────────────────────────────────────── */

test('§5 the near card carries the listener and queue badges', async (t) => {
  installFetch(new FakeServer())
  const nd = project({ mail_queue: 'ack' }, { mail_pending: 3, mail_held: 1 })
  const tree = { slug: 'org', roots: [], watchdogs: dogs, slot_leases: [] } as unknown as TreePayload
  const view = await mountView(
    <ProjectSquare node={nd} pos={{ x: 0, y: 0 }} lod="norm" tree={tree}
      map={new Map([[nd.id, nd]])} dragging={false} isDrop={false}
      op={() => Promise.resolve({} as OpResult)} slug="org" toast={noop} zoom={1}
      hire={{ tiers: [] } as never} seats={{}} onHire={noop} onNewProject={noop} onInbox={noop}
      onDragStart={noop} onDragMove={noop} onDragEnd={noop} onDragCancel={noop} />, (el) => el)
  t.after(() => view.unmount())
  const badges = [...view.el.querySelectorAll('.project-listeners-badge')].map((b) => b.textContent)
  assert.deepEqual(badges, ['listeners 2/2'], 'the near card reads the same watch card')
  assert.equal(view.el.querySelector('.project-listeners-badge')?.classList.contains('bright'), true)
  assert.match(view.el.querySelector('.project-listeners-badge')?.getAttribute('title') ?? '', /listener watch "all-in"/,
    'its tooltip says what the card means')
  assert.equal(view.el.querySelector('.project-queue-badge')?.textContent, 'mail queue 3 waiting · 1 in flight')
  const activity = view.el.querySelector('.project-activity')
  assert.ok(activity, 'the activity count on the near card')
  assert.equal(activity!.classList.contains('chip'), false,
    'the x/y count is plain text now, no chip box (user 2026-10-19 17:22Z)')
  assert.match(activity!.querySelector('.project-counts')?.textContent ?? '', /^\d+\/\d+$/, 'the bold x/y count')
  assert.equal(view.el.querySelector('.project-maillisteners-badge')?.textContent, 'mail listeners 2',
    'the near card carries the magenta mail-listener badge beside the queue badge')
})

/* ─── §6 the mail listeners card (user 2026-10-19 17:11-17:12Z) ─────────── */

test('§6 the mail-listener card counts armed fair-queue watchers only, and sits beside the queue card', () => {
  const card = mailListenerCard('sync', dogs)!
  assert.equal(card.text, 'mail listeners 2', 'armed fair-queue dogs; the paused one takes no mail')
  assert.match(card.title, /2 mail listeners \(fair_queue\) armed on project sync: sa, sb/)
  assert.equal(mailListenerCard('sync', dogs.filter((w) => w.kind !== 'fair_queue')), null,
    'no card while nobody listens for mail')
  assert.equal(mailListenerCard('other', dogs), null, 'another project\'s listeners do not count')
})

test('§6 the desk header carries the mail-listeners card beside the queue card, and clicking it opens the inbox tab', async (t) => {
  const nd = project({ mail_queue: 'ack' }, { mail_pending: 3, mail_held: 1 })
  const { view } = await desk(t, nd)
  const listeners = view.el.querySelector<HTMLButtonElement>('.project-maillisteners-card')
  assert.equal(listeners?.textContent, 'mail listeners 2')
  assert.equal(view.el.querySelector('.project-queue-card')?.textContent, 'mail queue 3 waiting · 1 in flight',
    'the queue card stays its own card beside it')
  await inAct(async () => { listeners!.click(); await flush(3) })
  assert.equal(view.el.querySelector('.cc-tabs button[data-tab="inbox"]')?.classList.contains('on'), true,
    'clicking the mail-listeners card opens the inbox tab (user 2026-10-19 17:12Z)')
})

test('§6 no mail-listeners card without a fair-queue watcher', async (t) => {
  const { view } = await desk(t, project(), false)
  assert.equal(Boolean(view.el.querySelector('.project-maillisteners-card')), false)
})
