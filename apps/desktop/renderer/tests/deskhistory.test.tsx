// deskhistory.test.tsx — READING BACK THROUGH A DESK'S HISTORY
// (user report 2026-09-12: "scrolling too far toward older messages cuts off
// loaded history and forces the view back to the bottom"; then "sending a
// message collapses visible history to about the last dozen events for a split
// second"; then "on a tall pinned Desk that frame jumps the view upward
// substantially, then it comes back down".)
//
// THREE SYMPTOMS, TWO DEFECTS, ONE CASCADE — read off a trace of every
// scrollTop write during one upward scroll on a tall desk:
//
//   set scrollTop 1200 -> 300    the reader scrolls up
//   set scrollTop  300 -> 1200   a STALE growAnchor puts them back
//   set scrollTop 1200 -> 0      rows 24 -> 8: the window collapsed
//   set scrollTop    0 -> 1200   refilled to 24, parked at the bottom
//
//   D1 — THE STALE ANCHOR. `growAnchor` is a distance from the BOTTOM, taken
//   when older rows are requested so that prepending them does not move the
//   reader. The layout effect consumed and cleared it only on the not-stuck
//   branch; the stuck branch returned early and left it set. An anchor taken
//   while the reader sat at the tail (where that distance IS the viewport)
//   therefore waited, and the first render after they scrolled up restored
//   them to exactly the distance it recorded: the bottom. A tall desk hits it
//   on the FIRST scroll, because `fillViewport` requests a page for every
//   screen it still needs while the reader is at the tail.
//
//   D2 — THE COLLAPSE FLOOR. Landing back at the bottom flips the sticky flag
//   false->true, which is the "reader left history" signal, which collapsed
//   the window to CHAT_WINDOW — EIGHT rows — however tall the desk was. On a
//   desk drawing 24 rows that discards two thirds of what is on screen. It is
//   also what `send()` does through toBottom(), which is the send-time frame.
//
// WHAT IS ASSERTED HERE, and why each would fail for a different reason:
//   §1  the traced bug: no snap, no cutoff, on the exact fixture that traced.
//   §2  the anchor still does its real job — prepended history must not move
//       the reader. §1 alone would pass if the anchor were deleted outright.
//   §3  bottom-following still works AND still does not fire while reading
//       history. A fix that simply stopped pinning would pass §1 and fail §3.
//   §4  the send frames are flat — the reported tall-desk jump.
//   §5  THE PERFORMANCE CONTRACT IS KEPT: leaving history really does still
//       collapse the window. A fix that just stopped collapsing would pass
//       everything above and fail here, and would undo the perf work that
//       collapseWindow exists for.
//
// ⚠ WHY LAYOUT IS MODELLED. jsdom performs no layout: every offsetHeight and
// scrollHeight reads 0, so transcriptViewport() returns {more:0}, nearBottom()
// is permanently true, and NONE of this machinery runs. A scroll test without
// `layout()` is not a weak test, it is a vacuous one — it would have passed
// against the broken code. `layout()` installs what a browser would report and
// makes scrollTop clamp and fire `scroll` the way a real scroller does.
//
// Run:  node apps/desktop/renderer/tests/run.mjs deskhistory

import test from 'node:test'
import assert from 'node:assert/strict'
import { FakeServer, flush, inAct, installFetch, mountView } from './harness'
import { DeskChat } from '../src/canvas/desk'
import type { CanvasNode } from '../src/canvas/shared'
import { refreshConvo, resetConvos } from '../src/convo'
import type { ChatMessage } from '../src/types'

const W = window as unknown as Window & typeof globalThis
const ROW_H = 100
/** a desk one screen tall (4 rows) and a tall pinned desk (12 rows) */
const SHORT = 400, TALL = 1200
let VIEW_H = SHORT

const writer: CanvasNode = { id: 'writer', generation: 2, state: 'live', tier: 'haiku',
  children: [], seat: 1, grant: 0, free: 0, scope: { tools: {}, add_dirs: [] } }

const tops = new WeakMap<Element, number>()
const isRow = (el: Element) => el.hasAttribute?.('data-transcript-row')
const isScroller = (el: Element) => el.classList?.contains('msgs')
const rowsIn = (el: Element) => [...el.querySelectorAll('[data-transcript-row]')]
const contentH = (el: Element) => Math.max(VIEW_H, rowsIn(el).length * ROW_H)

/** every scrollTop write, so a test can say WHO moved the view and where to */
let writes: { from: number; to: number; asked: number; rows: number }[] = []

