// waitingmail.test.tsx — the project Mail › listeners folder's WAITING MAIL section (Orgtree 4.7.1; docket
// project-mail-listeners-tab-waiting-mail-section-a). USER 2026-11-27 15:58:52Z mda4ff74ebfd6 "do i normally not see
// queued messages in a project's mail liseners tab"; 15:59:52Z m7472b6f3a603 "yes please, above recently finished".
//
// The mail no listener has taken yet, one row each in the engine's hand-out order (oldest first: `pick` in
// domain/projects.rs takes `state = 'pending' ORDER BY id`), directly above Recently Finished / Delivered. Its rows are
// the inbox's own waiting rows and its count is the inbox tab's, so the two always agree.
//
// Run:  cd apps/desktop/renderer && node tests/run.mjs waitingmail

import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { FakeServer, flush, inAct, installFetch, mountView } from './harness'
import { MailListenersView } from '../src/canvas/maillisteners'
import { ProjectDesk } from '../src/canvas/projectdesk'
import { forgetDeskMemory } from '../src/canvas/desktabs'
import { DeskDogsProvider } from '../src/canvas/deskdogs'
import { mailListenerState } from '../src/canvas/listeners'
import type { CanvasNode, MailRow, OpRequest, OpResult } from '../src/canvas/shared'
import type { TreePayload, Watchdog } from '../src/types'

const noop = () => {}
const T = '.mail-listeners-table'
const node = (id: string, extra: Partial<CanvasNode> = {}): CanvasNode => ({
  id, parent: id === 'sync' ? 'boss' : id === 'boss' ? null : 'sync', state: 'live', tier: id === 'sync' ? 'project' : 'haiku',
  kind: id === 'sync' ? 'project' : 'agent', model_id: '', title: id, children: [], seat: 0, grant: 0, free: 0,
  scope: { tools: {}, add_dirs: [] }, configured_scope: { tools: {}, add_dirs: [] }, lineage: [], turns: [], audiences_held: [],
  mail_pending: 0, mail_held: 0, last_status: null, occupancy: 0, context_window: 0, busy: false, activity: null, ...extra,
} as unknown as CanvasNode)
const map = new Map<string, CanvasNode>(['boss', 'sync', 'sa', 'sb'].map((id) => [id, node(id)]))
const dog = (owner: string, name: string): Watchdog =>
  ({ id: owner + '/' + name, owner, name, kind: 'fair_queue', target: 'sync', interval_s: 5, state: 'armed',
    at: '2026-10-19T07:00:00.000Z', fired: 0, once: false, spent: false } as Watchdog)
const sections = (el: Element) => [...el.querySelectorAll(`${T} tr.slot-section h4`)].map((h) => h.textContent)
const cells = (row: Element) => [...row.children].map((c) => (c.textContent ?? '').replace(/\s+/g, ' ').trim())
const waitingRows = (el: Element) => [...el.querySelectorAll<HTMLTableRowElement>(`${T} .mail-waiting tr.waiting-mail`)]
const ago = (seconds: number) => new Date(Date.now() - seconds * 1000).toISOString()

/** the mailbox's waiting rows as the inbox holds them: oldest first, the engine's hand-out order */
const waiting = (): MailRow[] => [
  { id: 'w1', from: 'boss', kind: 'message', body: 'first job\nwith details', at: ago(600), _wait: true },
  { id: 'w2', from: 'sa', kind: 'message', body: 'second job', at: ago(300), _wait: true },
  { id: 'w3', from: '@user', kind: 'message', body: 'third job', at: ago(60), _wait: true },
] as MailRow[]
const delivered = (): MailRow[] => [
  { id: 'd1', from: 'boss', kind: 'message', body: 'an old one', at: ago(9000), queue: { held_by: 'sb', ack: true, acked_at: ago(8000) } },
] as MailRow[]

async function folder(t: TestContext, ack: boolean, rows: MailRow[], count?: number) {
  const opened: string[] = []
  const listeners = [dog('sa', 'mail-a'), dog('sb', 'mail-b')]
  const op = async (req: OpRequest) => (req.op === 'mail_queue_history'
    ? { project: 'sync', ack, history: [], history_next: null, working: [] } : {}) as unknown as OpResult
  const view = await mountView(<DeskDogsProvider value={{ org: 'org', dogs: listeners, open: noop }}>
    <MailListenersView node={map.get('sync')!} state={mailListenerState('sync', listeners)} map={map} rows={rows} ack={ack}
      waiting={count} dogs={listeners} onOpenMail={(id) => { opened.push(id) }} op={op} toast={noop} />
  </DeskDogsProvider>, (el) => el)
  t.after(() => view.unmount())
  await inAct(async () => { await flush(4) })
  return { view, opened }
}

test('Waiting mail sits directly above Recently Finished (ack) and Recently Delivered (round-robin)', async (t) => {
  const a = await folder(t, true, [...waiting(), ...delivered()], 3)
  assert.deepEqual(sections(a.view.el), ['Working', 'Line', 'Waiting mail', 'Recently Finished'])
  const r = await folder(t, false, [...waiting(), ...delivered()], 3)
  assert.deepEqual(sections(r.view.el), ['Line', 'Waiting mail', 'Recently Delivered'])
})

