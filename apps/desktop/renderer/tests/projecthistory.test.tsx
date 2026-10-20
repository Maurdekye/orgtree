// projecthistory.test.tsx — the project desk's history tables (Orgtree
// 4.4.0; docket `project-desk-mail-event-listeners-and-slots-tabs`, user
// 2026-10-20 06:22Z-06:42Z, design approved by the coordinator 06:36Z).
//
// WHAT THIS FILE HOLDS THE CODE TO:
//   §1 the Listeners tab's Recently Fired: an event's row (who fired it, how
//      long ago, its message on one line until clicked) with a sub-row per
//      listener it reached (how long that listener had listened, and its
//      fire mail, opened in the LISTENER's Mail tab and shown unavailable
//      once gone); a listener watch reaching its count, tinted, with the
//      listeners armed then; older fires as you scroll;
//   §2 the Mail tab's listeners folder in ack mode: Working with its take
//      back (asked first, then the engine's op), Recently Finished with each
//      kind of ending highlighted, and the Dead Letter Line while a
//      dead-letter listener reaches the project;
//   §3 in round-robin, Recently Delivered, older deliveries as you scroll;
//   §4 the Slots tab: a Watchdog column before Action, the lease alone,
//      Recently Held;
//   §5 dead-letter listeners: the sepia-maroon chip wherever it is drawn,
//      their own words in the detail, and which of them count for a project;
//   §6 narrow desks (user 2026-10-20 09:00Z): every cell that may shorten
//      keeps its whole text in a tooltip (the CSS is desktablelayout's).
//
// Run:  cd apps/desktop/renderer && node tests/run.mjs projecthistory

import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { flush, inAct, mountView, realClock, useFakeClock } from './harness'
import { ListenersView } from '../src/canvas/listenersdesk'
import type { FiredRow } from '../src/canvas/listenersdesk'
import { MailListenersView } from '../src/canvas/maillisteners'
import type { FinishedJob, DeliveredJob, WorkingJob } from '../src/canvas/maillisteners'
import { SlotsView } from '../src/canvas/slotsdesk'
import { DeskDogsProvider } from '../src/canvas/deskdogs'
import { WatchdogLink } from '../src/canvas/watchdoglink'
import { acceptsEvent, deadLetterListeners, isDeadLetterListener, listeningSince, mailListenerState, reachesProject } from '../src/canvas/listeners'
import { projectSlotState } from '../src/canvas/slots'
import { watchdogDescription } from '../src/canvas/watchdogdescription'
import type { ResolvedRef } from '../src/canvas/reflinks'
import type { CanvasNode, MailRow, OpRequest, OpResult } from '../src/canvas/shared'
import type { Watchdog } from '../src/types'

const noop = () => {}
const node = (id: string, parent: string | null, extra: Partial<CanvasNode> = {}): CanvasNode => ({
  id, parent, state: 'live', tier: id === 'sync' ? 'project' : 'haiku', kind: id === 'sync' ? 'project' : 'agent', model_id: '',
  children: [], seat: 0, grant: 0, free: 0, scope: { tools: {}, add_dirs: [] }, configured_scope: { tools: {}, add_dirs: [] }, ...extra,
} as unknown as CanvasNode)
/** boss over the sync project, sa and sb under it; carol elsewhere */
const map = new Map<string, CanvasNode>([
  ['boss', node('boss', null)], ['sync', node('sync', 'boss')], ['sa', node('sa', 'sync')], ['sb', node('sb', 'sync')],
  ['carol', node('carol', null)],
])
const dog = (kind: Watchdog['kind'], owner: string, name: string, extra: Partial<Watchdog> = {}): Watchdog =>
  ({ id: owner + '/' + name, owner, name, kind, target: 'sync', interval_s: 5, state: 'armed',
    at: '2026-10-19T07:00:00.000Z', fired: 0, once: false, spent: false, ...extra } as Watchdog)
