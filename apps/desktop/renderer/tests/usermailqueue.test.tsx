// usermailqueue.test.tsx — the Mail tab's listeners folder lets the user join
// the project's mail queue themselves (docket
// let-the-user-manually-hold-a-number-of-a-project; USER 2026-10-20
// 13:04:56Z "also allow the user to register themselves as a mail queue
// listener", 13:22Z: a focused dialog; leaving the queue keeps a held job
// until it is acknowledged; 13:50Z: the user shows as the @user mention).
//
// WHAT THIS FILE HOLDS THE CODE TO:
//   §1 the user's fair_queue dog (owner "user") takes its turn in the Line
//      like any listener: never "not live", never "halted"; in ack mode it
//      holds its batch of jobs, which puts it behind the others
//   §2 joining moved to the desk header (usermailheader.test.tsx), so the
//      folder body offers none; only the user's own rows have "leave queue",
//      including Working when their batch is full. It sends user_queue_leave, and a held job stays in
//      Working after leaving
//   §3 the user's rows (Line, Working, Recently Finished, Recently Delivered)
//      wear the @user chip; the user's held job has no take back (they
//      acknowledge it) but opens its mail in their inbox
//   §4 nothing on the tab says "you"
//
// Run:  cd apps/desktop/renderer && node tests/run.mjs usermailqueue

import test from 'node:test'
import assert from 'node:assert/strict'
import { flush, inAct, mountView } from './harness'
import { MailListenersView, mailListenerRows } from '../src/canvas/maillisteners'
import { mailListenerState } from '../src/canvas/listeners'
import type { CanvasNode, OpRequest, OpResult } from '../src/canvas/shared'
import type { Watchdog } from '../src/types'

const refs = { world: { org: 'org' }, onOpen: () => {} } as never
const node = (extra: Record<string, unknown> = {}) =>
  ({ id: 'jobs', kind: 'project', tier: 'project', state: 'live', children: [],
    configured_scope: { mail_queue: 'ack' }, ...extra }) as unknown as CanvasNode
const dog = (owner: string, name: string, extra: Partial<Watchdog> = {}): Watchdog =>
  ({ id: owner + '/' + name, owner, name, kind: 'fair_queue', target: 'jobs', interval_s: 5, state: 'armed',
    at: '2026-10-20T07:00:00.000Z', fired: 0, once: false, spent: false, batch: 1, ...extra } as Watchdog)
const live = (id: string, extra: Record<string, unknown> = {}) =>
  ({ id, kind: 'agent', tier: 'haiku', state: 'live', halt: null, children: [], ...extra }) as unknown as CanvasNode
const agents = new Map<string, CanvasNode>([['dev', live('dev')]])   // the user is not a node of the tree

const mineDog = dog('user', 'u9abc', { name: 'user-queue', at: '2026-10-20T08:00:00.000Z' })
const devDog = dog('dev', 'jobs-queue')

/* ─── §1 the user takes a turn like any listener ────────────────────────── */

test('§1 the user\'s listener is in the Line: never not-live, never halted; it holds its batch like the rest', () => {
  const ordered = mailListenerRows(mailListenerState('jobs', [devDog, mineDog]), agents, [], true)
  const user = ordered.find((r) => r.dog.owner === 'user')!
  assert.equal(user.out, null, 'an armed user listener takes mail (the user is no tree node, and never halted)')
  assert.ok(user.position !== null, 'it has a place in the order')
  assert.deepEqual(ordered.map((r) => r.dog.owner), ['dev', 'user'], 'by the engine\'s pick: the older dog first')
  const holding = mailListenerRows(mailListenerState('jobs', [devDog, mineDog]), agents,
    [{ mail: 'm1', agent: 'user', copy: 'c1' }], true)
  const h = holding.find((r) => r.dog.owner === 'user')!
  assert.equal(h.out, 'holding', 'a user who holds a job up to their batch waits behind the others')
  assert.equal(h.holding, 1)
  const halted = mailListenerRows(mailListenerState('jobs', [devDog, mineDog]),
    new Map([['dev', live('dev', { halt: { phase: 'halted' } })]]), [], true)
  assert.equal(halted.find((r) => r.dog.owner === 'user')!.out, null, 'a halted agent is not the user')
  const paused = mailListenerRows(mailListenerState('jobs', [dog('user', 'u9abc', { state: 'paused' })]), agents, [], true)
  assert.equal(paused[0]!.out, 'paused')
})

