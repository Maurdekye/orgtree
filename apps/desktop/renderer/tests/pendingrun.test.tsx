import { FakeServer, flush, inAct, installFetch, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { DeskChat } from '../src/canvas/desk'
import { addPending, failPending, refreshConvo, resetConvos } from '../src/convo'
import { storeReply } from '../src/eventReply'
import { draftKey } from '../src/draftstore'
import type { CanvasNode } from '../src/canvas/shared'

const node: CanvasNode = { id: 'worker', generation: 2, state: 'live', tier: 'haiku',
  children: [], seat: 1, grant: 0, free: 0, scope: { tools: {}, add_dirs: [] } }
const desk = (slug: string) => <DeskChat node={node} map={new Map([[node.id, node]])}
  slug={slug} op={async () => ({})} toast={() => {}} bare />
const runs = (el: HTMLElement) => [...el.querySelectorAll<HTMLDetailsElement>('details.pending-run')]
const refresh = async (slug: string) => inAct(async () => {
  await refreshConvo(slug, node.id, { force: true }); await flush(5)
})
const toggle = async (run: HTMLDetailsElement) => inAct(async () => {
  run.querySelector('summary')!.click(); await new Promise(resolve => setTimeout(resolve, 5))
})
function fill(s: FakeServer, count: number, prefix = 'm') {
  for (let i = 0; i < count; i++) {
    const row = s.postMail(`Message ${prefix}${i}`, `${prefix}${i}`)
    row.event_id = `event-${prefix}${i}`
  }
}

test('five remain visible; six collapse; toggles preserve cards and updates preserve expansion', async t => {
  resetConvos(); localStorage.clear()
  const slug = 'pending-run-threshold', s = new FakeServer(); fill(s, 5); installFetch(s)
  const view = await mountView(desk(slug), el => el)
  t.after(async () => { await view.unmount(); resetConvos() })
  await refresh(slug)
  const run = runs(view.el)[0]
  assert.equal(run.open, true)
  assert.equal(run.querySelector('summary')!.hidden, true)
  const first = run.querySelector('.pendrow')!
  s.postMail('Sixth', 'sixth'); await refresh(slug)
  assert.equal(runs(view.el)[0], run, 'stable wrapper at threshold')
  assert.equal(run.open, false)
  assert.match(run.querySelector('summary')!.textContent!, /6 queued \/ undelivered — Show/)
  assert.equal(run.querySelector('.pendrow'), first, 'cards stay mounted')
  const before = JSON.stringify(s.pending_mail)
  await toggle(run)
  assert.equal(run.open, true)
  assert.match(run.querySelector('summary')!.textContent!, /Hide/)
  s.postMail('Seventh', 'seventh'); await refresh(slug)
  assert.equal(run.open, true, 'arrival does not close an expanded run')
  await toggle(run)
  assert.equal(run.open, false)
  assert.equal(JSON.stringify(s.pending_mail.slice(0, 6)), before, 'view toggle never changes mail')
  assert.equal(run.querySelectorAll('button[title="retract (undelivered)"]').length, 7)
  s.pending_mail.splice(0, 2); await refresh(slug)
  assert.equal(run.open, true, 'falling below threshold exposes remaining mail')
  assert.equal(run.querySelector('summary')!.hidden, true)
  s.pending_mail = []; await refresh(slug)
  assert.equal(runs(view.el).length, 0)
  assert.equal(view.el.querySelector('.pending-divider'), null)
})

test('current-turn and waiting runs stay on opposite sides of response; failed and optimistic sends stay outside', async t => {
  resetConvos(); localStorage.clear()
  const slug = 'pending-run-order', s = new FakeServer(); fill(s, 6, 'now'); s.drain()
  s.liveRow('text', 'Live response'); fill(s, 6, 'later'); installFetch(s)
  const view = await mountView(desk(slug), el => el)
  t.after(async () => { await view.unmount(); resetConvos() })
  await refresh(slug)
  const [now, later] = runs(view.el)
  assert.ok(now && later)
  assert.equal(now.open, false); assert.equal(later.open, false)
  const live = view.el.querySelector('.msg.live')!
  assert.ok(now.compareDocumentPosition(live) & Node.DOCUMENT_POSITION_FOLLOWING)
  assert.ok(live.compareDocumentPosition(later) & Node.DOCUMENT_POSITION_FOLLOWING)
  await inAct(() => {
    addPending(slug, node.id, 'Still sending')
    const failed = addPending(slug, node.id, 'Failed send')
    failPending(slug, node.id, failed, 'Network failure')
  })
  assert.equal(view.el.querySelectorAll('.pendghost').length, 2)
  for (const ghost of view.el.querySelectorAll('.pendghost')) assert.equal(ghost.closest('details'), null)
  assert.ok(view.el.querySelector('.pendghost.failed .ghost-acts button'))
  assert.match(view.el.querySelector('.pending-divider')!.textContent!, /14 queued/)
  await toggle(now)
  assert.equal(later.open, false, 'disclosures are independent')
  assert.deepEqual([...now.querySelectorAll('.pendrow')].map(el => el.getAttribute('data-reply-event')),
    Array.from({ length: 6 }, (_, i) => `event-now${i}`))
})

test('threshold counts surviving rendered events, including typed notices; delivery remains visible in transcript', async t => {
  resetConvos(); localStorage.clear()
  const slug = 'pending-run-dedup', s = new FakeServer(); fill(s, 6)
  s.pending_mail[5].event_id = s.pending_mail[4].event_id
  s.pending_mail[0].notice = true
  s.pending_mail[0].ev = { v: 1, variant: 'ordinary.message', actor: { kind: 'user', id: '@user' },
    object: null, engine_authored: false, body: 'Typed notice' }
  installFetch(s)
  const view = await mountView(desk(slug), el => el)
  t.after(async () => { await view.unmount(); resetConvos() })
  await refresh(slug)
  const run = runs(view.el)[0]
  assert.equal(run.querySelectorAll('.pendrow').length, 5)
  assert.equal(run.open, true)
  assert.equal(run.querySelector('summary')!.hidden, true)
  assert.ok(run.querySelector('.turn-mail.passive'))
  s.pending_mail[5].event_id = 'event-unique'; await refresh(slug)
  assert.equal(run.open, false)
  s.drain(); s.echo(); await refresh(slug)
  assert.equal(runs(view.el).length, 0)
  assert.match(view.el.textContent!, /Message m0/)
})

test('reply locate opens a collapsed pending target before scrolling and keeps it open', async t => {
  resetConvos(); localStorage.clear()
  const slug = 'pending-run-reply', s = new FakeServer(); fill(s, 6); installFetch(s)
  storeReply(draftKey(slug, node.id, 2), { org: slug, agent: node.id, generation: 2,
    eventId: 'event-m0', quote: 'Message m0' })
  const view = await mountView(desk(slug), el => el)
  t.after(async () => { await view.unmount(); resetConvos() })
  await refresh(slug)
  const run = runs(view.el)[0], target = run.querySelector<HTMLElement>('[data-reply-event="event-m0"]')!
  assert.equal(run.open, false)
  let calls = 0
  target.scrollIntoView = () => { assert.equal(run.open, true, 'reveal precedes scroll'); calls++ }
  await inAct(async () => {
    view.el.querySelector<HTMLButtonElement>('.reply-preview-composing .reply-preview-head button')!.click()
    await new Promise(resolve => setTimeout(resolve, 5))
  })
  assert.equal(calls, 1)
  await refresh(slug)
  assert.equal(run.open, true)
})
