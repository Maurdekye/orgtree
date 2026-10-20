// userjobs.test.tsx — a job the project's mail queue hands the USER is read
// and acknowledged from their inbox (docket
// let-the-user-manually-hold-a-number-of-a-project; USER 2026-10-20 13:04:56Z
// "queued jobs dispatched to the user arrive as normal mail in their inbox,
// and the user can acknowledge them", 13:22Z layout B: "Reply & acknowledge"
// is the main action on a queued job, acknowledge without a reply the
// secondary; a held job is kept until it is acknowledged).
// USER 2026-10-20 18:26:29Z (docket project-queue-ack-mail-reply-ui-should-match-the):
// "this reply ui for ack mails should look similar to normal mail reply uis" —
// the pane's reply box IS the ordinary MailReplyBox (placeholder "reply to
// <sender>…", notice and attach buttons on the left, the send button on the
// right), its send button reading "reply & acknowledge".
//
// WHAT THIS FILE HOLDS THE CODE TO:
//   §1 an inbox row that is a project job in an ack-mode queue, not yet
//      acknowledged, offers the acknowledge pane beside its text: the warning
//      that reading does not acknowledge, the ordinary reply composer whose
//      send also acknowledges, and "Acknowledge without reply" in the same
//      visual style; the pane hands the host the reply text (or none), the
//      staged attachments and the notice choice
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
type AckHandler = (m: MailRow, reply?: string, opts?: { attachments?: string[]; notice?: boolean }) => Promise<unknown>
async function mount(rows: MailRow[], handlers: { onAckJob?: AckHandler } = {}) {
  const v = await mountView(<MailList org="org" delivered={rows} onReply={() => {}} {...handlers} refs={{ world: { org: 'org' }, onOpen: () => {} } as never} />, (el) => el)
  await inAct(async () => { v.el.querySelector<HTMLElement>('.mailrow')!.click(); await flush(4) })
  return v
}

test('§1 an unacknowledged ack-mode job offers the ordinary reply composer and Acknowledge without reply', async (t) => {
  const calls: unknown[][] = []
  const v = await mount([row(JOB)], { onAckJob: async (m, reply, opts) => { calls.push([m.id!, reply, opts?.notice ?? false, opts?.attachments]) } })
  t.after(() => v.unmount())
  const pane = v.el.querySelector<HTMLElement>('.job-ack')!
  assert.ok(pane, 'the acknowledge pane')
  assert.match(pane.textContent ?? '', /Reading it does not acknowledge it/)
  assert.match(v.el.querySelector('.mailer-head')?.textContent ?? '', /project job.*jobs|jobs.*project job/i, 'the header says it is a project job')
  // the SAME composer as an ordinary reply: one .mail-reply, inside the pane, with its notice and attach buttons
  assert.equal(v.el.querySelectorAll('.mail-reply').length, 1, 'exactly one reply box')
  const box = pane.querySelector<HTMLElement>('.mail-reply')!
  assert.ok(box, 'the reply box is the ordinary composer, inside the pane')
  const ta = box.querySelector<HTMLTextAreaElement>('textarea')!
  assert.equal(ta.placeholder, 'reply to boss…', 'the ordinary placeholder, naming the sender')
  assert.ok(box.querySelector('.cc-btnstack .cc-notice-toggle'), 'the notice (bell) button on the left')
  assert.ok(box.querySelector('.cc-btnstack .cc-attach'), 'the attach button on the left')
  const send = box.querySelector<HTMLButtonElement>('.mail-reply-send')!
  assert.ok(send, 'the send button on the right, the ordinary one')
  assert.match(send.textContent ?? '', /^reply & acknowledge$/, 'it says the reply also acknowledges')
  assert.equal(send.disabled, true, 'it needs a reply')
  const without = button(pane, /^Acknowledge without reply$/)!
  assert.ok(without, 'the secondary action stays')
  assert.ok(!pane.querySelector('textarea:not(.mail-reply textarea)'), 'no second, plain textarea')
  assert.ok(!without.classList.contains('primary'))
  assert.equal(without.disabled, false)
  await inAct(async () => { setText(ta, 'Reviewed: reads well.') })
  assert.equal(send.disabled, false)
  await inAct(async () => { send.click(); await flush(4) })
  assert.deepEqual(calls, [['c1', 'Reviewed: reads well.', false, undefined]])
})

