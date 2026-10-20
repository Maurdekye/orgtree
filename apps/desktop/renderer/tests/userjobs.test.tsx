// userjobs.test.tsx — a job the project's mail queue hands the USER is read
// and acknowledged from their inbox (docket
// let-the-user-manually-hold-a-number-of-a-project; USER 2026-10-20 13:04:56Z
// "queued jobs dispatched to the user arrive as normal mail in their inbox,
// and the user can acknowledge them", 13:22Z layout B: "Reply & acknowledge"
// is the main action on a queued job, acknowledge without a reply the
// secondary; a held job is kept until it is acknowledged).
//
// WHAT THIS FILE HOLDS THE CODE TO:
//   §1 an inbox row that is a project job in an ack-mode queue, not yet
//      acknowledged, offers the acknowledge pane beside its text: the warning
//      that reading does not acknowledge, a reply box, "Reply & acknowledge"
//      (needs a reply) and "Acknowledge without reply"; the pane hands the
//      host the reply text (or none)
//   §2 an acknowledged job says so and offers no more; a job of a
//      round-robin queue, or an inbox with no acknowledge handler, shows the
//      ordinary reply box and no pane
//   §3 a failed acknowledgement keeps what was typed and says why
//   §4 the helper the user's inbox uses: it sends the reply first, as a
//      reply to the job's mail, then acknowledges with that reply's id; with
//      no reply it only acknowledges; a failed reply acknowledges nothing
//
// Run:  cd apps/desktop/renderer && node tests/run.mjs userjobs

import test from 'node:test'
import assert from 'node:assert/strict'
import { flush, inAct, mountView } from './harness'
import { MailList } from '../src/canvas/mail'
import { acknowledgeJob } from '../src/canvas/jobacks'
import type { MailRow } from '../src/canvas/shared'

const row = (job: Record<string, unknown> | null, extra: Partial<MailRow> = {}): MailRow => ({
  id: 'c1', from: 'boss', to: 'user', at: '2026-10-20T09:00:00.000Z', kind: 'message', body: 'Review the release notes', read: true,
  ...(job ? { queue: { job } } : {}), ...extra,
} as unknown as MailRow)
const JOB = { id: 7, name: 'jobs', mail: 'jm1', ack: true }

const setText = (el: HTMLTextAreaElement, value: string) => {
  Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
}
const button = (root: ParentNode, label: RegExp) => [...root.querySelectorAll<HTMLButtonElement>('button')].find((b) => label.test(b.textContent ?? ''))
async function mount(rows: MailRow[], handlers: { onAckJob?: (m: MailRow, reply?: string) => Promise<unknown> } = {}) {
  const v = await mountView(<MailList org="org" delivered={rows} onReply={() => {}} {...handlers} refs={{ world: { org: 'org' }, onOpen: () => {} } as never} />, (el) => el)
  await inAct(async () => { v.el.querySelector<HTMLElement>('.mailrow')!.click(); await flush(4) })
  return v
}

test('§1 an unacknowledged ack-mode job offers Reply & acknowledge and Acknowledge without reply', async (t) => {
  const calls: [string, string | undefined][] = []
  const v = await mount([row(JOB)], { onAckJob: async (m, reply) => { calls.push([m.id!, reply]) } })
  t.after(() => v.unmount())
  const pane = v.el.querySelector<HTMLElement>('.job-ack')!
  assert.ok(pane, 'the acknowledge pane')
  assert.match(pane.textContent ?? '', /Reading it does not acknowledge it/)
  assert.match(v.el.querySelector('.mailer-head')?.textContent ?? '', /project job.*jobs|jobs.*project job/i, 'the header says it is a project job')
  const box = pane.querySelector<HTMLTextAreaElement>('textarea')!
  const withReply = button(pane, /^Reply & acknowledge$/)!
  const without = button(pane, /^Acknowledge without reply$/)!
  assert.ok(withReply && without)
  assert.ok(withReply.classList.contains('primary'), 'Reply & acknowledge is the main action')
  assert.ok(!without.classList.contains('primary'))
  assert.equal(withReply.disabled, true, 'it needs a reply')
  assert.equal(without.disabled, false)
  await inAct(async () => { setText(box, 'Reviewed: reads well.') })
  assert.equal(withReply.disabled, false)
  await inAct(async () => { withReply.click(); await flush(4) })
  assert.deepEqual(calls, [['c1', 'Reviewed: reads well.']])
  assert.ok(!v.el.querySelector('.mail-reply'), 'the ordinary reply box does not sit beside it')
})

