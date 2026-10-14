import { FakeServer, flush, inAct, installFetch, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { DeskChat } from '../src/canvas/desk'
import { refreshConvo, resetConvos } from '../src/convo'
import { storeReply } from '../src/eventReply'
import { draftKey } from '../src/draftstore'
import type { CanvasNode } from '../src/canvas/shared'
import type { ChatMessage, PendingMail } from '../src/types'

const node: CanvasNode = { id: 'worker', generation: 2, state: 'live', tier: 'haiku',
  children: [], seat: 1, grant: 0, free: 0, scope: { tools: {}, add_dirs: [] } }
const desk = (slug: string) => <DeskChat bare node={node} map={new Map([[node.id, node]])}
  slug={slug} op={async () => ({})} toast={() => {}} />
const refresh = (slug: string) => inAct(async () => {
  await refreshConvo(slug, node.id, { force: true }); await flush(5)
})
const bundles = (el: HTMLElement) => [...el.querySelectorAll<HTMLDetailsElement>('.msgs .transcript-system-run')]
const toggle = (run: HTMLDetailsElement) => inAct(async () => {
  run.querySelector('summary')!.click(); await flush(5)
})
function notice(s: FakeServer, id: string, from = '@system', passive = true) {
  const row = s.postMail(`Notice ${id}`, id)
  Object.assign(row, { from, notice: passive, kind: 'status', event_id: `event-${id}` })
  return row
}
const delivered = (rows: PendingMail[], seq = 1): ChatMessage => ({ role: 'user', seq,
  event_id: `envelope-${seq}`, text: 'Delivered envelope', segments: [{ kind: 'mail', rows:
    rows.map(({ delivering, via, stage, ...row }) => ({ ...row, id: row.id!, kind: row.kind! })) }] })

test('two unsent system notices collapse immediately; singleton and append preserve mounted pending cards', async t => {
  resetConvos(); localStorage.clear()
  const slug = 'unsent-notice-threshold', s = new FakeServer()
  notice(s, 'a'); installFetch(s)
  const view = await mountView(desk(slug), el => el)
  t.after(async () => { await view.unmount(); resetConvos() })
  await refresh(slug)
  const single = bundles(view.el)[0]!
  assert.ok(single, 'pending notice uses the same system-run wrapper before delivery')
  assert.equal(single.open, true)
  assert.equal(single.querySelector('summary')!.hidden, true)
  const card = single.querySelector('.pendrow')
  notice(s, 'b'); await refresh(slug)
  assert.equal(bundles(view.el)[0], single)
  assert.equal(single.querySelector('.pendrow'), card)
  assert.equal(single.open, false)
  assert.match(single.querySelector('summary')!.textContent!, /2 system notices/)
  notice(s, 'c'); await refresh(slug)
  assert.equal(single.open, false)
  assert.equal(single.querySelectorAll('.pendrow').length, 3)
  assert.equal(view.el.querySelector('.pending-run'), null, 'no outer six-mail fold hides the notice bundle')
  assert.equal(view.el.querySelectorAll('.pending-divider').length, 1)
})

test('partial and complete delivery retain one bundle and its explicit open/closed state', async t => {
  resetConvos(); localStorage.clear()
  const slug = 'unsent-notice-delivery', s = new FakeServer()
  const a = notice(s, 'a'), b = notice(s, 'b'), c = notice(s, 'c'); installFetch(s)
  const view = await mountView(desk(slug), el => el)
  t.after(async () => { await view.unmount(); resetConvos() })
  await refresh(slug)
  const run = bundles(view.el)[0]!
  assert.ok(run, 'unsent run exists')
  assert.equal(run.open, false)
  a.delivering = true; a.via = 'turn'; a.stage = 'turn'
  await refresh(slug)
  assert.equal(bundles(view.el).length, 1, 'delivery carriers alone do not break adjacency')
  assert.equal(bundles(view.el)[0], run)
  assert.equal(run.open, false)
  await toggle(run)
  assert.equal(run.open, true)
  s.messages = [delivered([a])]; s.pending_mail = [b, c]
  await refresh(slug)
  assert.equal(bundles(view.el).length, 1)
  assert.equal(bundles(view.el)[0], run, 'stable mail identity across envelope replacement')
  assert.equal(run.open, true)
  assert.equal(run.querySelectorAll('.pendrow').length, 2)
  assert.match(run.querySelector('summary')!.textContent!, /3 system notices/)
  await toggle(run)
  s.messages = [delivered([a, b, c])]; s.pending_mail = []
  await refresh(slug)
  assert.equal(bundles(view.el)[0], run)
  assert.equal(run.open, false, 'completion does not reopen a deliberately collapsed bundle')
  assert.equal(run.querySelectorAll('.pendrow').length, 0)
  assert.equal(run.querySelectorAll('[data-mail-id]').length, 3)
  assert.equal(view.el.querySelector('.pending-divider'), null)
})

test('authored passive mail and waking system requests stay outside system bundles', async t => {
  resetConvos(); localStorage.clear()
  const slug = 'unsent-notice-boundaries', s = new FakeServer()
  notice(s, 'peer', 'peer'); notice(s, 'user', '@user'); notice(s, 'wake', '@system', false)
  installFetch(s)
  const view = await mountView(desk(slug), el => el)
  t.after(async () => { await view.unmount(); resetConvos() })
  await refresh(slug)
  assert.equal(bundles(view.el).length, 0)
  assert.equal(view.el.querySelectorAll('.pendrow').length, 3)
  assert.equal(view.el.querySelector<HTMLDetailsElement>('.pending-run')!.open, true)
  for (let i = 0; i < 3; i++) notice(s, `more-${i}`, 'peer')
  await refresh(slug)
  assert.equal(view.el.querySelector<HTMLDetailsElement>('.pending-run')!.open, false)
  assert.match(view.el.querySelector('.pending-run > summary')!.textContent!, /6 queued/)
})

test('live tool output and agent notice break pending system runs without changing their order', async t => {
  resetConvos(); localStorage.clear()
  const slug = 'unsent-notice-live', s = new FakeServer()
  for (const id of ['a', 'b']) Object.assign(notice(s, id), { delivering: true, via: 'turn' })
  s.liveRow('tool', 'Actual tool boundary', 'tool-1')
  notice(s, 'c'); notice(s, 'd'); notice(s, 'peer', 'peer'); notice(s, 'e'); notice(s, 'f')
  installFetch(s)
  const view = await mountView(desk(slug), el => el)
  t.after(async () => { await view.unmount(); resetConvos() })
  await refresh(slug)
  const runs = bundles(view.el)
  assert.equal(runs.length, 3)
  assert.ok(runs.every(run => !run.open))
  const tool = view.el.querySelector('.msg.live.tools')!
  assert.equal(tool.closest('.transcript-system-run'), null)
  assert.ok(runs[0]!.compareDocumentPosition(tool) & Node.DOCUMENT_POSITION_FOLLOWING)
  assert.ok(tool.compareDocumentPosition(runs[1]!) & Node.DOCUMENT_POSITION_FOLLOWING)
  assert.equal(view.el.querySelector('[data-mail-id="peer"]')!.closest('.transcript-system-run'), null)
  assert.deepEqual(runs.map(run => [...run.querySelectorAll('.pendrow')].map(row => row.getAttribute('data-reply-event'))),
    [['event-a', 'event-b'], ['event-c', 'event-d'], ['event-e', 'event-f']])
})

test('reply navigation reveals an unsent system bundle before scrolling without sending mail', async t => {
  resetConvos(); localStorage.clear()
  const slug = 'unsent-notice-reply', s = new FakeServer()
  notice(s, 'a'); notice(s, 'b'); installFetch(s)
  storeReply(draftKey(slug, node.id, 2), { org: slug, agent: node.id, generation: 2,
    eventId: 'event-a', quote: 'Notice a' })
  const view = await mountView(desk(slug), el => el)
  t.after(async () => { await view.unmount(); resetConvos() })
  await refresh(slug)
  const run = bundles(view.el)[0]!
  assert.ok(run)
  assert.equal(run.open, false)
  let scrolls = 0
  run.querySelector<HTMLElement>('[data-reply-event="event-a"]')!.scrollIntoView = () => {
    assert.equal(run.open, true); scrolls++
  }
  const before = JSON.stringify(s.pending_mail)
  await inAct(async () => {
    view.el.querySelector<HTMLButtonElement>('.reply-preview-composing .reply-preview-head button')!.click()
    await flush(5)
  })
  assert.equal(scrolls, 1)
  await refresh(slug)
  assert.equal(run.open, true)
  assert.equal(JSON.stringify(s.pending_mail), before)
})