/* ─── §2 join and leave ─────────────────────────────────────────────────── */

const history = (extra: Record<string, unknown> = {}) => ({
  project: 'jobs', ack: true, max_attempts: 3, working: [], history: [], history_next: null, ...extra,
})
function ops(requests: OpRequest[], hist: Record<string, unknown>) {
  return async (req: OpRequest): Promise<OpResult> => {
    requests.push(req)
    return (req.op === 'mail_queue_history' ? hist : { ok: true }) as unknown as OpResult
  }
}
const mount = async (dogs: Watchdog[], requests: OpRequest[], hist = history(), extra: Record<string, unknown> = {},
  onOpenMail: (id: string) => void = () => {}, toasts: string[][] = [], routes: unknown = refs) => {
  const v = await mountView(<MailListenersView node={node(extra)} state={mailListenerState('jobs', dogs)} map={agents}
    rows={[]} ack={true} onOpenMail={onOpenMail} op={ops(requests, hist)} toast={(m) => { toasts.push(m as string[]) }}
    refs={routes as never} dogs={dogs} />, (el) => el)
  await inAct(async () => { await flush(6) })
  return v
}
const setInput = (el: HTMLInputElement, value: string) => {
  Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
}
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]')
const button = (root: ParentNode, label: RegExp) => [...root.querySelectorAll<HTMLButtonElement>('button')].find((b) => label.test(b.textContent ?? ''))

test('§2 joining is the header\'s control now: the folder body offers no join button or dialog', async (t) => {
  const requests: OpRequest[] = []
  const v = await mount([devDog], requests)
  t.after(() => v.unmount())
  assert.ok(!v.el.querySelector('[data-action="join-queue"]'), 'no join button in the folder body (usermailheader.test.tsx holds the header control)')
  assert.ok(!v.el.querySelector('.user-reg-tools'), 'and no empty strip where it was')
  assert.ok(!dialog(), 'no dialog')
  assert.ok(!requests.some((r) => r.op === 'user_queue_join'))
})

test('§2 the user leaves with leave queue; a job they hold stays in Working', async (t) => {
  const requests: OpRequest[] = []
  const held = { mail: 'jm1', gist: 'Review the notes', copy: 'c1', agent: 'user', held_at: '2026-10-20T09:00:00Z', attempts: 1 }
  const v = await mount([devDog, mineDog], requests, history({ working: [held] }))
  t.after(() => v.unmount())
  assert.ok(!v.el.querySelector('[data-action="join-queue"]'), 'already in the queue')
  const leave = v.el.querySelector<HTMLButtonElement>('[data-action="leave-queue"]')!
  assert.ok(leave)
  await inAct(async () => { leave.click(); await flush(4) })
  assert.deepEqual(requests.find((r) => r.op === 'user_queue_leave'), { op: 'user_queue_leave', node: 'jobs' })
  // once left (the dog is gone from the tree) the held job still shows, and still is theirs
  const after = await mount([devDog], [], history({ working: [held] }))
  t.after(() => after.unmount())
  const working = after.el.querySelectorAll('.mail-working tr.held-job')
  assert.equal(working.length, 1, 'the held job stays in Working after leaving')
  assert.ok(!after.el.querySelector('[data-action="leave-queue"]'), 'and nothing here says leave any more')
})