test('§1 Acknowledge without reply sends no reply', async (t) => {
  const calls: [string, string | undefined][] = []
  const v = await mount([row(JOB)], { onAckJob: async (m, reply) => { calls.push([m.id!, reply]) } })
  t.after(() => v.unmount())
  await inAct(async () => { button(v.el.querySelector('.job-ack')!, /^Acknowledge without reply$/)!.click(); await flush(4) })
  assert.deepEqual(calls, [['c1', undefined]])
})

test('§2 an acknowledged job says so and offers nothing more', async (t) => {
  const v = await mount([row({ ...JOB, acked_at: '2026-10-20T09:30:00Z' })], { onAckJob: async () => {} })
  t.after(() => v.unmount())
  assert.ok(!v.el.querySelector('.job-ack textarea'), 'no reply box, no buttons')
  assert.match(v.el.querySelector('.job-ack')?.textContent ?? '', /acknowledged/i)
  assert.ok(!button(v.el, /^Reply & acknowledge$/))
})

test('§2 a round-robin job, or an inbox with no acknowledge handler, keeps the ordinary reply box', async (t) => {
  const roundRobin = await mount([row({ ...JOB, ack: false })], { onAckJob: async () => {} })
  t.after(() => roundRobin.unmount())
  assert.ok(!roundRobin.el.querySelector('.job-ack'), 'nothing to acknowledge in a round-robin queue')
  assert.ok(roundRobin.el.querySelector('.mail-reply'), 'the ordinary reply box')
  const plain = await mount([row(JOB)])
  t.after(() => plain.unmount())
  assert.ok(!plain.el.querySelector('.job-ack'), 'an inbox that cannot acknowledge shows no pane')
  assert.ok(plain.el.querySelector('.mail-reply'))
  const ordinary = await mount([row(null)], { onAckJob: async () => {} })
  t.after(() => ordinary.unmount())
  assert.ok(!ordinary.el.querySelector('.job-ack'), 'ordinary mail is not a job')
})

test('§3 a failed acknowledgement keeps the reply and says why', async (t) => {
  const v = await mount([row(JOB)], { onAckJob: async () => { throw new Error('mail c1 is not held by you any more') } })
  t.after(() => v.unmount())
  const pane = v.el.querySelector<HTMLElement>('.job-ack')!
  const box = pane.querySelector<HTMLTextAreaElement>('textarea')!
  await inAct(async () => { setText(box, 'my reply') })
  await inAct(async () => { button(pane, /^Reply & acknowledge$/)!.click(); await flush(4) })
  assert.equal(box.value, 'my reply', 'the draft survives')
  assert.match(pane.querySelector('[role="alert"]')?.textContent ?? '', /not held/)
})

/* ─── §4 the helper behind the user's inbox ─────────────────────────────── */

test('§4 acknowledging with a reply sends the reply first, then acknowledges with its id', async () => {
  const log: string[] = []
  await acknowledgeJob({
    row: row(JOB), reply: 'Done.',
    sendReply: async (m, text) => { log.push(`reply ${m.id} ${text}`); return { id: 'r9' } },
    ack: async (copy, reply) => { log.push(`ack ${copy} ${reply}`) },
  })
  assert.deepEqual(log, ['reply c1 Done.', 'ack c1 r9'])
})

test('§4 acknowledging without a reply only acknowledges', async () => {
  const log: string[] = []
  await acknowledgeJob({
    row: row(JOB), reply: undefined,
    sendReply: async () => { log.push('reply'); return { id: 'x' } },
    ack: async (copy, reply) => { log.push(`ack ${copy} ${reply}`) },
  })
  assert.deepEqual(log, ['ack c1 undefined'])
})

test('§4 a reply that fails acknowledges nothing', async () => {
  const log: string[] = []
  await assert.rejects(acknowledgeJob({
    row: row(JOB), reply: 'Done.',
    sendReply: async () => { throw new Error('offline') },
    ack: async () => { log.push('ack') },
  }), /offline/)
  assert.deepEqual(log, [])
})