test('§1 the notice toggle reaches the host with the reply', async (t) => {
  const calls: unknown[][] = []
  const v = await mount([row(JOB)], { onAckJob: async (m, reply, opts) => { calls.push([m.id!, reply, opts?.notice ?? false]) } })
  t.after(() => v.unmount())
  const pane = v.el.querySelector<HTMLElement>('.job-ack')!
  await inAct(async () => { pane.querySelector<HTMLButtonElement>('.cc-notice-toggle')!.click() })
  assert.ok(pane.querySelector('.mail-reply.notice-armed'), 'armed, as the ordinary box shows it')
  await inAct(async () => { setText(pane.querySelector<HTMLTextAreaElement>('textarea')!, 'fyi') })
  await inAct(async () => { pane.querySelector<HTMLButtonElement>('.mail-reply-send')!.click(); await flush(4) })
  assert.deepEqual(calls, [['c1', 'fyi', true]])
})

test('§1 Acknowledge without reply sends no reply', async (t) => {
  const calls: unknown[][] = []
  const v = await mount([row(JOB)], { onAckJob: async (m, reply) => { calls.push([m.id!, reply]) } })
  t.after(() => v.unmount())
  await inAct(async () => { button(v.el.querySelector('.job-ack')!, /^Acknowledge without reply$/)!.click(); await flush(4) })
  assert.deepEqual(calls, [['c1', undefined]])
})

test('§1 Acknowledge without reply is styled with the composer, not as a second big form', async (t) => {
  const v = await mount([row(JOB)], { onAckJob: async () => {} })
  t.after(() => v.unmount())
  const pane = v.el.querySelector<HTMLElement>('.job-ack')!
  const without = button(pane, /^Acknowledge without reply$/)!
  assert.ok(without.classList.contains('job-ack-skip'), 'its own class, for the composer-matching style')
  assert.ok(!pane.querySelector('.job-ack-actions'), 'the old two-big-buttons row is gone')
})

test('§2 an acknowledged job says so and offers nothing more', async (t) => {
  const v = await mount([row({ ...JOB, acked_at: '2026-10-20T09:30:00Z' })], { onAckJob: async () => {} })
  t.after(() => v.unmount())
  assert.ok(!v.el.querySelector('.job-ack textarea'), 'no reply box, no buttons')
  assert.match(v.el.querySelector('.job-ack')?.textContent ?? '', /acknowledged/i)
  assert.ok(!button(v.el, /^reply & acknowledge$/))
})

test('§2 a round-robin job, or an inbox with no acknowledge handler, keeps the ordinary reply box', async (t) => {
  const roundRobin = await mount([row({ ...JOB, ack: false })], { onAckJob: async () => {} })
  t.after(() => roundRobin.unmount())
  assert.ok(!roundRobin.el.querySelector('.job-ack'), 'nothing to acknowledge in a round-robin queue')
  assert.ok(roundRobin.el.querySelector('.mail-reply'), 'the ordinary reply box')
  assert.match(roundRobin.el.querySelector('.mail-reply-send')?.textContent ?? '', /^reply$/)
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
  await inAct(async () => { pane.querySelector<HTMLButtonElement>('.mail-reply-send')!.click(); await flush(4) })
  assert.equal(box.value, 'my reply', 'the draft is back in the box')
  assert.match(pane.querySelector('[role="alert"]')?.textContent ?? '', /not held/)
})