for (const mode of ['waiting', 'paused', 'round-robin', 'full-batch'] as const) {
  test(`§2 ${mode}: leave is on a user row, never a redundant top button`, async (t) => {
    const requests: OpRequest[] = []
    const ack = mode !== 'round-robin'
    const held = { mail: 'jm1', copy: 'c1', agent: 'user', held_at: '2026-10-20T09:00:00Z' }
    const mine = { ...mineDog, state: mode === 'paused' ? 'paused' : 'armed' } as Watchdog
    const dogs = [devDog, mine]
    const v = await mountView(<MailListenersView node={node()} state={mailListenerState('jobs', dogs)} map={agents}
      rows={[]} ack={ack} refs={refs} dogs={dogs}
      op={ops(requests, history({ ack, working: mode === 'full-batch' ? [held] : [] }))} />, (el) => el)
    t.after(() => v.unmount())
    await inAct(async () => { await flush(6) })
    const leaves = [...v.el.querySelectorAll<HTMLButtonElement>('[data-action="leave-queue"]')]
    assert.equal(leaves.length, 1, 'one row-local leave action, without the extra top button')
    const leave = leaves[0]!
    const row = leave.closest('tr.listener-row')
    assert.ok(row, 'leave is part of a listener row')
    assert.equal(row.querySelector('.slot-agent .ref-chip.ref-mail')?.textContent, '@user')
    assert.equal(leave.getAttribute('aria-label'), 'leave queue')
    assert.equal(leave.textContent, '', 'icon-only, with its words in the accessible name and tooltip')
    assert.ok(leave.querySelector('svg'))
    assert.match(leave.title, /a job already held stays held until it is acknowledged/)
    assert.ok(!v.el.querySelector('.user-reg-tools'), 'no redundant toolbar')
    if (mode === 'full-batch') {
      assert.ok(row.closest('.mail-working'), 'a full ACK batch is in Working, outside Line')
      assert.ok(row.querySelector('[data-action="open-job"]'), 'open mail remains beside leave')
    }
    await inAct(async () => { leave.click(); await flush(4) })
    assert.deepEqual(requests.filter((r) => r.op === 'user_queue_leave'), [{ op: 'user_queue_leave', node: 'jobs' }])
  })
}

/* ─── §3 the rows ───────────────────────────────────────────────────────── */

test('§3 the user\'s rows wear the @user chip; their held job opens its mail, with no take back', async (t) => {
  const opened: string[] = []
  const held = { mail: 'jm1', gist: 'Review the notes', copy: 'c1', agent: 'user', held_at: '2026-10-20T09:00:00Z', attempts: 1,
    dog: { id: 'user/u9abc', owner: 'user', name: 'user-queue', kind: 'fair_queue', once: false, state: 'armed', gone: false } }
  const theirs = { mail: 'jm2', gist: 'Compile', copy: 'c2', agent: 'dev', held_at: '2026-10-20T09:05:00Z', attempts: 1 }
  const finished = [{ id: 5, mail: 'jm0', copy: 'c0', agent: 'user', how: 'acked', held_at: '2026-10-20T08:00:00Z', ended_at: '2026-10-20T08:30:00Z',
    ack: 'a1', ack_gist: 'Done', gist: 'Earlier job', dog: held.dog }]
  const routes = { world: { org: 'org' }, onOpen: (r: { ref: { id: string; box?: string } }) => { opened.push(`${r.ref.box}:${r.ref.id}`) } }
  // a batch of two: the user holds one job and still takes mail, so their row is in the Line as well as in Working
  const v = await mount([devDog, { ...mineDog, batch: 2 }], [], history({ working: [held, theirs], history: finished }), {}, () => {}, [], routes)
  t.after(() => v.unmount())
  const working = [...v.el.querySelectorAll('.mail-working tr.held-job')]
  assert.equal(working.length, 2)
  const mine = working.find((r) => r.querySelector('.slot-agent .ref-chip.ref-mail'))!
  assert.equal(mine.querySelector('.slot-agent .ref-chip.ref-mail')!.textContent, '@user')
  assert.ok(!mine.querySelector('[data-action="take-back"]'), 'the user\'s own job is acknowledged, never taken back')
  const open = mine.querySelector<HTMLButtonElement>('[data-action="open-job"]')!
  assert.ok(open, 'an open mail control instead')
  await inAct(async () => { open.click() })
  assert.deepEqual(opened, ['user:c1'], 'it opens the user\'s copy of the job in the user\'s inbox, not the project\'s mailbox')
  const other = working.find((r) => r !== mine)!
  assert.ok(other.querySelector('[data-action="take-back"]'), 'an agent\'s job keeps its take back')
  const line = [...v.el.querySelectorAll('.mail-line tr.listener-row')]
  assert.ok(line.some((r) => r.querySelector('.slot-agent .ref-chip.ref-mail')?.textContent === '@user'), 'the Line row')
  assert.ok(line.find((r) => r.querySelector('[data-action="leave-queue"]')), 'the leave control is on the user\'s own row')
  const done = v.el.querySelector('.mail-history tr.finished')!
  assert.equal(done.querySelector('.slot-agent .ref-chip.ref-mail')?.textContent, '@user', 'Recently Finished')
})