function layout(viewH: number): () => void {
  VIEW_H = viewH
  writes = []
  const proto = W.HTMLElement.prototype as unknown as Record<string, unknown>
  const saved: Record<string, PropertyDescriptor | undefined> = {}
  const put = (name: string, d: PropertyDescriptor) => {
    saved[name] = Object.getOwnPropertyDescriptor(proto, name)
    Object.defineProperty(proto, name, { configurable: true, ...d })
  }
  put('offsetHeight', { get(this: HTMLElement) {
    return isRow(this) ? ROW_H : isScroller(this) ? VIEW_H : 0 } })
  put('offsetTop', { get(this: HTMLElement) {
    if (!isRow(this) || !this.parentElement) return 0
    return rowsIn(this.parentElement).indexOf(this) * ROW_H } })
  put('clientHeight', { get(this: HTMLElement) { return isScroller(this) ? VIEW_H : 0 } })
  put('scrollHeight', { get(this: HTMLElement) { return isScroller(this) ? contentH(this) : 0 } })
  put('scrollTop', {
    get(this: HTMLElement) {
      if (!isScroller(this)) return 0
      // a browser CLAMPS a stored offset the moment the content shrinks
      return Math.min(tops.get(this) ?? 0, contentH(this) - VIEW_H)
    },
    set(this: HTMLElement, v: number) {
      if (!isScroller(this)) return
      const max = contentH(this) - VIEW_H
      const cur = tops.get(this) ?? 0
      const next = Math.max(0, Math.min(Number(v) || 0, max))
      writes.push({ from: cur, to: next, asked: Math.round(Number(v) || 0),
        rows: rowsIn(this).length })
      if (next === cur) return
      tops.set(this, next)
      this.dispatchEvent(new W.Event('scroll', { bubbles: false, cancelable: false }))
    },
  })
  return () => {
    VIEW_H = SHORT
    for (const [name, d] of Object.entries(saved)) {
      if (d) Object.defineProperty(proto, name, d)
      else delete proto[name]
    }
  }
}

interface Shot { rows: number; height: number; top: number; oldest: number | null }

async function desk(count: number) {
  localStorage.clear(); resetConvos()
  const server = new FakeServer()
  server.cursorPages = true
  for (let i = 0; i < count; i++) {
    server.messages.push({ role: i % 2 ? 'assistant' : 'user', text: 'message ' + i,
      seq: i, event_id: 'e' + i } as ChatMessage)
  }
  const transport = installFetch(server)
  const view = await mountView(
    <DeskChat node={writer} map={new Map([[writer.id, writer]])} slug="org"
      op={async () => ({})} toast={() => {}} pub={false} bare />, el => el)
  await inAct(async () => { await refreshConvo('org', 'writer'); await flush(10) })
  const s = view.el.querySelector('.msgs') as HTMLElement
  const shot = (): Shot => {
    const id = s.querySelector('[data-transcript-row]')?.getAttribute('data-reply-event') ?? ''
    return { rows: rowsIn(s).length, height: s.scrollHeight, top: s.scrollTop,
      oldest: /^e\d+$/.test(id) ? Number(id.slice(1)) : null }
  }
  // EVERY intermediate DOM state — the send defect is a frame that exists for
  // a split second, and mountView.frames only records explicit re-renders
  const seen: Shot[] = []
  const obs = new W.MutationObserver(() => { seen.push(shot()) })
  obs.observe(view.el, { childList: true, subtree: true })
  return {
    view, server, transport, s, shot, seen,
    mark: () => seen.length,
    since: (n: number) => seen.slice(n),
    atBottom: () => s.scrollHeight - s.scrollTop - VIEW_H < 40,
    scrollBy: async (px: number) => {
      await inAct(async () => { s.scrollTop = s.scrollTop + px; await flush(10) })
    },
    poll: async () => { await inAct(async () => { await refreshConvo('org', 'writer'); await flush(10) }) },
    send: async (text: string) => {
      const ta = view.el.querySelector('textarea') as HTMLTextAreaElement
      await inAct(() => {
        Object.getOwnPropertyDescriptor(W.HTMLTextAreaElement.prototype, 'value')!
          .set!.call(ta, text)
        ta.dispatchEvent(new W.Event('input', { bubbles: true }))
      })
      const btn = view.el.querySelector('button.cc-send') as HTMLButtonElement
      assert.ok(btn && !btn.disabled, 'the send button is missing or disabled')
      await inAct(async () => { btn.click(); await flush(12) })
    },
    unmount: async () => { obs.disconnect(); await view.unmount(); resetConvos() },
  }
}

// ──────────────────────────────────────────────────── §1 the reported bug

