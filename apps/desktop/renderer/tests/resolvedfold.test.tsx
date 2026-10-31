// resolvedfold.test.tsx — a resolved request's long question folds as a long message does.
//
// USER 2026-10-31 17:38:40Z m007f4c4e2843 + correction 17:38:47Z m6ec872350d64: "collapse request resolved cards
// with long bodies in the same way messages are collapsed". The "Request resolved" / "Question answered" card drew
// every question's full text; now each question's TEXT folds through the SAME ReceivedMailBody a long message uses
// (five lines, the fade, "click to expand · N lines", the shared fold state), while the options and the picks below
// it stay visible. Short questions draw exactly as before: no control.
//
// Run:  node apps/desktop/renderer/tests/run.mjs resolvedfold

import { flush, inAct, mountView, useFakeClock, realClock } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { EventCard } from '../src/events/card'
import { AskCard } from '../src/canvas/asks'
import type { AskInfo } from '../src/types'
import { FoldProvider, useFoldState } from '../src/canvas/foldstate'

const LINE = 20
const HEIGHT = 16
// jsdom has no layout: 16px rows, 20px apart per text node (as pendexpand.test.tsx / docketdesc.test.tsx)
function layout() {
  const win = (globalThis as unknown as { window: Window & typeof globalThis }).window
  const proto = win.HTMLElement.prototype
  const realRect = proto.getBoundingClientRect
  const realWidth = Object.getOwnPropertyDescriptor(proto, 'offsetWidth')
  const realRects = win.Range.prototype.getClientRects
  const seen = new Map<Node, number>()
  proto.getBoundingClientRect = function (this: HTMLElement) {
    return { top: 0, left: 0, right: 400, bottom: 2000, width: 400, height: 2000, x: 0, y: 0, toJSON: () => ({}) } as DOMRect
  }
  Object.defineProperty(proto, 'offsetWidth', { configurable: true, get: () => 400 })
  win.Range.prototype.getClientRects = function (this: Range) {
    const node = this.startContainer
    if (!seen.has(node)) seen.set(node, seen.size)
    const i = seen.get(node)!
    return [{ top: i * LINE, bottom: i * LINE + HEIGHT, left: 0, right: 200, width: 200, height: HEIGHT, x: 0, y: i * LINE, toJSON: () => ({}) } as DOMRect] as unknown as DOMRectList
  }
  return () => {
    proto.getBoundingClientRect = realRect
    if (realWidth) Object.defineProperty(proto, 'offsetWidth', realWidth)
    else delete (proto as unknown as Record<string, unknown>).offsetWidth
    win.Range.prototype.getClientRects = realRects
  }
}

const para = (tag: string, n: number) => Array.from({ length: n }, (_, i) => `Paragraph ${i + 1} of ${tag}: the long question text.`).join('\n\n')
const LONG = para('LONG', 9)
const OPTS = [{ label: 'yes', description: 'do it' }, { label: 'no' }, { label: 'later' }]
const actor = { kind: 'user', id: '@user' }

const askEv = (question: string) => ({
  v: 1, variant: 'answer.ask', actor, engine_authored: false, object: { kind: 'ask', org: 'org', id: 'a1', node: 'n' },
  questions: [{ label: 'Go', question, selected: ['yes'], options: OPTS, multi: false }], text: null, dismissed: false, single: true,
})
const batchEv = (q1: string, q2: string) => ({
  v: 1, variant: 'answer.batch', actor, engine_authored: false, object: { kind: 'batch', org: 'org', id: 'b1', node: 'n' },
  sections: [{ kind: 'ask', ask_id: 'b1', questions: [
    { label: 'One', question: q1, answer: 'yes', selected: ['yes'], options: OPTS, multi: false },
    { label: 'Two', question: q2, answer: 'no', selected: ['no'], options: OPTS, multi: false },
  ] }],
})

async function withCard(ev: unknown, body: (el: HTMLElement) => Promise<void>, id = 'mail-1') {
  useFakeClock()
  const restore = layout()
  const v = await mountView(<EventCard row={{ id, ev }} profile="operator" org="org" preview />, (host) => host)
  try { await flush(4); await body(v.el) } finally { await v.unmount(); restore(); realClock() }
}
const toggles = (el: HTMLElement) => [...el.querySelectorAll('.answered-qtext .turn-mail-toggle')] as HTMLElement[]
const folded = (el: HTMLElement) => el.querySelectorAll('.answered-qtext .turn-mail-preview.folded').length
const click = (b: HTMLElement) => inAct(async () => { b.click(); await flush(2) })