test('one row per waiting mail, in hand-out order: its place in line, a live wait, the mail link and its sender', async (t) => {
  const { view, opened } = await folder(t, true, [...waiting(), ...delivered()], 3)
  const rows = waitingRows(view.el)
  assert.equal(rows.length, 3, 'the three waiting mails; a delivered one is not waiting')
  assert.deepEqual(rows.map((r) => cells(r)[0]), ['1st', '2nd', '3rd'], 'oldest first: the next to go out is 1st')
  assert.deepEqual(rows.map((r) => r.querySelector('.listener-mail-link')?.getAttribute('data-mail')), ['w1', 'w2', 'w3'])
  assert.ok(rows.every((r) => r.querySelector('.slot-wait .slot-time.live')), 'Waited counts up since it arrived, in the slot time colours')
  assert.equal(cells(rows[0]!)[2], '10m')
  assert.match(rows[0]!.querySelector('.listener-mail')!.textContent ?? '', /from\s*boss/, 'its sender')
  assert.ok(rows[2]!.querySelector('.listener-mail .user-mention, .listener-mail [data-user-mention]') || /from\s*@?user/i.test(rows[2]!.querySelector('.listener-mail')!.textContent ?? ''),
    'the user as sender is the user mention')
  const c = cells(rows[0]!)
  assert.deepEqual([1, 3, 4, 6, 7, 8, 9, 10].map((i) => c[i]), ['', '', '', '', '', '', '', ''], 'the other columns stay empty')
  await inAct(async () => { rows[1]!.querySelector<HTMLButtonElement>('.listener-mail-link button.ref-chip')!.click(); await flush(2) })
  assert.deepEqual(opened, ['w2'], 'the mail opens in the inbox')
})

test('the empty state reads "No mail is waiting."', async (t) => {
  const { view } = await folder(t, true, delivered(), 0)
  assert.equal(waitingRows(view.el).length, 0)
  assert.equal(view.el.querySelector(`${T} .mail-waiting td.slot-empty`)?.textContent, 'No mail is waiting.')
})

test('a long line folds like Recently Finished: ten rows, then "Show N more"', async (t) => {
  const many = Array.from({ length: 14 }, (_, i) => ({ id: `w${i}`, from: 'boss', kind: 'message', body: `job ${i}`, at: ago(1000 - i), _wait: true })) as MailRow[]
  const { view } = await folder(t, true, many, 14)
  assert.equal(waitingRows(view.el).length, 10)
  const more = view.el.querySelector<HTMLButtonElement>(`${T} .mail-waiting [data-action="show-more"]`)!
  assert.equal(more.textContent, 'Show 4 more')
  await inAct(async () => { more.click(); await flush(2) })
  assert.deepEqual(waitingRows(view.el).map((r) => cells(r)[0]).slice(-1), ['14th'])
})

test("the section's count is the inbox's: mail past the loaded window is still counted", async (t) => {
  const { view } = await folder(t, true, waiting(), 5)
  assert.equal(waitingRows(view.el).length, 3)
  assert.match(view.el.querySelector(`${T} .mail-waiting .waiting-more`)?.textContent ?? '', /2 more waiting mail/)
})

/* ─── the desk: the folder's rows and the inbox tab's count agree ───────── */

test('on the project desk the Waiting mail rows are the inbox tab\'s waiting mail, and as many as its count', async (t) => {
  installFetch(new FakeServer())
  const inner = globalThis.fetch
  globalThis.fetch = ((url: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(url), 'http://x').pathname
    if (path === '/api/orgs/org/nodes/sync/inbox')
      return Promise.resolve(new Response(JSON.stringify({ pending: waiting().slice(0, 2).map(({ _wait, ...m }) => m), sent: [], delivered: delivered() }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }))
    if (path === '/api/app-settings/runtime')
      return Promise.resolve(new Response(JSON.stringify({}), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    return inner(url, init)
  }) as typeof fetch
  t.after(() => { globalThis.fetch = inner })
  forgetDeskMemory()
  const nd = node('sync', { configured_scope: { tools: {}, add_dirs: [], mail_queue: 'ack' }, mail_pending: 2 } as Partial<CanvasNode>)
  const listeners = [dog('sa', 'mail-a'), dog('sb', 'mail-b')]
  const tree = { slug: 'org', roots: [], watchdogs: listeners, slot_leases: [] } as unknown as TreePayload
  const view = await mountView(<ProjectDesk node={nd} slug="org" tree={tree} map={new Map([...map, ['sync', nd]])}
    op={(b) => Promise.resolve((b.op === 'mail_queue_history' ? { project: 'sync', ack: true, history: [], history_next: null, working: [] }
      : {}) as unknown as OpResult)} toast={noop} refs={{ world: { org: 'org' }, onOpen: noop } as never} />, (el) => el)
  t.after(() => view.unmount())
  await inAct(async () => { await flush(4) })
  await inAct(async () => { view.el.querySelector<HTMLButtonElement>('.project-queue-card')!.click(); await flush(6) })
  const strip = () => [...view.el.querySelectorAll('.mail-folders > button')].map((b) => (b.textContent ?? '').replace(/\s+/g, ' ').trim())
  assert.ok(strip().includes('inbox 2'), `the inbox tab counts two waiting: ${strip().join(', ')}`)
  assert.deepEqual(waitingRows(view.el).map((r) => r.querySelector('.listener-mail-link')?.getAttribute('data-mail')), ['w1', 'w2'],
    'and the listeners folder lists the same two, in hand-out order')
  assert.equal(view.el.querySelector(`${T} .mail-waiting .waiting-more`), null, 'nothing past the window')
})
