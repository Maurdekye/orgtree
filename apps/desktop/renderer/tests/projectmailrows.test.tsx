// projectmailrows.test.tsx — a project mail's LIST ROW (user 2026-10-18
// 14:24Z, docket project-inbox-list-rows-kind-tags-and-delivered-t: "mail
// tags are heavily compressed and wrapped here ... maybe a third row of
// content per mail item in the list for project mail is necessary?").
//
// WHAT THIS FILE HOLDS THE CODE TO:
//   §1 a row with a project queue state takes three lines: sender and time,
//      then its kind chip and queue state, then the preview;
//   §2 every queue state uses that line, and an urgent chip moves with the kind;
//   §3 the Sent folder's row for mail to a project is the same row;
//   §4 rows without a queue state (every other mailbox) keep their two lines;
//   §5 in a project's own mailbox a mail nobody holds yet uses the meta line too;
//   §6 the project desk's inbox tab is that mailbox.
// The geometry (no wrapped name, no stretched chip) is checked in real
// Chromium by projectdelivery-visual.mjs.
//
// Run:  cd apps/desktop/renderer && node tests/run.mjs projectmailrows

import test from 'node:test'
import assert from 'node:assert/strict'
import { FakeServer, flush, inAct, installFetch, mountView } from './harness'
import { MailList } from '../src/canvas/mail'
import { ProjectDesk } from '../src/canvas/projectdesk'
import type { CanvasNode, MailRow, OpResult } from '../src/canvas/shared'
import type { TreePayload } from '../src/types'

const ev = (variant: string, from: string, body: string) =>
  ({ v: 1, variant, actor: { kind: 'agent', id: from }, object: null, engine_authored: false, body })
const question: MailRow = {
  id: 'q1', from: 'hubchat-jumplist-sol', kind: 'question', at: '2026-10-18T12:00:00Z',
  ev: ev('ordinary.question', 'hubchat-jumplist-sol', 'Please check the project item.'),
  body: 'Please check the project item.', queue: { held_by: 'coordinator-opus', ack: false },
}
const classes = (el: Element | null) => [...(el?.children ?? [])].map((c) => c.className)
/** an element's words without its model cards' letters: since the user's
 *  2026-10-18 17:01Z ruling the recipient wears its card, as the sender does */
const words = (el: Element | null | undefined) => {
  const copy = el?.cloneNode(true) as Element | undefined
  copy?.querySelectorAll('.tier').forEach((c) => c.remove())
  return copy?.textContent
}
const only = async (rows: MailRow[], extra: Partial<Parameters<typeof MailList>[0]> = {}) => {
  const v = await mountView(<MailList delivered={rows} hasAgent={() => true} onFocusAgent={() => {}}
    tierOf={() => 'sol'} {...extra} />, (el) => el)
  return { v, rows: [...v.el.querySelectorAll<HTMLElement>('.mailrow')] }
}

/* ─── §1 three lines ─────────────────────────────────────────────────────── */

test('§1 a project mail row gives its kind and queue state a line of their own', async (t) => {
  const { v, rows: [row] } = await only([question])
  t.after(() => v.unmount())
  assert.ok(row, 'positive control: the row renders')
  assert.deepEqual(classes(row!), ['l1', 'lmeta', 'l2'], 'who and when, then kind and queue, then the preview')
  assert.ok(row!.classList.contains('project-mail'), 'the row says it carries a queue state')
  assert.deepEqual(classes(row!.querySelector(':scope > .l1')), ['mfrom', 'mtime'], 'line 1 holds only the sender and the time')
  const meta = row!.querySelector(':scope > .lmeta')
  assert.deepEqual(classes(meta), ['event-row-kind', 'queuekind queue-delivery'], 'kind chip, then the delivery marker')
  assert.equal(words(meta), 'Question→@coordinator-opus')
  assert.ok(meta?.querySelector('button[data-agent-nav="coordinator-opus"]'), 'the recipient keeps the shared agent link')
  assert.ok(meta?.querySelector('.queue-delivery .tier.t-sol'), 'and wears its model card')
  assert.equal(row!.querySelector(':scope > .l2')?.textContent, 'Please check the project item.')
})

/* ─── §2 every queue state ───────────────────────────────────────────────── */

test('§2 every queue state sits on the meta line, never beside the sender', async (t) => {
  const cases: [MailRow['queue'], string][] = [
    [{ held_by: 'coordinator-opus', ack: true }, 'coordinator-opus · awaiting ack'],
    [{ held_by: 'coordinator-opus', ack: true, acked_at: '2026-10-18T12:20:00Z' }, 'acked by coordinator-opus'],
    [{ released: { by: 'dev1', why: 'was halted' } }, 'released (dev1)'],
    [{ ack_of: 'm1' }, 'ack of m1'],
    [{ dead_letter: { by: 'dev1', attempts: 3 } }, 'dead letter'],
    [{ purged: { by: '@user' } }, 'purged'],
  ]
  for (const [queue, label] of cases) {
    const { v, rows: [row] } = await only([{ ...question, queue }])
    t.after(() => v.unmount())
    assert.deepEqual(classes(row!), ['l1', 'lmeta', 'l2'], label)
    assert.equal(row!.querySelector(':scope > .l1 .queuekind') === null, true, `${label}: not on line 1`)
    assert.equal(words(row!.querySelector(':scope > .lmeta > .queuekind')), label)
  }
})

test('§2 an urgent project mail keeps its urgent chip beside its kind', async (t) => {
  const { v, rows: [row] } = await only([{ ...question, urgent: true, urgent_reason: 'blocks the alpha' }])
  t.after(() => v.unmount())
  assert.deepEqual(classes(row!.querySelector(':scope > .lmeta')), ['event-row-kind', 'urgentkind', 'queuekind queue-delivery'])
  assert.deepEqual(classes(row!.querySelector(':scope > .l1')), ['mfrom', 'mtime'])
})

