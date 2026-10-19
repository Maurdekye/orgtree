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
//   §7 the inbox's listeners folder (user 2026-10-19 19:05Z-19:33Z): the mail
//      card opens inbox › listeners: the project's mail listeners in the
//      engine's delivery order, as the slots view's table, with live
//      Waited/Worked times (Worked and the held mail only in ack mode).
//
// Run:  cd apps/desktop/renderer && node tests/run.mjs projectlisteners

import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { advance, FakeServer, flush, inAct, installFetch, mountView, realClock, useFakeClock } from './harness'
import { ProjectDesk } from '../src/canvas/projectdesk'
import { ProjectSquare } from '../src/canvas/projectcard'
import {
  fireActionTools, listenerCards, listenerLinks, mailListenerState, mailQueueCard, projectListenerState, queueAckMode,
} from '../src/canvas/listeners'
import { MailListenersView, mailListenerRows } from '../src/canvas/maillisteners'
import { slotTimeStyle } from '../src/canvas/slottime'
import { watchdogDescription } from '../src/canvas/watchdogdescription'
import type { CanvasNode, MailRow, OpRequest, OpResult } from '../src/canvas/shared'
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

test('§2 the merged mail card counts listeners, waiting mail and, only in ack mode, the in-flight jobs (user 2026-10-19 18:17Z)', () => {
  assert.equal(queueAckMode(project({ mail_queue: 'ack' })), true)
  assert.equal(queueAckMode(project()), false, 'round-robin by default')
  assert.equal(mailQueueCard('sync', 0, 0, false, []), null, 'nothing waiting and nobody listening shows nothing')
  assert.equal(mailQueueCard('sync', 0, 0, true, []), null)
  const plain = mailQueueCard('sync', 3, 2, false, [])!
  assert.equal(plain.text, "3 q'd", 'the short user wording; no in-flight outside ack mode')
  assert.match(plain.title, /3 mails waiting in project sync's mail queue/)
  const ack = mailQueueCard('sync', 3, 2, true, [])!
  assert.equal(ack.text, "3 q'd · 2 in flight")
  assert.match(ack.title, /2 handed out awaiting an ack/)
  const heldOnly = mailQueueCard('sync', 0, 1, true, [])!
  assert.equal(heldOnly.text, '1 in flight', 'zero parts are left out; in-flight alone still shows in ack mode')
  assert.equal(mailQueueCard('sync', 0, 1, false, []), null, 'and never outside it')
  const merged = mailQueueCard('sync', 3, 1, true, dogs)!
  assert.equal(merged.text, "2 listeners · 3 q'd · 1 in flight", 'one card: listeners, queue, in flight')
  assert.match(merged.title, /2 mail listeners \(fair_queue\) armed on project sync: sa, sb/)
  assert.match(merged.title, /3 mails waiting in project sync's ack queue and 1 handed out awaiting an ack/)
  assert.equal(mailQueueCard('sync', 0, 0, false, dogs)!.text, '2 listeners', 'listeners alone still show')
  assert.equal(mailQueueCard('other', 0, 0, false, dogs), null, 'another project\'s listeners do not count')
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
  assert.equal(queue?.textContent, "2 listeners · 3 q'd · 1 in flight", 'the one merged magenta mail card beside it')
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
  assert.equal(view.el.querySelector('.project-queue-badge')?.textContent, "2 listeners · 3 q'd · 1 in flight")
  const activity = view.el.querySelector('.project-activity')
  assert.ok(activity, 'the activity count on the near card')
  assert.equal(activity!.classList.contains('chip'), false,
    'the x/y count is plain text now, no chip box (user 2026-10-19 17:22Z)')
  assert.match(activity!.querySelector('.project-counts')?.textContent ?? '', /^\d+\/\d+$/, 'the bold x/y count')
  assert.equal(view.el.querySelector('.project-maillisteners-badge'), null,
    'one merged badge now, no separate mail-listeners badge (user 2026-10-19 18:17Z)')
})

/* ─── §6 the merged mail card (user 2026-10-19 18:17Z) ─────────────────── */

test('§6 the merged card counts armed fair-queue watchers only', () => {
  const card = mailQueueCard('sync', 0, 0, false, dogs)!
  assert.equal(card.text, '2 listeners', 'armed fair-queue dogs; the paused one takes no mail')
  assert.match(card.title, /2 mail listeners \(fair_queue\) armed on project sync: sa, sb/)
  assert.equal(mailQueueCard('sync', 0, 0, false, dogs.filter((w) => w.kind !== 'fair_queue')), null,
    'no card while nobody listens and nothing waits')
})

test('§6 the desk header carries ONE merged mail card, and clicking it opens the inbox tab', async (t) => {
  const nd = project({ mail_queue: 'ack' }, { mail_pending: 3, mail_held: 1 })
  const { view } = await desk(t, nd)
  const card = view.el.querySelector<HTMLButtonElement>('.project-queue-card')
  assert.equal(card?.textContent, "2 listeners · 3 q'd · 1 in flight")
  assert.equal(view.el.querySelector('.project-maillisteners-card'), null, 'no separate mail-listeners card')
  await inAct(async () => { card!.click(); await flush(3) })
  assert.equal(view.el.querySelector('.cc-tabs button[data-tab="inbox"]')?.classList.contains('on'), true,
    'clicking the merged card opens the inbox tab (user 2026-10-19 17:12Z, merged 18:17Z)')
})

test('§6 no mail card without a watcher, waiting mail or in-flight job', async (t) => {
  const { view } = await desk(t, project(), false)
  assert.equal(Boolean(view.el.querySelector('.project-queue-card')), false)
})

/* ─── §7 the inbox's listeners folder (user 2026-10-19 19:05Z-19:33Z) ───── */

/** the project's mailbox as the inbox polls it: a job handed to sa at 08:00
 *  and not yet acked; one handed to sb at 07:32 and acked at 07:40 */
function serveInbox(t: TestContext) {
  const inner = globalThis.fetch
  globalThis.fetch = ((url: RequestInfo | URL, init?: RequestInit) => {
    if (new URL(String(url), 'http://x').pathname === '/api/orgs/org/nodes/sync/inbox')
      return Promise.resolve(new Response(JSON.stringify({ pending: [], sent: [], delivered: [
        { id: 'm1', from: 'boss', kind: 'message', body: 'build it\nall of it', at: '2026-10-19T07:59:00.000Z',
          queue: { held_by: 'sa', ack: true, held_at: '2026-10-19T08:00:00.000Z' } },
        { id: 'm2', from: 'boss', kind: 'message', body: 'test it', at: '2026-10-19T07:30:00.000Z',
          queue: { held_by: 'sb', ack: true, held_at: '2026-10-19T07:32:00.000Z', acked_at: '2026-10-19T07:40:00.000Z' } },
      ] }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    return inner(url, init)
  }) as typeof fetch
  t.after(() => { globalThis.fetch = inner })
}
const folders = (el: Element) => [...el.querySelectorAll('.mail-folders button')]
  .map((b) => (b.textContent ?? '').replace(/\s+/g, ' ').trim())
const openFolder = (el: Element) => (el.querySelector('.mail-folders button.on')?.textContent ?? '').replace(/\s+\d+$/, '').trim()
const tabOn = (el: Element, tab: string) => el.querySelector(`.cc-tabs button[data-tab="${tab}"]`)?.classList.contains('on')
const showTab = (el: Element, tab: string) => inAct(async () => {
  el.querySelector<HTMLButtonElement>(`.cc-tabs button[data-tab="${tab}"]`)!.click(); await flush(4)
})
const clickFolder = (el: Element, name: string) => inAct(async () => {
  [...el.querySelectorAll<HTMLButtonElement>('.mail-folders button')].find((b) => b.textContent?.startsWith(name))!.click()
  await flush(3)
})
const clickCard = (el: Element) => inAct(async () => {
  el.querySelector<HTMLButtonElement>('.project-queue-card')!.click(); await flush(6)
})
const headers = (el: Element) => [...el.querySelectorAll('.mail-listeners-table thead th')].map((h) => h.textContent)
const tableRows = (el: Element) => [...el.querySelectorAll<HTMLTableRowElement>('.mail-listeners-table tbody tr.listener-row')]
const cells = (row: Element) => [...row.children].map((c) => (c.textContent ?? '').replace(/\s+/g, ' ').trim())

test('§7 the mail card opens the inbox on a new listeners folder after inbox and sent', async (t) => {
  const nd = project({ mail_queue: 'ack' }, { mail_pending: 3, mail_held: 1 })
  const { view } = await desk(t, nd)
  serveInbox(t)
  await clickCard(view.el)
  assert.equal(tabOn(view.el, 'inbox'), true, 'the inbox tab')
  assert.deepEqual(folders(view.el), ['inbox 3', 'sent', 'listeners 2'], 'a third folder, its badge counting the armed mail listeners')
  assert.equal(openFolder(view.el), 'listeners', 'opened on the listeners folder')
  assert.equal(tabOn(view.el, 'listeners'), false, 'not the desk-level event listeners tab, which stays as it is')
  assert.ok(view.el.querySelector('.cc-tabs button[data-tab="listeners"]'), 'that tab is still there')
  assert.equal(view.el.querySelector('.project-listeners'), null, 'the event listeners panel is not drawn here')
})

test("§7 one aligned table, values only, as the slots view; Worked and Mail only in ack mode (user 19:28Z, 19:29:12Z, 19:33Z)", async (t) => {
  const ackDesk = await desk(t, project({ mail_queue: 'ack' }, { mail_pending: 3, mail_held: 1 }))
  serveInbox(t)
  await clickCard(ackDesk.view.el)
  assert.deepEqual(headers(ackDesk.view.el), ['Position', 'Agent', 'Waited', 'Worked', 'Mail', 'Handed', 'Watchdog'])
  const [first] = tableRows(ackDesk.view.el)
  const c = cells(first!)
  assert.equal(c[0], '1st', 'the place in the order, as the slots line')
  assert.equal(first!.querySelector('.slot-agent [data-copy-agent-name]')?.getAttribute('data-copy-agent-name'), 'sb',
    'the agent, as a link with its model card')
  assert.match(c[2]!, /^\d+(s|m|h \d+m)$/, 'Waited: a time and nothing else')
  assert.equal(c[3], '8m', "Worked: sb's last job, handed 07:32 and acked 07:40")
  assert.equal(c[4], '', 'no job held')
  assert.equal(c[5], '0', "Handed: the watchdog's engine count, a bare number")
  assert.equal(c[6], 'mail-b')
  const rr = await desk(t, project({}, { mail_pending: 3 }))
  await clickCard(rr.view.el)
  assert.deepEqual(headers(rr.view.el), ['Position', 'Agent', 'Waited', 'Handed', 'Watchdog'],
    'round robin: no Worked and no Mail column (user 19:29:12Z)')
})

test("§7 the order is the engine's pick: never woken first, then least recently woken, then the oldest dog; ack holders after the free, the rest last", () => {
  const fq = (owner: string, extra: Partial<Watchdog> = {}) => dog('fair_queue', owner, 'mail-' + owner, { once: false, ...extra })
  const listeners = [
    fq('sa', { last_fired: '2026-10-19T09:00:00.000Z' }),
    fq('sb', { at: '2026-10-19T06:00:00.000Z' }),
    fq('sc', { state: 'paused' }),
    fq('sd'),
    fq('se', { last_fired: '2026-10-19T08:00:00.000Z' }),
  ]
  const map = new Map(['sa', 'sb', 'sc', 'sd', 'se'].map((id) => [id, agentNode(id)] as [string, CanvasNode]))
  const st = mailListenerState('sync', listeners)
  assert.deepEqual(mailListenerRows(st, map, [], false).map((r) => [r.dog.owner, r.position, r.out]),
    [['sb', 1, null], ['sd', 2, null], ['se', 3, null], ['sa', 4, null], ['sc', null, 'paused']],
    'round robin: the never woken (older dog first), then by last hand-out; a paused dog takes none')
  const jobs = [{ id: 'm1', from: 'boss', kind: 'message', body: 'job', at: '2026-10-19T07:59:00.000Z',
    queue: { held_by: 'se', ack: true, held_at: '2026-10-19T08:00:00.000Z' } }] as MailRow[]
  const halted = new Map(map)
  halted.set('sd', { ...agentNode('sd'), halt: { phase: 'halted', requested_at: '2026-10-19T08:30:00.000Z', by: 'user' } } as CanvasNode)
  assert.deepEqual(mailListenerRows(st, halted, jobs, true).map((r) => [r.dog.owner, r.position, r.out]),
    [['sb', 1, null], ['sa', 2, null], ['se', null, 'holding'], ['sc', null, 'paused'], ['sd', null, 'halted']],
    'ack mode: a holder and a halted agent are handed nothing; holders follow the free listeners')
})

test('§7 a holder: a marked row, its Worked counts up, its last wait ended at the hand-out, and its mail opens in the inbox (user 19:28Z-19:30Z)', async (t) => {
  const nd = project({ mail_queue: 'ack' }, { mail_pending: 3, mail_held: 1 })
  const { view } = await desk(t, nd)
  serveInbox(t)
  await clickCard(view.el)
  const row = tableRows(view.el).find((r) => r.querySelector('[data-copy-agent-name="sa"]'))!
  assert.ok(row.classList.contains('holding'), 'the holder row is marked')
  const c = cells(row)
  assert.equal(c[0], '', 'a holder has no place in the order until it acks')
  assert.equal(c[2], '1h 0m', 'its last wait: armed 07:00, handed its job 08:00')
  assert.equal(row.querySelector('.slot-wait .slot-time')?.classList.contains('live'), false, 'that wait is over')
  assert.ok(row.querySelector('.slot-held .slot-time.live'), 'its work on the job is counting up')
  const link = row.querySelector<HTMLButtonElement>('.listener-mail-link')!
  assert.equal(link.textContent, 'build it', "the job's first line")
  await inAct(async () => { link.click(); await flush(6) })
  assert.equal(openFolder(view.el), 'inbox', 'the link opens the inbox folder')
  assert.match(view.el.querySelector('.mailrow.on')?.textContent ?? '', /build it/, 'with that mail selected')
})

test('§7 open times count up with the shared second clock, in the shared slot time colours', async (t) => {
  useFakeClock()
  t.after(() => realClock())
  const at = (seconds: number) => new Date(Date.now() - seconds * 1000).toISOString()
  const listeners = [dog('fair_queue', 'sa', 'mail-a', { once: false, at: at(3600) }),
    dog('fair_queue', 'sb', 'mail-b', { once: false, at: at(30) })]
  const jobs = [{ id: 'm1', from: 'boss', kind: 'message', body: 'job', at: at(10),
    queue: { held_by: 'sa', ack: true, held_at: at(5) } }] as MailRow[]
  const map = new Map(['sa', 'sb'].map((id) => [id, agentNode(id)] as [string, CanvasNode]))
  const view = await mountView(<MailListenersView node={project({ mail_queue: 'ack' })} state={mailListenerState('sync', listeners)}
    map={map} rows={jobs} ack />, (el) => el)
  t.after(() => view.unmount())
  await inAct(() => flush(2))
  const live = () => tableRows(view.el).map((r) => r.querySelector('.slot-time.live')?.textContent)
  assert.deepEqual(live(), ['30s', '5s'], "sb is waiting (1st), sa works on its job")
  await advance(1000)
  assert.deepEqual(live(), ['31s', '6s'], 'both count up together')
  const sbWait = tableRows(view.el)[0]!.querySelector<HTMLElement>('.slot-time.live')!
  const norm = (c: string) => { const i = document.createElement('i'); i.style.color = c; return i.style.color }
  assert.equal(sbWait.style.color, norm(slotTimeStyle(31).color), 'the shared colour scale')
})

test('§7 opening the inbox from its tab starts on the inbox folder again; the card switches an open inbox to listeners', async (t) => {
  const nd = project({ mail_queue: 'ack' }, { mail_pending: 3, mail_held: 1 })
  const { view } = await desk(t, nd)
  serveInbox(t)
  await clickCard(view.el)
  assert.equal(openFolder(view.el), 'listeners')
  await showTab(view.el, 'desk')
  await showTab(view.el, 'inbox')
  assert.equal(openFolder(view.el), 'inbox', 'the tab strip opens the inbox folder, not the last card click')
  await clickFolder(view.el, 'sent')
  assert.equal(openFolder(view.el), 'sent')
  await clickCard(view.el)
  assert.equal(openFolder(view.el), 'listeners', 'a card click switches the open inbox to its listeners')
})

test('§7 a mail card naming only waiting mail opens the inbox folder; the empty listeners folder says how to listen', async (t) => {
  const nd = project({}, { mail_pending: 3 })
  const { view } = await desk(t, nd, false)
  serveInbox(t)
  const card = view.el.querySelector<HTMLButtonElement>('.project-queue-card')!
  assert.equal(card.textContent, "3 q'd")
  await clickCard(view.el)
  assert.equal(tabOn(view.el, 'inbox'), true)
  assert.equal(openFolder(view.el), 'inbox', 'no listener to show: the waiting mail')
  assert.deepEqual(folders(view.el), ['inbox 3', 'sent', 'listeners'], 'the folder is there without a badge')
  await clickFolder(view.el, 'listeners')
  assert.match(view.el.querySelector('.project-mail-listeners')?.textContent ?? '', /kind=fair_queue target=sync/,
    'the empty folder says how an agent starts listening')
})
