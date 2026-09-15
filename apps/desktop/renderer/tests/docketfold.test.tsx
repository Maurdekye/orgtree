// docketfold.test.tsx — A MEASUREMENT THAT HAS NOT MOVED IS NOT A STATE CHANGE.
//
// `foldAt` builds a fresh `{limit, lines}` on every call, so storing its result
// blindly is a state change to React even when the answer is identical —
// `foldlines.ts` says exactly that, which is why `sameFold` exists.
// `canvas/mailpreview.tsx` guarded its measurement with it;
// `canvas/docketdesc.tsx` did not, and wrote straight from a ResizeObserver.
// So every resize of a docket description re-rendered it, and the docket pane
// is resizable, lives on a zoomable canvas, and re-measures on window resize
// too.
//
// WHY THIS SURFACE IS THE ONE WORTH PINNING. `DocketDescription` is the only
// caller that passes `mentions`, i.e. the only place bare docket item names are
// rewritten into reference chips. Chips have different metrics from the text
// they replace, so injecting them CHANGES the body's size — and the observer
// here watches size. The ingredients of a feedback loop are all present; only
// `linkifyRefs`' cheap exit keeps the DOM still. Measured in the real browser
// (see the item's evidence) that chain settles, so the unguarded write cost
// renders rather than running away — but a wasted render on this path is a
// re-measure that walks every text node of an arbitrarily long spec, and the
// guard is one line.
//
// THE ASSERTION IS COMMIT COUNT, via React's own Profiler, not the absence of
// a thrown error: a loop React has not yet capped is still the defect, and
// "it did not crash" would have passed before the fix too.
//
// ANTI-VACUITY: §1 proves the resizes are actually delivered (the fold is
// measured and the control appears), so §2's "no further commits" cannot pass
// by nothing having happened. §3 holds the other direction — a resize that
// REALLY changes the answer must still re-render, or the guard would have
// frozen the fold instead of stabilising it.
//
// Run:  node apps/desktop/renderer/tests/run.mjs docketfold

import './harness'
import { fireResize, flush, inAct, mountView, resizeWatchers } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { Profiler } from 'react'
import type { ReactNode } from 'react'
import { DocketDescription } from '../src/canvas/docketdesc'
import { buildMentionIndex } from '../src/canvas/workrefs'
import type { WorkItem } from '../src/types'
import type { RefWorld } from '../src/canvas/reflinks'

const WORLD: RefWorld = { org: 'org1', items: new Map(), agents: new Map() }
const LINE = 20, HEIGHT = 16

/** one 16px row per text node, 20px apart — the same stand-in docketdesc.test.tsx
 *  uses, because jsdom does no layout and the real `foldAt` would otherwise
 *  answer "nothing to fold" for every input. */
function layout() {
  const win = (globalThis as unknown as { window: Window & typeof globalThis }).window
  const proto = win.HTMLElement.prototype
  const realRect = proto.getBoundingClientRect
  const realWidth = Object.getOwnPropertyDescriptor(proto, 'offsetWidth')
  const realRects = win.Range.prototype.getClientRects
  const seen = new Map<Node, number>()
  proto.getBoundingClientRect = function () {
    return { top: 0, left: 0, right: 400, bottom: 1000, width: 400, height: 1000,
      x: 0, y: 0, toJSON: () => ({}) } as DOMRect
  }
  Object.defineProperty(proto, 'offsetWidth', { configurable: true, get: () => 400 })
  win.Range.prototype.getClientRects = function (this: Range) {
    const node = this.startContainer
    if (!seen.has(node)) seen.set(node, seen.size)
    const i = seen.get(node)!
    return [{ top: i * LINE, bottom: i * LINE + HEIGHT, left: 0, right: 200,
      width: 200, height: HEIGHT, x: 0, y: i * LINE, toJSON: () => ({}) } as DOMRect
    ] as unknown as DOMRectList
  }
  return () => {
    proto.getBoundingClientRect = realRect
    if (realWidth) Object.defineProperty(proto, 'offsetWidth', realWidth)
    else delete (proto as unknown as Record<string, unknown>).offsetWidth
    win.Range.prototype.getClientRects = realRects
  }
}