test('§1 a long question is folded like a long message; the options and the pick stay visible', async () => {
  await withCard(askEv(LONG), async (el) => {
    assert.equal(folded(el), 1, 'the question text is folded')
    assert.match(toggles(el)[0]!.textContent ?? '', /^click to expand · \d+ lines$/, 'the long-message control and wording')
    assert.equal(el.querySelectorAll('.answered-opt').length, 3, 'every option is still listed')
    assert.equal(el.querySelector('.answered-opt[data-chosen="true"] .answered-opt-label')?.textContent, 'yes', 'with the pick marked')
  })
})

test('§2 the control expands and collapses the question text', async () => {
  await withCard(askEv(LONG), async (el) => {
    await click(toggles(el)[0]!)
    assert.equal(folded(el), 0)
    assert.equal(toggles(el)[0]!.textContent, 'click to collapse')
    await click(toggles(el)[0]!)
    assert.equal(folded(el), 1)
  })
})

test('§3 a short question draws no control and no fold (unchanged)', async () => {
  await withCard(askEv('Proceed?'), async (el) => {
    assert.equal(toggles(el).length, 0)
    assert.equal(folded(el), 0)
    assert.equal(el.querySelector('.answered-chip')?.textContent, 'Go', 'the label chip is still drawn')
  })
})

test('§4 a batch folds per question: expanding one leaves the other folded', async () => {
  await withCard(batchEv(LONG, para('SECOND', 9)), async (el) => {
    assert.equal(folded(el), 2)
    await click(toggles(el)[0]!)
    assert.equal(folded(el), 1, 'only the second is still folded')
    assert.equal(el.querySelectorAll('.answered-opt[data-chosen="true"]').length, 2, 'both picks stay visible throughout')
  })
})

test('§5 a batch with one short and one long question folds only the long one', async () => {
  await withCard(batchEv('Short one?', LONG), async (el) => {
    assert.equal(folded(el), 1)
    assert.equal(toggles(el).length, 1)
  })
})

test('§6 the inbox/Attention row of a resolved ask folds its long question the same way', async () => {
  useFakeClock()
  const restore = layout()
  const ask = { id: 'ask-9', node: 'n', kind: 'question', status: 'answered', at: '2026-09-10T13:00:00Z', question: LONG,
    options: OPTS, answer: { text: 'yes', selected: ['yes'] } } as unknown as AskInfo
  const v = await mountView(<AskCard ask={ask} slug="org" toast={() => {}} />, (host) => host)
  try {
    await flush(4)
    assert.equal(folded(v.el), 1, 'the resolved row folds its long question')
    assert.equal(toggles(v.el).length, 1)
    assert.equal(v.el.querySelectorAll('.answered-opt').length, 3)
  } finally { await v.unmount(); restore(); realClock() }
}
)

// the locally queued answer has no mail id or client op; the server's row for the same ask replaces it. An
// expanded question must stay expanded across that swap (found by the integrator's real queued flow)
function Swap({ first }: { first: boolean }) {
  const state = useFoldState()
  const row = first ? { id: null, ev: askEv(LONG) } : { id: 'mail-77', ev: askEv(LONG) }
  // a new key per row: the queued row UNMOUNTS and the delivered one mounts, as in the desk
  return <FoldProvider value={state.store}><EventCard key={first ? 'queued' : 'delivered'} row={row} profile="operator" org="org" preview /></FoldProvider>
}

test('§7 an expanded question stays expanded when the server row replaces the local queued one', async () => {
  useFakeClock()
  const restore = layout()
  const v = await mountView(<Swap first />, (host) => host)
  try {
    await flush(4)
    assert.equal(folded(v.el), 1, 'the queued row starts folded')
    await click(toggles(v.el)[0]!)
    assert.equal(folded(v.el), 0, 'expanded by the reader')
    await v.render(<Swap first={false} />)
    await flush(4)
    assert.equal(folded(v.el), 0, 'the server row (a mail id now, the same ask) stays expanded')
  } finally { await v.unmount(); restore(); realClock() }
})