const settle = () => inAct(async () => { await flush(4) })
async function bottom(el: Element, sel = '.slots-table-scroll') {
  const scroll = el.querySelector<HTMLElement>(sel)!
  Object.defineProperties(scroll, { scrollHeight: { configurable: true, value: 2000 }, clientHeight: { configurable: true, value: 400 },
    scrollTop: { configurable: true, value: 1600 } })
  await inAct(async () => { scroll.dispatchEvent(new Event('scroll', { bubbles: true })); await flush(4) })
}
const cells = (row: Element) => [...row.children].map((c) => (c.textContent ?? '').replace(/\s+/g, ' ').trim())
const heads = (el: Element, table: string) => [...el.querySelectorAll(`${table} thead th`)].map((h) => h.textContent)
const sections = (el: Element, table: string) => [...el.querySelectorAll(`${table} tr.slot-section h4`)].map((h) => h.textContent)

/* ─── §1 Recently Fired ─────────────────────────────────────────────────── */

const ago = (seconds: number) => new Date(Date.now() - seconds * 1000).toISOString()
function fires(): FiredRow[] {
  return [
    { id: 12, at: ago(180), kind: 'event', by: 'boss', message: 'go: start build 7\nthen run the tests and report back', listeners: [
      { agent: 'sa', dog: 'ready-a', name: 'ready-a', once: true, since: ago(480), mail: 'm-sa' },
      { agent: 'sb', dog: 'ready-b', name: 'ready-b', once: false, since: ago(240), mail: 'm-sb', mail_gone: true },
    ] },
    { id: 11, at: ago(200), kind: 'watch', by: 'boss', message: null,
      watch: { agent: 'boss', dog: 'pair', name: 'pair', count: 2, armed: 2, since: ago(900) }, listeners: [
        { agent: 'sa', dog: 'ready-a', name: 'ready-a', once: true, since: ago(480) },
        { agent: 'sb', dog: 'ready-b', name: 'ready-b', once: false, since: ago(240) },
      ] },
    { id: 10, at: ago(3600), kind: 'event', by: '@user', message: null, listeners: [] },
  ]
}

async function firedTab(t: TestContext) {
  useFakeClock()
  t.after(() => realClock())
  const ops: OpRequest[] = []
  const opened: ResolvedRef[] = []
  const live = [dog('project_listener', 'sb', 'ready-b')]
  const op = async (req: OpRequest) => {
    ops.push(req)
    if (req.op !== 'listener_history') return {} as OpResult
    return (req.history_before === 'c10'
      ? { history: [{ id: 9, at: ago(7200), kind: 'event', by: 'sa', message: 'older', listeners: [] }], history_next: null }
      : { history: fires(), history_next: 'c10' }) as unknown as OpResult
  }
  const refs = { world: { org: 'org' }, onOpen: (r: ResolvedRef) => { opened.push(r) } }
  const view = await mountView(<DeskDogsProvider value={{ org: 'org', dogs: live, open: noop }}>
    <ListenersView node={map.get('sync')!} dogs={live} map={map} op={op} toast={noop} refs={refs} />
  </DeskDogsProvider>, (el) => el)
  t.after(() => view.unmount())
  await settle()
  return { view, ops, opened }
}
const fireRow = (el: Element, id: number) => el.querySelector<HTMLTableRowElement>(`.listeners-table tr.fired-row[data-fire="${id}"]`)!
/** the sub-rows that follow a fire's row */
function subRows(row: Element): HTMLTableRowElement[] {
  const out: HTMLTableRowElement[] = []
  for (let r = row.nextElementSibling; r && r.classList.contains('fired-listener'); r = r.nextElementSibling) out.push(r as HTMLTableRowElement)
  return out
}

test('§1 Recently Fired: one table with the listeners, its own columns only where they carry data', async (t) => {
  const { view, ops } = await firedTab(t)
  assert.deepEqual(ops.filter((o) => o.op === 'listener_history'), [{ op: 'listener_history', node: 'sync' }], 'the engine\'s history, read once')
  assert.deepEqual(sections(view.el, '.listeners-table'), ['Event listeners', 'Listener watches', 'Recently Fired'])
  assert.deepEqual(heads(view.el, '.listeners-table'), ['Position', 'Agent', 'Waited', 'Last fired', 'Mail', 'Armed', 'Fired', 'Watchdog'],
    'a Mail column for the fire mails, Armed for the kept watch')
  for (const r of view.el.querySelectorAll('.listeners-table tr.listener-row')) assert.equal(r.children.length +
    [...r.children].reduce((n, c) => n + ((c as HTMLTableCellElement).colSpan - 1), 0), 8, 'every row spans the whole table')
})

