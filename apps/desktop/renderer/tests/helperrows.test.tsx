// helperrows.test.tsx — the helpers badge is a header badge, and a helper's
// tool rows read like the desk's own (USER 2026-11-10 m93f795ab5ef7: "this
// helpers chip should be a header badge with the other header badges" and
// "the transcripts of each helper are pretty much always cut off only showing
// 5-15 total lines with minimal context"). Docket
// helpers-header-badge-and-helper-transcripts-show. Red at fe38a77.
import test from 'node:test'
import assert from 'node:assert/strict'
import { advance, FakeServer, flush, inAct, installFetch, mountView, realClock, useFakeClock } from './harness'
import { DeskChat } from '../src/canvas/desk'
import { HelperTranscript } from '../src/canvas/helpertranscript'
import { syncProviderRegistries } from '../src/canvas/shared'
import type { CanvasNode } from '../src/canvas/shared'
import { resetConvos } from '../src/convo'

const noop = () => {}
const worker = (helpers: number) => ({ id: 'worker', tier: 'opus', state: 'live', busy: true, generation: 1,
  helper_count: helpers, children: [], seat: 2, grant: 0, free: 0,
  scope: { tools: {}, add_dirs: [], effort: 'medium' }, configured_scope: { tools: {}, add_dirs: [] },
  turns: [], lineage: [], audiences_held: [], mail_pending: 0 } as unknown as CanvasNode)
function setup() {
  resetConvos(); installFetch(new FakeServer())
  syncProviderRegistries({ providers: [{ id: 'claude', tiers: [{ tier: 'opus', model: 'claude-opus-5-5', effort_levels: ['low', 'medium', 'high'] }] }] })
}

test('the helpers count is a header badge in the desk meta row, not inline after the status', async t => {
  setup()
  const node = worker(6)
  const v = await mountView(<DeskChat node={node} map={new Map([[node.id, node]])} slug="helper-badge"
    op={async () => ({})} toast={noop} bare />, el => el)
  t.after(async () => { await v.unmount(); resetConvos() }); await inAct(async () => { await flush(4) })
  const badge = v.el.querySelector('.cc-head-meta .live-helpers-badge')
  assert.ok(badge, 'the badge sits in the header badge row (.cc-head-meta)')
  assert.equal(badge?.textContent, '6 helpers')
  assert.ok(badge?.classList.contains('badge'), 'styled as the other header badges')
  assert.equal(v.el.querySelector('.cc-head-left .live-helpers-badge'), null, 'no inline chip after the status text')
  assert.equal(v.el.querySelectorAll('.live-helpers-badge').length, 1, 'exactly one badge')
  const none = worker(0)
  await v.render(<DeskChat node={none} map={new Map([[none.id, none]])} slug="helper-badge"
    op={async () => ({})} toast={noop} bare />); await inAct(async () => { await flush(2) })
  assert.equal(v.el.querySelector('.live-helpers-badge'), null, 'hidden at 0')
})

test('a helper tool row shows its input summary and run time, and the text between calls', async t => {
  const original = globalThis.fetch
  const snapshot = { live: false, truncated: false, messages: [{ id: 'm1', text: 'Checking the session protocol.',
    content_blocks: [{ kind: 'text', start: 0, end: 30 }, { kind: 'tool', id: 't1' }],
    tools: [{ id: 't1', name: 'Read', arg: 'engine/rs/orgtree-engine/src/session.rs',
      input_text: '{"file_path":"engine/rs/orgtree-engine/src/session.rs"}',
      started_at: '2026-11-10T19:16:00.000Z', ended_at: '2026-11-10T19:16:02.000Z',
      result: 'mod session;\nuse std::io;', result_lines: 120, truncated: true }] }] }
  globalThis.fetch = (async () => new Response(JSON.stringify(snapshot),
    { headers: { 'Content-Type': 'application/json' } })) as typeof fetch
  const v = await mountView(<HelperTranscript slug="org" nid="worker" seq={7} tool="call" />, el => el)
  t.after(async () => { await v.unmount(); globalThis.fetch = original }); await inAct(async () => { await flush(4) })
  const line = v.el.querySelector('.helper-transcript .tline')
  assert.ok(line, 'the helper call renders as a desk tool row')
  assert.match(line!.textContent!, /Read engine\/rs\/orgtree-engine\/src\/session\.rs/, 'input summary beside the tool name')
  assert.equal(line!.querySelector('[aria-label="execution time unavailable"]'), null, 'not the bare "→ —"')
  assert.ok(line!.querySelector('[aria-label="ran for 2.0s"]'), 'the observed run time')
  assert.match(v.el.querySelector('.helper-transcript')!.textContent!, /Checking the session protocol\./, 'assistant text between calls')
  await inAct(() => (line as HTMLElement).click()); await flush(2)
  assert.match(v.el.querySelector('.helper-transcript')!.textContent!, /120 lines/, 'the expanded row says how long the result was')
  assert.doesNotMatch(v.el.querySelector('.helper-transcript')!.textContent!, /activity was omitted/)
})