test('§3 round-robin deliveries to the user wear the chip too', async (t) => {
  const delivered = [{ id: 9, copy: 'c9', agent: 'user', mail: 'jm9', gist: 'A job', held_at: '2026-10-20T09:00:00Z' }]
  const v = await mountView(<MailListenersView node={node({ configured_scope: {} })} state={mailListenerState('jobs', [mineDog])} map={agents}
    rows={[]} ack={false} op={ops([], { project: 'jobs', ack: false, history: delivered, history_next: null })} toast={() => {}} refs={refs} dogs={[mineDog]} />, (el) => el)
  t.after(() => v.unmount())
  await inAct(async () => { await flush(6) })
  assert.equal(v.el.querySelector('.mail-history tr.delivered .slot-agent .ref-chip.ref-mail')?.textContent, '@user')
})

test('§3 Working actions are compact named icons in one group and keep open/leave routing', async (t) => {
  const requests: OpRequest[] = [], opened: string[] = []
  const held = { mail: 'jm1', gist: 'Review', copy: 'c1', agent: 'user', held_at: '2026-10-20T09:00:00Z' }
  const routes = { world: { org: 'org' }, onOpen: (r: { ref: { id: string; box?: string } }) => opened.push(`${r.ref.box}:${r.ref.id}`) }
  const v = await mount([mineDog], requests, history({ working: [held] }), {}, () => {}, [], routes)
  t.after(() => v.unmount())
  const group = v.el.querySelector('.held-job .listener-user-actions')
  assert.ok(group, 'the two actions share a no-wrap icon group')
  const open = group.querySelector<HTMLButtonElement>('[data-action="open-job"]')!
  const leave = group.querySelector<HTMLButtonElement>('[data-action="leave-queue"]')!
  for (const [action, label] of [[open, 'open mail'], [leave, 'leave queue']] as const) {
    assert.equal(action.getAttribute('aria-label'), label)
    assert.ok(action.title.includes(label))
    // Coordinator 2026-10-21 07:22Z: icon action label prefixes shared mail identity.
    if (action === open) {
      assert.equal(action.getAttribute('data-object-nav'), 'mail')
      assert.equal(action.getAttribute('data-object-id'), 'c1')
      assert.equal(action.getAttribute('data-mail-box'), 'user')
      assert.equal(action.getAttribute('data-mail-action-label'), label)
    }
    assert.ok(action.classList.contains('iconbtn'))
    assert.ok(action.querySelector('svg'))
    assert.equal(action.textContent, '')
  }
  await inAct(async () => { open.click(); leave.click(); await flush(4) })
  assert.deepEqual(opened, ['user:c1'])
  assert.deepEqual(requests.filter((r) => r.op === 'user_queue_leave'), [{ op: 'user_queue_leave', node: 'jobs' }])
})

test('§4 nothing on the tab says "you"', async (t) => {
  const held = { mail: 'jm1', gist: 'Review', copy: 'c1', agent: 'user', held_at: '2026-10-20T09:00:00Z', attempts: 1 }
  const v = await mount([devDog, mineDog], [], history({ working: [held] }))
  t.after(() => v.unmount())
  assert.ok(!/\byou\b/i.test(v.el.textContent ?? ''), v.el.textContent?.match(/.{20}\byou\b.{20}/i)?.[0])
})