test('§1 an event: who fired it, how long ago, its message on one line until clicked; a sub-row per listener with how long it listened', async (t) => {
  const { view } = await firedTab(t)
  const row = fireRow(view.el, 12)
  const c = cells(row)
  assert.equal(c[0], 'event')
  assert.equal(row.querySelector('.slot-agent [data-copy-agent-name]')?.getAttribute('data-copy-agent-name'), 'boss', 'who fired it, as a link')
  assert.equal(c[3], '3m ago', 'how long ago it fired, as the slots table\'s Ended')
  const message = row.querySelector<HTMLTableCellElement>('.fired-message')!
  assert.equal(message.colSpan, 4, 'the message spans the columns after Last fired')
  const text = message.querySelector<HTMLButtonElement>('.fired-message-text')!
  assert.match(text.textContent ?? '', /^go: start build 7/)
  assert.equal(message.classList.contains('open'), false, 'truncated to one line')
  await inAct(async () => { text.click(); await flush(2) })
  assert.equal(message.classList.contains('open'), true, 'a click shows the whole message')
  assert.equal(text.getAttribute('aria-expanded'), 'true')
  await inAct(async () => { text.click(); await flush(2) })
  assert.equal(message.classList.contains('open'), false, 'and another folds it')
  const subs = subRows(row)
  assert.equal(subs.length, 2, 'one sub-row per listener it reached')
  assert.deepEqual(subs.map((r) => cells(r)[0]), ['└', '└'])
  assert.deepEqual(subs.map((r) => r.querySelector('[data-copy-agent-name]')?.getAttribute('data-copy-agent-name')), ['sa', 'sb'])
  assert.deepEqual(subs.map((r) => cells(r)[2]), ['5m', '60s'], 'how long each had listened: since its arming or its previous event')
  assert.equal(subs[0]!.querySelector('.slot-wait .slot-time.live'), null, 'a closed stretch, not counting up')
  assert.equal(subs[0]!.querySelector('.watchdog-link-name')?.textContent, 'ready-a', 'its dog, kept after it is spent')
  assert.ok(subs[0]!.querySelector('.watchdog-link')?.classList.contains('gone'), 'drawn as gone')
  assert.equal(subs[1]!.querySelector('.watchdog-link')?.classList.contains('gone'), false, 'a dog still armed is the live chip')
  const none = fireRow(view.el, 10)
  assert.equal(cells(none)[1], '@user', 'fired by the user')
  assert.match(cells(none)[4] ?? '', /no message · nobody was listening/)
  assert.equal(subRows(none).length, 0)
})