/** a description long enough to fold, naming items so `mentions` really does
 *  rewrite the DOM inside the body the observer is watching */
const SPEC = [
  'Problem stated, then the proposed solution.',
  'It is blocked behind the-other-ticket until that lands.',
  ...Array.from({ length: 24 }, (_, i) => `Requirement ${i + 1}, stated in full.`),
].join('\n\n')

const INDEX = buildMentionIndex([
  { slug: 'the-other-ticket', title: 'The other ticket' } as WorkItem,
])

const body = (el: HTMLElement) => el.querySelector('.docket-desc-body') as HTMLElement
const toggle = (el: HTMLElement) => el.querySelector('.docket-desc-toggle')

interface Mounted { el: HTMLElement; commits: () => number; reset: () => void
  unmount: () => Promise<void> }

async function mount(text = SPEC, onPick: (s: string) => void = () => {}): Promise<Mounted> {
  let count = 0
  const wrap = (children: ReactNode) =>
    <Profiler id="desc" onRender={() => { count++ }}>{children}</Profiler>
  const view = await mountView(
    wrap(<DocketDescription world={WORLD} slug="an-item" index={INDEX}
      onPick={onPick} text={text} />), (el) => el)
  await inAct(async () => { await flush(4) })
  return {
    el: view.el,
    commits: () => count,
    reset: () => { count = 0 },
    unmount: () => view.unmount(),
  }
}

// ───────────────────────────────────────────────────────────────────────────

test('§1 the rig is real: the body is watched, folded, and its chips are injected',
  { timeout: 20_000 }, async () => {
    const restore = layout()
    const m = await mount()
    try {
      const b = body(m.el)
      assert.ok(b, 'the description body must render')
      assert.ok(resizeWatchers(b) > 0,
        'nothing is observing the body — a resize would reach no one and §2 would pass vacuously')
      assert.ok(toggle(m.el), 'the description must be long enough to fold, or there is nothing to measure')
      assert.ok(b.querySelector('.docket-ref'),
        'the bare item name must become a chip, or this is not the mentions surface')
    } finally { await m.unmount(); restore() }
  })

test('§2 THE DEFECT: repeated resizes that do not move the answer must not re-render',
  { timeout: 20_000 }, async () => {
    const restore = layout()
    const m = await mount()
    try {
      const b = body(m.el)
      m.reset()
      for (let i = 0; i < 10; i++) await inAct(async () => { fireResize(b); await flush(2) })
      assert.ok(m.commits() <= 1,
        `ten resizes with an unchanged measurement caused ${m.commits()} commits. `
        + '`foldAt` returns a fresh object every call, so an unguarded '
        + 'setMeasure makes every measurement look like a change.')
    } finally { await m.unmount(); restore() }
  })

test('§3 …but a resize that DOES move the answer still re-renders',
  { timeout: 20_000 }, async () => {
    const restore = layout()
    const m = await mount()
    try {
      const b = body(m.el)
      m.reset()
      // widen the rows so the same text measures to fewer lines: the guard must
      // stabilise the fold, never freeze it
      const win = (globalThis as unknown as { window: Window & typeof globalThis }).window
      const seen = new Map<Node, number>()
      win.Range.prototype.getClientRects = function (this: Range) {
        const node = this.startContainer
        if (!seen.has(node)) seen.set(node, seen.size)
        const i = seen.get(node)!
        // half the pitch: every pair of text nodes now shares one visual row
        return [{ top: Math.floor(i / 2) * LINE, bottom: Math.floor(i / 2) * LINE + HEIGHT,
          left: (i % 2) * 200, right: (i % 2) * 200 + 200, width: 200, height: HEIGHT,
          x: (i % 2) * 200, y: Math.floor(i / 2) * LINE, toJSON: () => ({}) } as DOMRect
        ] as unknown as DOMRectList
      }
      await inAct(async () => { fireResize(b); await flush(2) })
      assert.ok(m.commits() >= 1,
        'a genuinely different measurement was swallowed — the guard froze the fold')
    } finally { await m.unmount(); restore() }
  })