/* ─── §3 the Sent folder ─────────────────────────────────────────────────── */

test('§3 a Sent row for mail to a project is the same three-line row', async (t) => {
  // the user's Sent folder names the recipient as plain text and passes no
  // model resolver (App.tsx)
  const { v, rows: [row] } = await only([{ ...question, from: '@user', to: 'build-slot' }],
    { outgoing: true, rowSender: (id: string) => <span>{id}</span>, tierOf: undefined })
  t.after(() => v.unmount())
  assert.deepEqual(classes(row!), ['l1', 'lmeta', 'l2'])
  assert.equal(row!.querySelector(':scope > .l1 > .mfrom')?.textContent, '→ build-slot')
  assert.equal(row!.querySelector(':scope > .lmeta')?.textContent, 'Question→@coordinator-opus')
})

/* ─── §4 every other mailbox ─────────────────────────────────────────────── */

test('§4 rows without a queue state keep two lines with their chips beside the sender', async (t) => {
  const plain: MailRow[] = [
    { ...question, id: 'a', queue: undefined },
    { ...question, id: 'b', queue: undefined, urgent: true, urgent_reason: 'now' },
    // a queue record with nothing to show draws no chip, so it takes no line
    { ...question, id: 'c', queue: { attempts: 2 } },
  ]
  const { v, rows } = await only(plain)
  t.after(() => v.unmount())
  assert.equal(rows.length, 3, 'positive control: three rows')
  for (const row of rows) {
    assert.deepEqual(classes(row), ['l1', 'l2'], row.textContent ?? '')
    assert.equal(row.classList.contains('project-mail'), false)
    assert.equal(row.querySelector(':scope > .l1 > .event-row-kind')?.textContent, 'Question', 'the kind chip stays on line 1')
  }
  assert.deepEqual(classes(rows.find((r) => r.querySelector('.urgentkind'))!.querySelector(':scope > .l1')),
    ['mfrom', 'event-row-kind', 'urgentkind', 'mtime'], 'line 1 order is unchanged')
})

/* ─── §5 a project's own mailbox ─────────────────────────────────────────── */

const waiting: MailRow = { ...question, id: 'w1', queue: undefined, at: '2026-10-18T12:30:00Z' }
const plainWaiting: MailRow = {
  ...question, id: 'w2', queue: undefined, kind: 'message', at: '2026-10-18T12:20:00Z',
  ev: ev('ordinary.message', 'hubchat-jumplist-sol', 'Plain note.'), body: 'Plain note.',
}

test('§5 in a project\'s own mailbox a mail nobody holds yet carries its chips on the meta line', async (t) => {
  const { v, rows: [q, p] } = await only([], { pending: [waiting, plainWaiting], projectMail: true })
  t.after(() => v.unmount())
  assert.ok(q && p, 'positive control: two waiting rows')
  assert.deepEqual(classes(q!), ['l1', 'lmeta', 'l2'], 'the waiting question reads like a held one')
  assert.deepEqual(classes(q!.querySelector(':scope > .l1')), ['mfrom', 'mtime'])
  assert.deepEqual(classes(q!.querySelector(':scope > .lmeta')), ['event-row-kind'])
  assert.deepEqual(classes(p!), ['l1', 'l2'], 'a plain message has nothing for the meta line')
  for (const r of [q!, p!]) assert.ok(r.classList.contains('project-mail'))
})

/* ─── §6 the project desk ────────────────────────────────────────────────── */

test('§6 the project desk\'s inbox tab lists its mail as project mail', async (t) => {
  const had = (globalThis as { fetch?: typeof fetch }).fetch
  installFetch(new FakeServer())
  const inner = globalThis.fetch
  globalThis.fetch = ((url: RequestInfo | URL, init?: RequestInit) =>
    new URL(String(url), 'http://x').pathname === '/api/orgs/org/nodes/website/inbox'
      ? Promise.resolve(new Response(JSON.stringify({ pending: [waiting], delivered: [question], sent: [] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }))
      : inner(url, init)) as typeof fetch
  t.after(() => { (globalThis as { fetch?: typeof fetch }).fetch = had })
  const nd = {
    id: 'website', title: 'website', tier: 'project', kind: 'project', state: 'live', model_id: '',
    seat: 0, grant: 0, free: 0, scope: { tools: {}, add_dirs: [] }, configured_scope: { tools: {}, add_dirs: [] },
    parent: 'boss', charter: 'The site.', children: [], lineage: [], turns: [], audiences_held: [], mail_pending: 1,
    last_status: null, occupancy: 0, context_window: 0, busy: false, activity: null,
  } as unknown as CanvasNode
  const v = await mountView(<ProjectDesk node={nd} slug="org" tree={{ slug: 'org', roots: [] } as unknown as TreePayload}
    map={new Map([[nd.id, nd]])} op={() => Promise.resolve({} as OpResult)} toast={() => {}}
    refs={{ world: { org: 'org' }, onOpen: () => {} } as never} />, (el) => el)
  t.after(() => v.unmount())
  await flush(2)
  await inAct(() => { v.el.querySelector<HTMLButtonElement>('.cc-tabs button[data-tab="inbox"]')!.click() })
  await flush(4)
  const rows = [...v.el.querySelectorAll('.mailrow')]
  assert.equal(rows.length, 2, 'positive control: the stubbed project inbox')
  for (const r of rows) {
    assert.ok(r.classList.contains('project-mail'), r.textContent ?? '')
    assert.deepEqual(classes(r), ['l1', 'lmeta', 'l2'], r.textContent ?? '')
  }
})
