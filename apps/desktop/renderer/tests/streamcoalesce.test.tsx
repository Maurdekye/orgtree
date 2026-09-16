// THE PROPERTY: displaying a stream costs what the stream costs, not its
// square.
//
// The defect this guards against (ticket
// `the-renderer-allocates-tens-of-megabytes-per-sec`) was that every streamed
// token published its own store notification, and every notification
// re-rendered every desk watching the node — so N tokens cost N renders, and
// each render cost roughly the size of everything already on screen. That
// product is the square, and it is why the renderer allocated tens of
// megabytes a second to display a few kilobytes of text.
//
// WHAT IS ASSERTED, and why it is a scaling assertion rather than a budget:
// a fixed byte or millisecond ceiling would be a machine-speed test that
// passes or fails on whatever hardware runs it. The renders a burst causes is
// a property of the code. Ten times the tokens inside one frame must not cost
// ten times the renders.
//
// ⚠ WOULD IT HAVE CAUGHT THE ORIGINAL DEFECT? Yes, and the numbers are stated
// in the assertions: on the unfixed code `bursts` below renders once per token
// (20 and 200), so the ratio is ~10 and the test fails on its first assertion.
// It is a genuine regression guard, not a test written to fit the fix.
//
// ⚠ WHAT IT CANNOT HOLD. This runs in jsdom, where `requestAnimationFrame` is
// a 16 ms `setTimeout` and React's concurrent scheduler does not behave as it
// does in a browser. So this pins the COALESCING — how many notifications a
// burst produces, and that nothing is lost or reordered — and deliberately
// does not pin paint timing or allocated bytes. Those are measured instead by
// `tools/run-alloc-probe.mjs` against a real Electron renderer.

import './harness'
import { advance, inAct, mountView, realClock, useFakeClock } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { ingestStream, resetConvos, useConvo } from '../src/convo'
import type { Convo } from '../src/convo'

const SL = 'org'
const ND = 'streamer'
/** one frame, as the store schedules its flush */
const FRAME = 20

/** A real subscriber — `useConvo` is the exact code path a desk uses, so the
 *  render count here is the render count a desk pays. */
async function mounted() {
  let snap: Convo | null = null
  let renders = 0
  function Probe() { snap = useConvo(SL, ND); renders++; return null }
  const v = await mountView(<Probe />, (h) => h)
  return { view: v, get snap() { return snap! }, get renders() { return renders },
    reset() { renders = 0 } }
}

const delta = (text: string) => inAct(() => {
  ingestStream(SL, { node: ND, kind: 'delta', text, event_id: 'd1' } as never)
})

test('a burst of tokens costs one render, and ten times the tokens does not cost ten times the renders',
  { timeout: 8_000 }, async (t) => {
  useFakeClock()
  const m = await mounted()
  t.after(async () => { await m.view.unmount(); resetConvos(); realClock() })

  // settle the mount so the baseline is a steady state, not a cold start
  await advance(FRAME)
  m.reset()

  // ── 20 tokens inside one frame
  for (let i = 0; i < 20; i++) await delta('a')
  const midBurst = m.renders
  await advance(FRAME)
  const small = m.renders

  // ⚠ THE LOAD-BEARING ONE. Tokens arriving inside a frame must not each
  // publish. On the unfixed code this is 20.
  assert.equal(midBurst, 0,
    `tokens must buffer, not publish one at a time (saw ${midBurst} renders for 20 tokens)`)
  assert.ok(small >= 1, 'the buffer must actually publish — the text has to reach the screen')

  m.reset()
  // ── 200 tokens inside one frame, the same way
  for (let i = 0; i < 200; i++) await delta('b')
  await advance(FRAME)
  const big = m.renders

  console.log('renders: 20 tokens →', small, '| 200 tokens →', big)
  // Ten times the tokens, not ten times the cost. Generous on purpose: this
  // is a scaling guard, and an exact equality would break on any future change
  // that legitimately splits a flush in two.
  assert.ok(big <= small * 2,
    `display cost must scale with the stream, not with its square: `
    + `20 tokens cost ${small} renders and 200 cost ${big}`)

  // ── and nothing was dropped on the way: what the wire sent is what the
  // store holds. A coalescing bug that loses tokens would pass every count
  // above and be a far worse defect than the one being fixed.
  assert.equal(m.snap.draft, 'a'.repeat(20) + 'b'.repeat(200),
    'every token must survive coalescing, in order')
})

test('a durable row publishes the buffered tokens before it acts on them',
  { timeout: 8_000 }, async (t) => {
  useFakeClock()
  const m = await mounted()
  t.after(async () => { await m.view.unmount(); resetConvos(); realClock() })
  await advance(FRAME)

  await delta('one ')
  await delta('two ')
  // no clock advance: the buffer is still unpublished here
  assert.equal(m.snap.draft, '', 'positive control — the tokens really are buffered')

  // a `text` frame is the durable row that supersedes the draft. It decides
  // staleness from the store, so it must see the tokens first.
  await inAct(() => {
    ingestStream(SL, { node: ND, kind: 'text', text: 'the settled message' } as never)
  })
  assert.equal(m.snap.draft, 'one two ',
    'anything that is not live text must publish the buffer before it runs')
})

test('a thought coalesces the same way and keeps its cap', { timeout: 8_000 }, async (t) => {
  useFakeClock()
  const m = await mounted()
  t.after(async () => { await m.view.unmount(); resetConvos(); realClock() })
  await advance(FRAME)
  m.reset()

  await inAct(() => {
    ingestStream(SL, { node: ND, kind: 'thinking_start', text: '', event_id: 't1' } as never)
  })
  m.reset()
  for (let i = 0; i < 50; i++) {
    // eslint-disable-next-line no-await-in-loop
    await inAct(() => {
      ingestStream(SL, { node: ND, kind: 'thinking', text: 'x'.repeat(100),
        event_id: 't1' } as never)
    })
  }
  const midBurst = m.renders
  await advance(FRAME)
  assert.equal(midBurst, 0, `thinking must buffer too (saw ${midBurst} renders for 50 tokens)`)
  // 50 x 100 chars is 5000, well past the 2000-char cap the thought is held to
  assert.equal(m.snap.thinking.length, 2000,
    'the cap applies to the coalesced text, not to each token')
})