test('§1 THE BUG: scrolling up a TALL desk neither snaps to the bottom nor '
  + 'cuts off loaded history', async () => {
  const restore = layout(TALL)
  const d = await desk(300)
  try {
    const start = d.shot()
    assert.equal(start.rows, 24, 'fixture: a 1200px desk fills two screens')
    assert.equal(d.atBottom(), true, 'fixture: a first load lands at the tail')
    let rows = start.rows, oldest = start.oldest!
    for (let step = 0; step < 12; step++) {
      await d.scrollBy(-900)
      const now = d.shot()
      assert.equal(d.atBottom(), false,
        `step ${step}: the view was forced back to the newest message`)
      assert.ok(now.rows >= rows,
        `step ${step}: loaded history was cut off (${rows} rows -> ${now.rows})`)
      assert.ok(now.oldest !== null && now.oldest <= oldest,
        `step ${step}: the oldest loaded message went forward (${oldest} -> ${now.oldest})`)
      rows = now.rows; oldest = now.oldest!
    }
    assert.ok(rows > start.rows * 4,
      `twelve screens of upward scrolling should page history in; got ${rows} rows`)
  } finally { await d.unmount(); restore() }
})

test('§1b …and nothing writes a scroll to the bottom while it happens',
  async () => {
    // the trace is the evidence: with the stale anchor in place, ONE upward
    // scroll produced a write back to the exact bottom. Assert on the writes,
    // not just the end state, so a fix that merely lands somewhere plausible
    // after bouncing does not pass.
    const restore = layout(TALL)
    const d = await desk(300)
    try {
      const before = writes.length
      await d.scrollBy(-900)
      const during = writes.slice(before)
      const toBottom = during.filter(w => w.to > 0 && w.to === w.rows * ROW_H - VIEW_H
        && w.from < w.to)
      assert.deepEqual(toBottom, [],
        `one upward scroll wrote the view back to the bottom: ${JSON.stringify(during)}`)
    } finally { await d.unmount(); restore() }
  })

test('§1c repeated input at and beyond the top boundary is stable', async () => {
  const restore = layout(SHORT)
  const d = await desk(60)
  try {
    for (let i = 0; i < 30; i++) await d.scrollBy(-10_000)   // slam into the top
    const a = d.shot()
    for (let i = 0; i < 10; i++) await d.scrollBy(-10_000)
    const b = d.shot()
    assert.equal(d.atBottom(), false, 'wheeling at the top boundary ended at the bottom')
    assert.ok(b.rows >= a.rows, `history shrank at the boundary (${a.rows} -> ${b.rows})`)
    assert.ok(b.oldest !== null && b.oldest <= (a.oldest ?? Infinity),
      'the oldest loaded message moved forward at the boundary')
  } finally { await d.unmount(); restore() }
})

// ───────────────────────────────────────── §2 the anchor still anchors

test('§2 prepending older history keeps the reader on the same message',
  async () => {
    // §1 would ALSO pass if the anchor were simply deleted, so this pins the
    // job it exists for. What is invariant when rows are added ABOVE a reader
    // is their distance from the BOTTOM; it is measured across the prepend
    // itself, with the page HELD so the two readings bracket exactly one
    // insert and nothing else.
    const restore = layout(SHORT)
    const d = await desk(300)
    try {
      await d.scrollBy(-250)                       // off the tail, into history
      assert.equal(d.atBottom(), false, 'fixture: reading history')
      d.transport.holdAll = true
      await d.scrollBy(-d.shot().top)              // reach the paging trigger
      const before = d.shot()
      const distance = before.height - before.top  // the invariant
      d.transport.holdAll = false
      await inAct(async () => { d.transport.release(); await flush(12) })
      const after = d.shot()
      assert.ok(after.rows > before.rows,
        `fixture: a page should have settled (${before.rows} -> ${after.rows} rows)`)
      assert.ok(after.height > before.height, 'fixture: the content grew')
      assert.equal(after.height - after.top, distance,
        `the prepend moved the reader: they were ${distance}px from the newest `
        + `message and are now ${after.height - after.top}px from it`)
    } finally { await d.unmount(); restore() }
  })

// ─────────────────────────────────── §3 bottom-following, both directions

test('§3 a reader AT the tail still follows new messages', async () => {
  const restore = layout(SHORT)
  const d = await desk(40)
  try {
    assert.equal(d.atBottom(), true, 'fixture: starts at the tail')
    d.server.assistantMsg('brand new', { event_id: 'new-1' })
    await d.poll()
    assert.equal(d.atBottom(), true,
      'a reader at the tail stopped following new messages')
    assert.ok(d.view.el.textContent?.includes('brand new'), 'the new message rendered')
  } finally { await d.unmount(); restore() }
})

