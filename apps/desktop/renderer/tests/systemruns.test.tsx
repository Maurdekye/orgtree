import { FakeServer, flush, inAct, installFetch, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { SystemRuns, systemEntry, systemRuns, transcriptEntries, revealSystemRuns } from '../src/events/systemruns'
import { SegmentList } from '../src/events/segments'
import { DeskChat, Msg } from '../src/canvas/desk'
import { storeReply } from '../src/eventReply'
import { draftKey } from '../src/draftstore'
import { refreshConvo, resetConvos } from '../src/convo'
import type { ChatMessage } from '../src/types'
import type { CanvasNode } from '../src/canvas/shared'
declare const __SRC_DIR__: string

const notice = (id: string, from = '@system', passive = true) => ({ id, from, kind: 'status', notice: passive,
  body: `Body ${id}`, at: '2026-10-13T12:00:00Z' })
const turn = (id: string, rows = [notice(id)]): ChatMessage => ({ role: 'user', text: 'original envelope',
  event_id: id, seq: Number(id.replace(/\D/g, '')) || 1, segments: [{ kind: 'mail', rows }] })
const fixture = (name: string) => JSON.parse(readFileSync(path.resolve(__SRC_DIR__, '../tests/fixtures/events', name + '.json'), 'utf8')).private
const runs = (el: HTMLElement) => [...el.querySelectorAll<HTMLDetailsElement>('details.transcript-system-run')]
const toggle = async (run: HTMLDetailsElement) => inAct(() => { run.open = !run.open; run.dispatchEvent(new Event('toggle')) })

test('same inbox passive-system boundary; authors, waking requests, tools and user prompts stay visible', () => {
  assert.equal(systemEntry(notice('yes')).system, true)
  // Engine-delivered audit notices may record the initiating user's actor.
  assert.equal(systemEntry({ ...notice('audit'), ev: fixture('access.audience_changed') }).system, true)
  for (const row of [notice('agent', 'agent'), notice('user', '@user'), notice('wake', '@system', false),
    { ...notice('ask'), _ask: { status: 'open' } }, { ...notice('wait'), _wait: true },
    { ...notice('question'), kind: 'question' }, { ...notice('tools'), tools: [{ id: 't' }] },
    { ...notice('approval'), approval: {} }, { ...notice('cmd'), cmd_out: 'result' },
    { role: 'system', text: 'Notice-looking lifecycle' }, { text: '[ORG NOTICES] literal' }]) {
    assert.equal(systemEntry(row).system, false, JSON.stringify(row))
  }
  assert.equal(systemEntry({ at: 'now', text: 'restart', ev: fixture('runtime.restart_notice') }, true).system, true)
  assert.equal(systemEntry({ at: 'now', text: 'agent', ev: { v: 1, variant: 'ordinary.notice',
    actor: { kind: 'agent', id: 'peer' }, object: null, engine_authored: false, body: 'notice' } }, true).system, false)
  assert.equal(systemEntry({ at: 'now', text: 'unclassified' }, true).system, false)
})

test('cross-envelope adjacency preserves every boundary and leaves singles unchanged', () => {
  const messages = [turn('1'), turn('2'), { role: 'assistant', text: 'answer', tools: [{ id: 't' }] } as ChatMessage,
    turn('3'), turn('4', [notice('agent', 'peer')]), turn('5'),
    { role: 'system', text: 'waking lifecycle' }, turn('6')]
  const grouped = systemRuns(transcriptEntries(messages))
  assert.deepEqual(grouped.map(g => g.length), [2, 1, 1, 1, 1, 1, 1])
  assert.deepEqual(grouped.flat().map(e => e.sourceIndex), [0, 1, 2, 3, 4, 5, 6, 7])
})

test('segment groups cross adjacent containers but preserve request and authored content, restart edge and timestamps', async t => {
  const view = await mountView(<SegmentList slug="org" nid="worker" profile="operator" segments={[
    { kind: 'notices', rows: [{ at: '2026-10-13T12:00:00Z', text: 'restart', ev: fixture('runtime.restart_notice') }] },
    { kind: 'mail', rows: [notice('quiet')] },
    { kind: 'mail', rows: [notice('review', '@system', false)] },
    { kind: 'mail', rows: [notice('third'), notice('agent', 'peer'), notice('fourth')] },
  ]} />, el => el)
  t.after(() => view.unmount())
  const [bundle, single, last] = runs(view.el)
  assert.equal(bundle.open, false)
  assert.match(bundle.querySelector('summary')!.textContent!, /2 system notices/)
  assert.ok(bundle.classList.contains('has-restart'))
  assert.ok(bundle.querySelector('[data-event-variant="runtime.restart_notice"]'))
  assert.ok(bundle.querySelector('time'))
  assert.equal(view.el.querySelector('[data-mail-id="review"]')!.closest('details'), null)
  assert.equal(view.el.querySelector('[data-mail-id="agent"]')!.closest('details'), null)
  assert.equal(single.open, true); assert.equal(last.open, true)
  assert.equal(single.querySelector('summary')!.hidden, true)
  await toggle(bundle)
  assert.equal(bundle.open, true)
  assert.match(bundle.textContent!, /Body quiet/)
})

test('one-to-two threshold and append preserve mounted cards and disclosure; target reveal is synchronous', async t => {
  let messages = [turn('1')]
  const render = () => <SystemRuns entries={transcriptEntries(messages)} render={({ message }) =>
    <Msg systemPart m={message} slug="org" nid="worker" />} />
  const view = await mountView(render(), el => el); t.after(() => view.unmount())
  const single = runs(view.el)[0], card = view.el.querySelector('[data-mail-id="1"]')!
  assert.equal(single.open, true)
  messages = [...messages, turn('2')]; await view.render(render())
  assert.equal(runs(view.el)[0], single)
  assert.equal(view.el.querySelector('[data-mail-id="1"]'), card)
  assert.equal(single.open, false)
  await toggle(single)
  messages = [...messages, turn('3')]; await view.render(render())
  assert.equal(single.open, true)
  assert.match(single.querySelector('summary')!.getAttribute('aria-label')!, /3 system notices/)
  await toggle(single)
  revealSystemRuns(view.el.querySelector<HTMLElement>('[data-mail-id="2"]')!)
  assert.equal(single.open, true)
})

test('real desk groups settled notices across turns and keeps assistant, tools, agent notices and pending distinct', async t => {
  resetConvos(); localStorage.clear()
  const slug = 'system-bundle-desk', server = new FakeServer()
  server.messages = [turn('1'), turn('2'), { role: 'assistant', seq: 3, text: 'Assistant boundary' },
    turn('4', [notice('agent', 'peer')]), turn('5'), turn('6')]
  server.postMail('Unsent action', 'pending'); installFetch(server)
  storeReply(draftKey(slug, 'worker', 2), { org: slug, agent: 'worker', generation: 2, eventId: '1', quote: 'Body 1' })
  const node: CanvasNode = { id: 'worker', generation: 2, state: 'live', tier: 'haiku', children: [],
    seat: 1, grant: 0, free: 0, scope: { tools: {}, add_dirs: [] } }
  const view = await mountView(<DeskChat bare node={node} map={new Map([[node.id, node]])} slug={slug}
    op={async () => ({})} toast={() => {}} />, el => el)
  t.after(async () => { await view.unmount(); resetConvos() })
  await inAct(async () => { await refreshConvo(slug, 'worker'); await flush() })
  assert.equal(runs(view.el).length, 2)
  assert.ok(runs(view.el).every(r => !r.open))
  assert.equal(view.el.querySelector('.msg.assistant')!.closest('.transcript-system-run'), null)
  assert.equal(view.el.querySelector('[data-mail-id="agent"]')!.closest('.transcript-system-run'), null)
  assert.equal(view.el.querySelector('.pendrow')!.closest('.transcript-system-run'), null)
  const first = runs(view.el)[0]
  const target = first.querySelector<HTMLElement>('[data-reply-event="1"]')!
  let scrolls = 0
  target.scrollIntoView = () => { assert.equal(first.open, true); scrolls++ }
  await inAct(async () => {
    view.el.querySelector<HTMLButtonElement>('.reply-preview-composing .reply-preview-head button')!.click()
    await new Promise(resolve => setTimeout(resolve, 5))
  })
  assert.equal(scrolls, 1)
  assert.equal(view.el.querySelectorAll('[data-reply-event="1"]').length, 1)
  const scroller = view.el.querySelector<HTMLElement>('.msgs')!
  Object.defineProperties(scroller, {
    scrollHeight: { configurable: true, get: () => first.open ? 1200 : 300 },
    clientHeight: { configurable: true, value: 100 },
  })
  await inAct(() => {
    scroller.dispatchEvent(new window.WheelEvent('wheel', { bubbles: true, deltaY: -100 }))
    scroller.scrollTop = 75
  })
  await toggle(first)
  assert.equal(scroller.scrollTop, 75, 'disclosure preserves upward reading intent')
})
