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
//   §2 "Join mail queue…" opens a focused dialog (a batch of 1 to 20) and
//      sends user_queue_join; the user's own row has "leave queue", which
//      sends user_queue_leave, and a held job stays in Working after leaving
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
  onOpenMail: (id: string) => void = () => {}, toasts: string[][] = []) => {
  const v = await mountView(<MailListenersView node={node(extra)} state={mailListenerState('jobs', dogs)} map={agents}
    rows={[]} ack={true} onOpenMail={onOpenMail} op={ops(requests, hist)} toast={(m) => { toasts.push(m as string[]) }}
    refs={refs} dogs={dogs} />, (el) => el)
  await inAct(async () => { await flush(6) })
  return v
}
const setInput = (el: HTMLInputElement, value: string) => {
  Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
}
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]')
const button = (root: ParentNode, label: RegExp) => [...root.querySelectorAll<HTMLButtonElement>('button')].find((b) => label.test(b.textContent ?? ''))

test('§2 Join mail queue opens a dialog (batch 1 to 20) and sends user_queue_join', async (t) => {
  const requests: OpRequest[] = []
  const toasts: string[][] = []
  const v = await mount([devDog], requests, history(), {}, () => {}, toasts)
  t.after(() => v.unmount())
  const open = v.el.querySelector<HTMLButtonElement>('[data-action="join-queue"]')!
  assert.ok(open, 'offered while the user is not in the queue')
  assert.match(open.textContent ?? '', /Join mail queue/)
  await inAct(async () => { open.click() })
  const box = dialog()!
  const batch = box.querySelector<HTMLInputElement>('input[type="number"]')!
  assert.equal(batch.min, '1')
  assert.equal(batch.max, '20')
  assert.match(box.textContent ?? '', /inbox/, 'jobs arrive in the inbox')
  assert.match(box.textContent ?? '', /acknowledge/i, 'ACK mode: each job is acknowledged')
  for (const bad of ['0', '21', '', '2.5']) {
    await inAct(async () => { setInput(batch, bad) })
    assert.equal(button(box, /^Join mail queue$/)!.disabled, true, `"${bad}" cannot be sent`)
  }
  await inAct(async () => { setInput(batch, '2') })
  await inAct(async () => { button(box, /^Join mail queue$/)!.click(); await flush(4) })
  assert.deepEqual(requests.find((r) => r.op === 'user_queue_join'), { op: 'user_queue_join', node: 'jobs', batch: 2 })
  assert.ok(toasts.length > 0)
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
  assert.ok(after.el.querySelector<HTMLButtonElement>('[data-action="join-queue"]'), 'and they may join again')
})

/* ─── §3 the rows ───────────────────────────────────────────────────────── */

test('§3 the user\'s rows wear the @user chip; their held job opens its mail, with no take back', async (t) => {
  const opened: string[] = []
  const held = { mail: 'jm1', gist: 'Review the notes', copy: 'c1', agent: 'user', held_at: '2026-10-20T09:00:00Z', attempts: 1,
    dog: { id: 'user/u9abc', owner: 'user', name: 'user-queue', kind: 'fair_queue', once: false, state: 'armed', gone: false } }
  const theirs = { mail: 'jm2', gist: 'Compile', copy: 'c2', agent: 'dev', held_at: '2026-10-20T09:05:00Z', attempts: 1 }
  const finished = [{ id: 5, mail: 'jm0', copy: 'c0', agent: 'user', how: 'acked', held_at: '2026-10-20T08:00:00Z', ended_at: '2026-10-20T08:30:00Z',
    ack: 'a1', ack_gist: 'Done', gist: 'Earlier job', dog: held.dog }]
  const v = await mount([devDog, mineDog], [], history({ working: [held, theirs], history: finished }), {}, (id) => opened.push(id))
  t.after(() => v.unmount())
  const working = [...v.el.querySelectorAll('.mail-working tr.held-job')]
  assert.equal(working.length, 2)
  const mine = working.find((r) => r.querySelector('.slot-agent .ref-chip'))!
  assert.equal(mine.querySelector('.slot-agent .ref-chip')!.textContent, '@user')
  assert.ok(!mine.querySelector('[data-action="take-back"]'), 'the user\'s own job is acknowledged, never taken back')
  const open = mine.querySelector<HTMLButtonElement>('[data-action="open-job"]')!
  assert.ok(open, 'an open mail control instead')
  await inAct(async () => { open.click() })
  assert.deepEqual(opened, ['c1'], 'it opens the user\'s copy of the job in their inbox')
  const other = working.find((r) => r !== mine)!
  assert.ok(other.querySelector('[data-action="take-back"]'), 'an agent\'s job keeps its take back')
  const line = [...v.el.querySelectorAll('.mail-line tr.listener-row')]
  assert.ok(line.some((r) => r.querySelector('.slot-agent .ref-chip')?.textContent === '@user'), 'the Line row')
  assert.ok(line.find((r) => r.querySelector('[data-action="leave-queue"]')), 'the leave control is on the user\'s own row')
  const done = v.el.querySelector('.mail-history tr.finished')!
  assert.equal(done.querySelector('.slot-agent .ref-chip')?.textContent, '@user', 'Recently Finished')
})

test('§3 round-robin deliveries to the user wear the chip too', async (t) => {
  const delivered = [{ id: 9, copy: 'c9', agent: 'user', mail: 'jm9', gist: 'A job', held_at: '2026-10-20T09:00:00Z' }]
  const v = await mountView(<MailListenersView node={node({ configured_scope: {} })} state={mailListenerState('jobs', [mineDog])} map={agents}
    rows={[]} ack={false} op={ops([], { project: 'jobs', ack: false, history: delivered, history_next: null })} toast={() => {}} refs={refs} dogs={[mineDog]} />, (el) => el)
  t.after(() => v.unmount())
  await inAct(async () => { await flush(6) })
  assert.equal(v.el.querySelector('.mail-history tr.delivered .slot-agent .ref-chip')?.textContent, '@user')
})

test('§4 nothing on the tab says "you"', async (t) => {
  const held = { mail: 'jm1', gist: 'Review', copy: 'c1', agent: 'user', held_at: '2026-10-20T09:00:00Z', attempts: 1 }
  const v = await mount([devDog, mineDog], [], history({ working: [held] }))
  t.after(() => v.unmount())
  assert.ok(!/\byou\b/i.test(v.el.textContent ?? ''), v.el.textContent?.match(/.{20}\byou\b.{20}/i)?.[0])
  const solo = await mount([devDog], [])
  t.after(() => solo.unmount())
  await inAct(async () => { solo.el.querySelector<HTMLButtonElement>('[data-action="join-queue"]')!.click() })
  assert.ok(!/\byou\b/i.test(dialog()?.textContent ?? ''), 'nor does its dialog')
})