// @build-sol capture bounce 2026-11-10 m4c919154401f... r3 (mb7e8c34e88ac): with
// no user input between S1 and S2, the live transcript stopped following its
// tail (S2 gap 6939 px, the view stuck mid-stream while the API held h0..h219).
// Follow must be released only by the READER (wheel/keys/touch/scrollbar), as
// the desk transcript does, never by a scroll event: our own programmatic
// scroll's event can land after the next snapshot has already grown the
// content, which reads as "far from the bottom" and wrongly dropped follow.
test('a live helper transcript keeps following its tail through growth; only the reader releases it', async t => {
  useFakeClock()
  const original = globalThis.fetch
  let rows = 40
  const snapshot = () => ({ live: true, truncated: false, messages: Array.from({ length: rows }, (_, i) => ({
    id: `h${i}`, text: `Checking part ${i}.`, content_blocks: [{ kind: 'text', start: 0, end: 15 }] })) })
  globalThis.fetch = (async () => new Response(JSON.stringify(snapshot()),
    { headers: { 'Content-Type': 'application/json' } })) as typeof fetch
  const v = await mountView(<HelperTranscript slug="org" nid="worker" seq={7} tool="call" autoFollow />, el => el)
  t.after(async () => { await v.unmount(); globalThis.fetch = original; realClock() })
  const el = v.el.querySelector<HTMLElement>('.helper-transcript')!
  // jsdom has no layout: model one. Each message is 60 px; the box is 410 px.
  let top = 0
  const height = () => el.querySelectorAll('.helper-transcript-message').length * 60
  Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => 410 })
  Object.defineProperty(el, 'scrollHeight', { configurable: true, get: height })
  Object.defineProperty(el, 'scrollTop', { configurable: true, get: () => top,
    set: (value: number) => { top = Math.max(0, Math.min(value, height() - 410)) } })
  const gap = () => height() - top - 410
  await inAct(async () => { await flush(4) }); await advance(800)
  assert.equal(gap(), 0, 'S1: at the tail')
  // the late echo of our own scroll, delivered after the next snapshot grew
  rows = 120; await advance(800)
  const stale = top
  rows = 160; await advance(800)
  top = stale; await inAct(() => { el.dispatchEvent(new Event('scroll')) })
  rows = 220; await advance(800)
  assert.equal(el.querySelectorAll('.helper-transcript-message').length, 220)
  assert.equal(gap(), 0, 'still following the tail with no reader input')
  // the reader scrolls up: follow is released and growth leaves them there
  await inAct(() => { el.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, bubbles: true })) })
  top = 1000; await inAct(() => { el.dispatchEvent(new Event('scroll')) })
  rows = 230; await advance(800)
  assert.equal(top, 1000, 'a reader who scrolled up is not pulled down')
  // …and scrolling back down to the tail resumes follow
  await inAct(() => { el.dispatchEvent(new WheelEvent('wheel', { deltaY: 120, bubbles: true })) })
  top = height() - 410; await inAct(() => { el.dispatchEvent(new Event('scroll')) })
  rows = 240; await advance(800)
  assert.equal(gap(), 0, 'back at the tail, follow resumes')
})