test("§1 each listener's fire mail opens in ITS Mail tab; a mail no longer there is unavailable (user 2026-10-20 06:42Z)", async (t) => {
  const { view, opened } = await firedTab(t)
  const [sa, sb] = subRows(fireRow(view.el, 12))
  const link = sa!.querySelector<HTMLButtonElement>('button.fire-mail')!
  assert.equal(link.textContent, 'fire mail')
  await inAct(async () => { link.click(); await flush(2) })
  assert.equal(opened.length, 1, 'opened through the surface\'s mail route')
  assert.deepEqual(opened[0]!.ref, { kind: 'mail', org: 'org', box: 'node', node: 'sa', id: 'm-sa' },
    "the listener's own mailbox, never the project's")
  assert.equal(sb!.querySelector('button.fire-mail'), null, 'no link to a mail that is gone')
  const gone = sb!.querySelector<HTMLElement>('.fire-mail.unavailable')!
  assert.equal(gone.textContent, 'fire mail · unavailable')
  assert.match(gone.title, /no longer in sb's mailbox/)
})

test('§1 a listener watch reaching its count: tinted, its owner, its wait, the armed count, and the listeners armed then', async (t) => {
  const { view } = await firedTab(t)
  const row = fireRow(view.el, 11)
  assert.ok(row.classList.contains('watch'), 'a differently coloured row')
  const c = cells(row)
  assert.equal(c[0], 'watch')
  assert.equal(row.querySelector('.slot-agent [data-copy-agent-name]')?.getAttribute('data-copy-agent-name'), 'boss', "the watch's owner")
  assert.equal(c[2], '12m', 'how long the watch waited for its count')
  assert.equal(c[3], '3m ago')
  assert.equal(c[5], '2/2', 'the armed listeners over its count')
  assert.ok(row.querySelector('.watchdog-link')?.classList.contains('listener-watch'), "the watch's chip")
  const subs = subRows(row)
  assert.deepEqual(subs.map((r) => r.querySelector('[data-copy-agent-name]')?.getAttribute('data-copy-agent-name')), ['sa', 'sb'],
    'every agent listening at the crossing')
  assert.deepEqual(subs.map((r) => cells(r)[2]), ['5m', '40s'], 'with how long each had waited')
  assert.ok(subs.every((r) => r.classList.contains('watch')), 'tinted with their watch')
  assert.ok(subs.every((r) => !r.querySelector('.fire-mail')), 'a crossing hands its listeners no mail')
})

test('§1 older fires load as you scroll, as Recently Held does', async (t) => {
  const { view, ops } = await firedTab(t)
  assert.match(view.el.querySelector('.listeners-table .slot-history-more')?.textContent ?? '', /Scroll for older fires/)
  await bottom(view.el)
  assert.deepEqual(ops.filter((o) => o.op === 'listener_history').at(-1), { op: 'listener_history', node: 'sync', history_before: 'c10' })
  assert.ok(fireRow(view.el, 9), 'the older page is appended')
  assert.equal(view.el.querySelector('.listeners-table .slot-history-more'), null, 'nothing more to load')
})

/* ─── §2 Mail › listeners, ack mode ─────────────────────────────────────── */

const fq = (owner: string, name: string) => ({ id: `${owner}/${name}`, owner, name, kind: 'fair_queue' as const, once: false, state: 'armed', gone: false })
function ackHistory() {
  const working: WorkingJob[] = [{ mail: 'm1', gist: 'build it', copy: 'c1', agent: 'sa', dog: fq('sa', 'mail-a'), attempts: 1,
    waited_from: '2026-10-19T07:00:00.000Z', held_at: '2026-10-19T08:00:00.000Z' }]
  const end = (id: number, how: string, extra: Partial<FinishedJob> = {}): FinishedJob => ({ id, mail: `m${id}0`, gist: `job ${id}`, copy: `c${id}`,
    agent: 'sb', dog: fq('sb', 'mail-b'), how, attempt: 1, waited_from: '2026-10-19T06:00:00.000Z', held_at: '2026-10-19T06:10:00.000Z',
    ended_at: '2026-10-19T06:40:00.000Z', ...extra })
  const history: FinishedJob[] = [
    end(4, 'acked', { ack: 'a4', ack_gist: 'tested, all green' }),
    end(3, 'failed', { why: 'was halted' }),
    end(2, 'taken_back', { why: 'had it taken back by @user' }),
    end(1, 'dead_letter', { why: 'did not ack it after 2 reminders', attempt: 3 }),
  ]
  return { project: 'sync', ack: true, max_attempts: 3, dead_letters: true, working, history, history_next: null }
}
async function mailFolder(t: TestContext, history: unknown | ((req: OpRequest) => unknown), ack: boolean) {
  const ops: OpRequest[] = []
  const toasts: string[] = []
  const openedMail: string[] = []
  const listeners = [dog('fair_queue', 'sa', 'mail-a'), dog('fair_queue', 'sb', 'mail-b')]
  const others = [
    dog('event', 'boss', 'dead-watch', { target: 'project.dead_letter' }),
    dog('event', 'carol', 'far-dead', { target: 'project.dead_letter' }),
    dog('event', 'boss', 'live-count', { target: 'agents.live' }),
  ]
  const all = [...listeners, ...others]
  const op = async (req: OpRequest) => {
    ops.push(req)
    if (req.op === 'mail_take_back') return { project: 'sync', mail: req.mail, holder: 'sa', taken: true, dead_letter: false } as unknown as OpResult
    return (typeof history === 'function' ? (history as (req: OpRequest) => unknown)(req) : history) as OpResult
  }
  const sync = map.get('sync')!
  const view = await mountView(<DeskDogsProvider value={{ org: 'org', dogs: all, open: noop }}>
    <MailListenersView node={{ ...sync, configured_scope: ack ? { mail_queue: 'ack' } : {} } as unknown as CanvasNode}
      state={mailListenerState('sync', all)} map={map} rows={[] as MailRow[]} ack={ack} dogs={all}
      onOpenMail={(id) => { openedMail.push(id) }} op={op} toast={(lines) => { toasts.push(...lines) }} />
  </DeskDogsProvider>, (el) => el)
  t.after(() => view.unmount())
  await settle()
  return { view, ops, toasts, openedMail }
}
const T = '.mail-listeners-table'

test('§2 ack mode: Working, Line, the Dead Letter Line while a dead-letter listener reaches the project, Recently Finished (user 06:22Z, 06:41Z)', async (t) => {
  const { view, ops } = await mailFolder(t, ackHistory(), true)
  assert.deepEqual(ops, [{ op: 'mail_queue_history', node: 'sync' }])
  assert.deepEqual(sections(view.el, T), ['Working', 'Line', 'Dead Letter Line', 'Recently Finished'])
  const dead = [...view.el.querySelectorAll<HTMLTableRowElement>(`${T} .mail-dead-line tr.listener-row`)]
  assert.equal(dead.length, 1, "boss's dead-letter dog: carol reaches no part of the project, and a count dog is no dead-letter listener")
  assert.equal(dead[0]!.querySelector('[data-copy-agent-name]')?.getAttribute('data-copy-agent-name'), 'boss')
  assert.ok(dead[0]!.querySelector('.watchdog-link')?.classList.contains('dead-letter'), 'its chip in the dead-letter sepia-maroon')
  const work = view.el.querySelector<HTMLTableRowElement>(`${T} .mail-working tr.listener-row`)!
  const w = cells(work)
  assert.equal(w[2], '1h 0m', 'waited from its arming to the hand-out')
  assert.ok(work.querySelector('.slot-held .slot-time.live'), 'held, counting up')
  assert.equal(work.querySelector('.listener-mail-link')?.textContent, 'build it', 'a link to the delivered mail')
  assert.equal(work.querySelector('[data-action="take-back"]')?.textContent, 'take back')
  const line = [...view.el.querySelectorAll<HTMLTableRowElement>(`${T} .mail-line tr.listener-row`)]
  assert.deepEqual(line.map((r) => r.querySelector('[data-copy-agent-name]')?.getAttribute('data-copy-agent-name')), ['sb'],
    'the holder of its whole batch is not in line')
})

test("§2 the Dead Letter Line is the engine's list when it sends one: a listener past its owner's eight-dog tree preview still shows (watchdog uncap 2026-10-20)", async (t) => {
  const late = dog('event', 'sa', 'dl-late', { target: 'project.*', state: 'paused' })
  const { view } = await mailFolder(t, { ...ackHistory(), dead_letter_listeners: [dog('event', 'boss', 'dead-watch', { target: 'project.dead_letter' }), late] }, true)
  const dead = [...view.el.querySelectorAll<HTMLTableRowElement>(`${T} .mail-dead-line tr.listener-row`)]
  assert.deepEqual(dead.map((r) => r.querySelector('[data-copy-agent-name]')?.getAttribute('data-copy-agent-name')), ['boss', 'sa'],
    "the engine's list in its order, though the tree's preview lacks sa's dog")
  assert.equal(cells(dead[1]!)[0], 'paused')
  assert.ok(dead.every((r) => r.querySelector('.watchdog-link')?.classList.contains('dead-letter')), 'each in the dead-letter sepia-maroon')
})

test('§2 Recently Finished: the job, its ack, the three times, and each ending without an ack highlighted by kind (user 06:41Z)', async (t) => {
  const { view, openedMail } = await mailFolder(t, ackHistory(), true)
  const rows = [...view.el.querySelectorAll<HTMLTableRowElement>(`${T} .mail-history tr.listener-row`)]
  assert.deepEqual(rows.map((r) => r.getAttribute('data-ending')), ['acked', 'failed', 'taken_back', 'dead_letter'], 'newest ending first')
  assert.deepEqual(rows.map((r) => r.classList.contains('ending-failed')), [false, true, true, false], 'failed without an ack: one highlight')
  assert.deepEqual(rows.map((r) => r.classList.contains('ending-dead')), [false, false, false, true], 'a dead letter: another')
  const acked = cells(rows[0]!)
  assert.equal(acked[2], '10m', 'Waited: from its last end to the hand-out')
  assert.equal(acked[3], '30m', 'Held: from the hand-out to the ack')
  assert.match(acked[4]!, /ago$/, 'Acked: how long ago')
  const ackLink = rows[0]!.querySelector<HTMLButtonElement>('.listener-ack .listener-mail-link')!
  assert.equal(ackLink.textContent, 'tested, all green', 'a link to the ack mail')
  await inAct(async () => { ackLink.click(); await flush(2) })
  await inAct(async () => { rows[0]!.querySelector<HTMLButtonElement>('.listener-mail .listener-mail-link')!.click(); await flush(2) })
  assert.deepEqual(openedMail, ['a4', 'm40'], 'the ack and the job open in the project inbox')
  assert.deepEqual(rows.slice(1).map((r) => cells(r)[6]), ['failed', 'taken back', 'dead letter'], 'the ending in a word where the ack would be')
  assert.match(rows[1]!.querySelector<HTMLElement>('.ending-word')!.title, /sb was halted \(attempt 1 of 3\)/)
})

test('§2 take back asks first, then runs the engine op; the holder is told and the job goes to another listener first (user 06:42Z)', async (t) => {
  const { view, ops, toasts } = await mailFolder(t, ackHistory(), true)
  await inAct(() => { view.el.querySelector<HTMLButtonElement>('[data-action="take-back"]')!.click() })
  assert.equal(ops.some((o) => o.op === 'mail_take_back'), false, 'nothing before the confirmation')
  assert.match(document.body.textContent ?? '', /take this job back from sa\?/)
  assert.match(document.body.textContent ?? '', /another listener takes it first/)
  assert.match(document.body.textContent ?? '', /its ack of it is refused/)
  const go = [...document.querySelectorAll('button')].find((b) => b.textContent === 'take back' && !b.closest('.mail-listeners-table'))!
  await inAct(async () => { go.click(); await flush(4) })
  assert.deepEqual(ops.filter((o) => o.op === 'mail_take_back'), [{ op: 'mail_take_back', node: 'sync', mail: 'm1' }])
  assert.match(toasts.join('\n'), /took m1 back from sa/)
  assert.equal(ops.filter((o) => o.op === 'mail_queue_history').length, 2, 'and the folder reads the queue again')
})

/* ─── §3 round-robin ───────────────────────────────────────────────────── */

test('§3 round-robin: Line and Recently Delivered, with when each was delivered; older deliveries as you scroll', async (t) => {
  const delivered = (id: number): DeliveredJob => ({ id, copy: `c${id}`, agent: id % 2 ? 'sa' : 'sb', mail: `m${id}`, gist: `mail ${id}`,
    dog: fq(id % 2 ? 'sa' : 'sb', id % 2 ? 'mail-a' : 'mail-b'), held_at: '2026-10-19T08:00:00.000Z', waited_from: '2026-10-19T07:58:00.000Z' })
  const { view, ops } = await mailFolder(t, (req: OpRequest) => req.history_before === 'c2'
    ? { project: 'sync', ack: false, history: [delivered(1)], history_next: null }
    : { project: 'sync', ack: false, history: [delivered(3), delivered(2)], history_next: 'c2' }, false)
  assert.deepEqual(heads(view.el, T), ['Position', 'Agent', 'Waited', 'Delivered', 'Mail', 'Batch', 'Handed', 'Watchdog'])
  assert.deepEqual(sections(view.el, T), ['Line', 'Dead Letter Line', 'Recently Delivered'], 'no Working in round-robin')
  const rows = () => [...view.el.querySelectorAll<HTMLTableRowElement>(`${T} .mail-history tr.listener-row`)]
  assert.deepEqual(rows().map((r) => cells(r)[4]), ['mail 3', 'mail 2'])
  assert.equal(cells(rows()[0]!)[2], '2m', 'Waited: from its last hand-out to this one')
  assert.match(cells(rows()[0]!)[3]!, /ago$/, 'Delivered: how long ago (user 06:36Z)')
  await bottom(view.el)
  assert.deepEqual(ops.at(-1), { op: 'mail_queue_history', node: 'sync', history_before: 'c2' })
  assert.deepEqual(rows().map((r) => cells(r)[4]), ['mail 3', 'mail 2', 'mail 1'], 'the older page appended')
})

/* ─── §4 Slots ─────────────────────────────────────────────────────────── */

test('§4 Slots: a Watchdog column before Action, the lease alone, Recently Held (user 06:22Z, 06:36Z)', async (t) => {
  const claim = (owner: string, name: string, gone: boolean) =>
    ({ id: `${owner}/${name}`, owner, name, kind: 'slot', once: true, state: gone ? 'spent' : 'armed', gone })
  const status = { project: 'sync', slots: 1, held: 1,
    holders: [{ lease: 'L1', agent: 'sa', slots: 1, reason: 'build-slot', since: '2026-10-19T08:00:00.000Z', dog: claim('sa', 'build-slot', true) }],
    line: [{ position: 1, agent: 'sb', dog: 'claim-b', slots: 1, since: '2026-10-19T08:05:00.000Z' }],
    history: [{ lease: 'L0', agent: 'sa', slots: 1, reason: 'first-build', since: '2026-10-19T07:00:00.000Z', ended: '2026-10-19T07:30:00.000Z',
      how: 'released', dog: claim('sa', 'first-build', true) }], history_next: null }
  const waiting = dog('slot', 'sb', 'claim-b', { once: true, queued_at: '2026-10-19T08:05:00.000Z' })
  const state = projectSlotState('sync', 1, [{ project: 'sync', agent: 'sa', slot: 1, lease: 'L1', since: '2026-10-19T08:00:00.000Z' }], [waiting])
  const view = await mountView(<DeskDogsProvider value={{ org: 'org', dogs: [waiting], open: noop }}>
    <SlotsView node={map.get('sync')!} state={state} map={map} op={async () => status as unknown as OpResult} toast={noop} />
  </DeskDogsProvider>, (el) => el)
  t.after(() => view.unmount())
  await settle()
  assert.deepEqual(heads(view.el, '.slots-table'), ['Position', 'Agent', 'Waited', 'Held', 'Ended', 'Lease', 'Slots', 'Watchdog', 'Action'])
  assert.deepEqual(sections(view.el, '.slots-table'), ['Holding', 'Line', 'Recently Held'])
  const holder = view.el.querySelector<HTMLTableRowElement>('.slots-holding tr.slot-row')!
  assert.equal(holder.querySelector('.slot-rest')?.textContent, 'L1', 'the lease alone: the claim is named by its chip')
  const kept = holder.querySelector<HTMLElement>('.listener-dog-cell .watchdog-link')!
  assert.equal(kept.querySelector('.watchdog-link-name')?.textContent, 'build-slot', "the holder's claim, spent by its grant")
  assert.ok(kept.classList.contains('slot') && kept.classList.contains('gone'), 'in the slot amber, drawn as gone')
  const waiter = view.el.querySelector<HTMLTableRowElement>('.slots-line tr.slot-row')!
  assert.equal(waiter.querySelector('.slot-rest')?.textContent, '', 'a waiting claim has no lease yet')
  const live = waiter.querySelector<HTMLElement>('.listener-dog-cell .watchdog-link')!
  assert.equal(live.querySelector('.watchdog-link-name')?.textContent, 'claim-b')
  assert.equal(live.classList.contains('gone'), false, 'the live claim dog')
  const past = view.el.querySelector<HTMLTableRowElement>('.slots-history tr.slot-row')!
  assert.equal(past.querySelector('.listener-dog-cell .watchdog-link-name')?.textContent, 'first-build')
  assert.equal([...view.el.querySelectorAll('.slots-table tr.slot-row')].every((r) => r.children.length === 9), true)
})

/* ─── §5 dead-letter listeners ─────────────────────────────────────────── */

test('§5 a dead-letter listener wears the sepia-maroon wherever its chip is drawn, and says what it is (user 06:41Z)', async (t) => {
  const exact = dog('event', 'boss', 'dl', { target: 'project.dead_letter' })
  const prefix = dog('event', 'boss', 'all-projects', { target: 'project.*' })
  const other = dog('event', 'boss', 'live', { target: 'agents.live' })
  const view = await mountView(<div>{[exact, prefix, other].map((w) => <WatchdogLink key={w.id} dog={w} />)}</div>, (el) => el)
  t.after(() => view.unmount())
  const chips = [...view.el.querySelectorAll('.watchdog-link')]
  assert.deepEqual(chips.map((c) => c.classList.contains('dead-letter')), [true, true, false])
  assert.match(watchdogDescription(exact).summary, /dead-letter listener/)
  assert.doesNotMatch(watchdogDescription(other).summary, /dead-letter/)
})

test('§5 which dead-letter listeners count for a project: above or below it, armed or paused, its pattern taking the project', () => {
  const dl = (owner: string, extra: Partial<Watchdog> = {}) => dog('event', owner, `dl-${owner}${extra.state ?? ''}`, { target: 'project.dead_letter', ...extra })
  const list = [
    dl('boss'), dl('sa', { state: 'paused' }), dl('carol'),
    dl('boss', { pattern: '"project":"other"', name: 'elsewhere', id: 'boss/elsewhere' }),
    dl('boss', { pattern: '"project":"sync"', name: 'mine', id: 'boss/mine' }),
    dl('boss', { pattern: '(', name: 'broken', id: 'boss/broken' }),
    dl('sb', { spent: true, state: 'spent', name: 'used', id: 'sb/used' }),
    dog('event', 'boss', 'count', { target: 'agents.live' }),
  ]
  assert.deepEqual(deadLetterListeners('sync', list, map).map((w) => w.id),
    ['boss/dl-boss', 'sa/dl-sapaused', 'boss/mine', 'boss/broken'],
    'above (boss) and below (sa), paused included; not carol, not a pattern for another project, not a spent dog; a pattern it cannot read counts')
  assert.equal(reachesProject('boss', 'sync', map), true)
  assert.equal(reachesProject('sa', 'sync', map), true)
  assert.equal(reachesProject('carol', 'sync', map), false)
  assert.equal(reachesProject('sync', 'sync', map), false)
  assert.equal(acceptsEvent('project.*', 'project.dead_letter'), true)
  assert.equal(acceptsEvent('@project.dead_letter', 'project.dead_letter'), true)
  assert.equal(acceptsEvent('project.event', 'project.dead_letter'), false)
  assert.equal(isDeadLetterListener(dog('fair_queue', 'sa', 'q', { target: 'project.dead_letter' })), false, 'only an event dog')
  assert.equal(listeningSince({ at: '2026-10-19T07:00:00.000Z', last_fired: '2026-10-19T08:00:00.000Z' }), '2026-10-19T08:00:00.000Z')
  assert.equal(listeningSince({ at: '2026-10-19T07:00:00.000Z' }), '2026-10-19T07:00:00.000Z')
})

/* ─── §6 narrow desks ──────────────────────────────────────────────────── */

test('§6 a cell that may shorten keeps its whole text in a tooltip: agent names, chips, gists and the ending word (user 2026-10-20 09:00Z)', async (t) => {
  const { view } = await mailFolder(t, ackHistory(), true)
  const rows = [...view.el.querySelectorAll<HTMLTableRowElement>(`${T} tbody tr.listener-row`)]
  assert.ok(rows.length >= 6, 'Working, the Line, the Dead Letter Line and Recently Finished')
  for (const r of rows) {
    const agent = r.querySelector<HTMLElement>('.slot-agent [data-copy-agent-name]')!
    assert.ok(agent.title.includes(agent.getAttribute('data-copy-agent-name')!), `the agent link names ${agent.textContent}`)
    const chip = r.querySelector<HTMLElement>('.listener-dog-cell .watchdog-link')
    if (chip) assert.ok(chip.title.includes(`"${chip.querySelector('.watchdog-link-name')!.textContent}"`), 'the chip names its dog')
    for (const link of r.querySelectorAll<HTMLElement>('.listener-mail-link')) assert.ok(link.title.includes(link.textContent!), 'the gist')
  }
  const words = [...view.el.querySelectorAll<HTMLElement>(`${T} .ending-word`)]
  assert.deepEqual(words.map((w) => w.title.startsWith(`${w.textContent}: `)), [true, true, true], 'the ending word leads its tooltip')
  assert.equal(words[2]!.title, 'dead letter: sb did not ack it after 2 reminders (attempt 3 of 3)')
})

test('§6 who fired an event, when it is no agent of the tree: the label keeps its whole text in a tooltip', async (t) => {
  const { view } = await firedTab(t)
  const by = fireRow(view.el, 10).querySelector<HTMLElement>('.slot-agent .fired-by')!
  assert.equal(by.textContent, '@user')
  assert.equal(by.title, '@user')
})

test("§6 a fire mail no longer there: its tooltip leads with the words a narrow desk may shorten", async (t) => {
  const { view } = await firedTab(t)
  const gone = subRows(fireRow(view.el, 12))[1]!.querySelector<HTMLElement>('.fire-mail.unavailable')!
  assert.ok(gone.title.startsWith(`${gone.textContent}: `), gone.title)
})