test('§3 a failed Acknowledge without reply says why', async (t) => {
  const v = await mount([row(JOB)], { onAckJob: async () => { throw new Error('mail c1 is not held by you any more') } })
  t.after(() => v.unmount())
  const pane = v.el.querySelector<HTMLElement>('.job-ack')!
  await inAct(async () => { button(pane, /^Acknowledge without reply$/)!.click(); await flush(4) })
  assert.match(pane.querySelector('[role="alert"]')?.textContent ?? '', /not held/)
  assert.equal(button(pane, /^Acknowledge without reply$/)!.disabled, false, 'and it can be tried again')
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

test('§4 the reply carries its attachments and notice choice', async () => {
  const seen: unknown[] = []
  await acknowledgeJob({
    row: row(JOB), reply: 'Done.', attachments: ['uploads/a.png'], notice: true,
    sendReply: async (_m, _text, opts) => { seen.push(opts); return { id: 'r9' } },
    ack: async () => {},
  })
  assert.deepEqual(seen, [{ attachments: ['uploads/a.png'], notice: true }])
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

for (const sender of ['@user', 'user']) {
  test(`§5 a job sent by ${sender} offers honest acknowledgement without a reply composer`, async (t) => {
    const calls: unknown[][] = []
    const v = await mount([row(JOB, { from: sender })], { onAckJob: async (m, reply) => { calls.push([m.id, reply]) } })
    t.after(() => v.unmount())
    const pane = v.el.querySelector('.job-ack')!
    assert.ok(!v.el.querySelector('.mail-reply'), 'no text or attachment entry that cannot be sent or saved')
    assert.match(pane.textContent ?? '', /sent by you/i)
    assert.match(pane.textContent ?? '', /no reply/i)
    const ack = pane.querySelector<HTMLButtonElement>('[data-action="ack"]')!
    assert.equal(ack.textContent, 'Acknowledge job')
    await inAct(async () => { ack.click(); await flush(4) })
    assert.deepEqual(calls, [['c1', undefined]])
  })

  test(`§5 legacy typed self-reply to ${sender} never sends mail and still acknowledges`, async () => {
    const calls: unknown[][] = []
    await acknowledgeJob({ row: row(JOB, { from: sender }), reply: 'Done.', attachments: ['note.txt'], notice: true,
      sendReply: async () => { throw new Error('no agent named @user') },
      ack: async (copy, replyId) => { calls.push([copy, replyId]) },
    })
    assert.deepEqual(calls, [['c1', undefined]])
  })
}

test('§5 self-job acknowledgement failure is visible and can be retried', async (t) => {
  let attempts = 0
  const v = await mount([row(JOB, { from: '@user' })], { onAckJob: async () => {
    if (++attempts === 1) throw new Error('job no longer available')
  } })
  t.after(() => v.unmount())
  const ack = v.el.querySelector<HTMLButtonElement>('.job-ack [data-action="ack"]')!
  await inAct(async () => { ack.click(); await flush(4) })
  assert.match(v.el.querySelector('.job-ack [role="alert"]')?.textContent ?? '', /job no longer available/)
  assert.equal(ack.disabled, false)
  await inAct(async () => { ack.click(); await flush(4) })
  assert.equal(attempts, 2)
  assert.ok(!v.el.querySelector('.job-ack [role="alert"]'))
})

test('§5 external jobs still send their reply with its options before acknowledging', async () => {
  const calls: unknown[][] = [], m = row(JOB, { from: '@net:outside' })
  await acknowledgeJob({ row: m, reply: 'Reviewed.', attachments: ['note.txt'], notice: true,
    sendReply: async (source, text, opts) => { calls.push(['reply', source.from, text, opts]); return { id: 'external-reply' } },
    ack: async (copy, replyId) => { calls.push(['ack', copy, replyId]) },
  })
  assert.deepEqual(calls, [['reply', '@net:outside', 'Reviewed.', { attachments: ['note.txt'], notice: true }], ['ack', 'c1', 'external-reply']])
})