test('§3b …and a reader IN history is not dragged down by one', async () => {
  const restore = layout(SHORT)
  const d = await desk(300)
  try {
    await d.scrollBy(-250)
    const before = d.shot()
    assert.equal(d.atBottom(), false, 'fixture: reading history')
    d.server.assistantMsg('brand new', { event_id: 'new-1' })
    await d.poll()
    assert.equal(d.atBottom(), false,
      'an arriving message dragged a history reader to the newest message')
    assert.ok(d.shot().rows >= before.rows, 'the arriving message cost loaded history')
  } finally { await d.unmount(); restore() }
})

// ───────────────────────────────────────────────── §4 the send-time frame

test('§4 THE BUG: sending from a TALL desk shows no collapsed frame and no jump',
  async () => {
    const restore = layout(TALL)
    const d = await desk(300)
    try {
      const before = d.shot()
      assert.ok(before.rows >= 24, `fixture: tall desk draws ${before.rows} rows`)
      const mark = d.mark()
      await d.send('a new message')
      await inAct(async () => { await flush(12) })
      const frames = d.since(mark)
      assert.ok(frames.length, 'fixture: the send re-rendered the transcript')
      const minRows = Math.min(...frames.map(f => f.rows))
      const minHeight = Math.min(...frames.map(f => f.height))
      assert.ok(minRows >= before.rows,
        `the transcript collapsed to ${minRows} rows mid-send (was ${before.rows}): `
        + JSON.stringify(frames))
      assert.ok(minHeight >= before.height,
        `the rendered height dropped to ${minHeight} mid-send (was ${before.height}): `
        + JSON.stringify(frames))
    } finally { await d.unmount(); restore() }
  })

test('§4b …across the whole send: optimistic ghost, acknowledgement and refresh',
  async () => {
    const restore = layout(TALL)
    const d = await desk(300)
    try {
      const before = d.shot()
      const mark = d.mark()
      await d.send('a new message')
      // the server then echoes it and the next poll lands — the two later
      // phases of the same send
      d.server.postMail('a new message')
      d.server.drain(); d.server.echo()
      await d.poll()
      await d.poll()
      const frames = d.since(mark)
      const minRows = Math.min(...frames.map(f => f.rows))
      assert.ok(minRows >= before.rows,
        `a later phase of the send collapsed the transcript to ${minRows} rows `
        + `(was ${before.rows}): ${JSON.stringify(frames.map(f => f.rows))}`)
    } finally { await d.unmount(); restore() }
  })

// ────────────────────────── §5 the performance contract this must not undo

test('§5 leaving history DOES still collapse the poll window — bounded by what '
  + 'the desk draws, never below it', async () => {
  // ANTI-VACUITY. collapseWindow exists so that one deep history visit does
  // not leave every later 2.5s poll re-shipping thousands of rows. A fix that
  // simply stopped collapsing would pass every test above and silently undo
  // that. Here the reader pages deep, then returns to the tail: the loaded set
  // must come back DOWN, and must stop at what the viewport needs.
  const restore = layout(SHORT)
  const d = await desk(300)
  try {
    for (let i = 0; i < 10; i++) await d.scrollBy(-10_000)
    const deep = d.shot()
    assert.ok(deep.rows > 40, `fixture: paged deep, got ${deep.rows} rows`)
    // back down to the newest message — the "left history" signal
    await d.scrollBy(10_000_000)
    await inAct(async () => { await flush(12) })
    const back = d.shot()
    assert.ok(back.rows < deep.rows,
      `returning to the tail did not collapse the window (${deep.rows} -> ${back.rows}) `
      + '— the polling cost of a deep visit would persist forever')
    const needed = Math.ceil((VIEW_H * 2) / ROW_H)
    assert.ok(back.rows >= needed,
      `the window collapsed below what the desk draws (${back.rows} rows < ${needed})`)
    assert.equal(d.atBottom(), true, 'and the reader is at the tail they scrolled to')
  } finally { await d.unmount(); restore() }
})

test('§5b a TALL desk collapses to ITS viewport, not to the small-desk floor',
  async () => {
    const restore = layout(TALL)
    const d = await desk(300)
    try {
      for (let i = 0; i < 10; i++) await d.scrollBy(-10_000)
      const deep = d.shot()
      assert.ok(deep.rows > 40, `fixture: paged deep, got ${deep.rows}`)
      await d.scrollBy(10_000_000)
      await inAct(async () => { await flush(12) })
      const back = d.shot()
      assert.ok(back.rows >= 24,
        `a tall desk was collapsed to ${back.rows} rows — below the 24 it draws`)
      assert.ok(back.rows < deep.rows, 'the window did not collapse at all')
    } finally { await d.unmount(); restore() }
  })
