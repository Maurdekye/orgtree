// transcriptprepend.test.tsx — PREPENDING OLDER PAGES MUST NOT MOVE THE READER
// (user report 2026-09-20: reaching the top of an agent transcript and loading
// more history moves the viewport progressively earlier — backward through
// history — instead of holding the same visible content in place.)
//
// deskhistory.test.tsx §2/§2b pinned the anchor's job for a reader parked deep
// in ALREADY-PAGED history. What they could not see is the ordinary way a
// reader actually arrives: wheeling up through the paging trigger on a fresh
// visit. Three distinct defects live on that path, and each has its own § here
// because each fails for a different reason:
//
//   §1 THE REFUSED-PAGE CLOBBER. The trigger zone is a BAND (240px), and a
//      wheel emits many scroll events inside it. The first arms the anchor and
//      starts the page; every further event calls loadOlder() again, the store
//      refuses (a flight is already up), and the refusal handler nulled the
//      LIVE anchor of the in-flight page. The page then landed with nothing to
//      restore against: the full prepend height shoved the reader backward.
//      Two scroll events per flight is not an edge case — it is what wheeling
//      IS — so this fired on essentially every load.
//
//   §2 THE SLIDE CONFLATION, and the accumulation. The old restore spent the
//      anchor when the OLDEST RENDERED ROW's identity changed. On the first
//      flight of a visit the store's `paged` flag is still false, so a poll
//      landing mid-flight installs the raw slid tail (a busy agent appended a
//      row, the window evicted the top one): the oldest row changes with NO
//      prepend, the anchor is spent on it, and the real page lands unanchored.
//      Every fresh visit (each return to the tail resets `paged`) repeats it,
//      which is what made the jumps CUMULATIVE across a reading session.
//
//   §4 DELAYED LAYOUT. A restore that runs once, at the commit, holds nothing
//      still when a prepended row grows a beat later (markdown settling, an
//      image arriving). Nothing re-asserted the reader's place, so late growth
//      above them displaced the view after the "successful" restore.
//
//   §5 THE STALE CAPTURE. The anchor was captured when the page was REQUESTED
//      and restored where the reader WAS, overriding everything they did in
//      between: keep scrolling during the flight and the landing yanked the
//      view back to the capture point. The anchor must follow the reader.
//
//   §3/§6 are guards: §3 pins that the hold is exact under mixed row heights
//      (the fallback distance-from-bottom arithmetic is NOT, which is why the
//      hold is row-relative), and §6 that jumping to the bottom mid-flight
//      still wins over the landing page — the pin, not the anchor.
//
//   §7/§8 THE UNDELIVERED EVENT (independent review, 2026-09-20). A native
//      scroller MOVES the instant scrollTop is assigned or scrollIntoView
//      runs, but delivers the scroll event asynchronously, coalesced. A page
//      landing inside that gap found the anchor still describing the
//      pre-move position, wrote it back — undoing a move the reader had
//      already made — and the late event then carried the hold's own value,
//      which the echo check waved through. §7 races a plain scrollTop move
//      against the landing; §8 races scrollIntoView({block:'center'}), the
//      exact call reply navigation makes. Both run with the browser's own
//      scroll anchoring modelled (see below), the environment the review
//      reproduced the race in.
//
// ⚠ LAYOUT IS MODELLED, as in deskhistory.test.tsx: jsdom computes no layout,
// so offsets are installed on the prototype and scrollTop clamps and fires
// `scroll` like a real scroller. Heights are DELIBERATELY UNEQUAL per row
// (40/80/120/160 by seq) so any restore that reasons in average or bottom
// distances instead of the reader's own row is caught by arithmetic, not luck.
// §1–§6 keep the original synchronous event dispatch (delivery order is not
// what they test); §7/§8 flip `asyncScroll` and `anchored` on to model the
// real browser's asynchronous delivery and native scroll anchoring.
//
// Run:  node apps/desktop/renderer/tests/run.mjs transcriptprepend

import test from 'node:test'
import assert from 'node:assert/strict'
import { FakeServer, flush, inAct, installFetch, mountView } from './harness'
import { DeskChat } from '../src/canvas/desk'
import type { CanvasNode } from '../src/canvas/shared'
import { refreshConvo, resetConvos } from '../src/convo'
import type { ChatMessage } from '../src/types'

const W = window as unknown as Window & typeof globalThis
const VIEW_H = 400

const writer: CanvasNode = { id: 'writer', generation: 2, state: 'live', tier: 'haiku',
  children: [], seat: 1, grant: 0, free: 0, scope: { tools: {}, add_dirs: [] } }

const tops = new WeakMap<Element, number>()
const isRow = (el: Element) => el.hasAttribute?.('data-transcript-row')
const isScroller = (el: Element) => el.classList?.contains('msgs')
const rowsIn = (el: Element) => [...el.querySelectorAll('[data-transcript-row]')]
/** late-layout overrides: event id -> height. §4 grows a row AFTER its page
 *  landed, the way an image or settling markdown does. */
const grown = new Map<string, number>()
/** seq-derived height: 40/80/120/160 — every page carries all four */
const rowH = (el: Element) => {
  const id = el.getAttribute('data-reply-event') ?? ''
  const bumped = grown.get(id)
  if (bumped !== undefined) return bumped
  const seq = /^e\d+$/.test(id) ? Number(id.slice(1)) : null
  return seq === null ? 100 : 40 + (seq % 4) * 40
}
const contentH = (el: Element) =>
  Math.max(VIEW_H, rowsIn(el).reduce((sum, row) => sum + rowH(row), 0))

let writes: { from: number; to: number }[] = []

/** REAL DELIVERY IS ASYNCHRONOUS (§7/§8): the scroller's position changes the
 *  moment it is written, but the browser dispatches the scroll EVENT later —
 *  and coalesced, so one event reports only the final position. Off by
 *  default: §1–§6 were reviewed with synchronous dispatch and delivery order
 *  is not what they test. flushScroll() is the browser's delayed dispatch. */
let asyncScroll = false
const pendingScroll = new Set<HTMLElement>()
const fireScroll = (el: HTMLElement) =>
  el.dispatchEvent(new W.Event('scroll', { bubbles: false, cancelable: false }))
const emitScroll = (el: HTMLElement) => {
  if (asyncScroll) pendingScroll.add(el)
  else fireScroll(el)
}
const flushScroll = () => {
  const due = [...pendingScroll]
  pendingScroll.clear()
  due.forEach(fireScroll)
}

/** CHROMIUM'S OWN SCROLL ANCHORING, modelled (§7/§8): at layout, the browser
 *  keeps its anchor node — the first row in view — visually still by
 *  adjusting scrollTop when layout above it changes, and reports the
 *  adjustment through an (async, coalesced) scroll event of its own. Reads
 *  of scrollTop are the model's layout flush, exactly as a forced layout is
 *  in the real engine. Off by default so §1–§6 keep proving the desk's hold
 *  with no browser help, as reviewed. */
let anchored = false
const anchorSel = new WeakMap<Element, { row: Element; top: number } | null>()
const offsetOf = (scroller: Element, row: Element) => {
  let at = 0
  for (const r of rowsIn(scroller)) { if (r === row) return at; at += rowH(r) }
  return at
}
const pickAnchor = (scroller: Element, top: number) => {
  let at = 0
  for (const r of rowsIn(scroller)) {
    const h = rowH(r)
    if (at + h > top) return { row: r, top: at }
    at += h
  }
  return null
}
const settleAnchoring = (el: HTMLElement): number => {
  let cur = tops.get(el) ?? 0
  if (anchored) {
    const sel = anchorSel.get(el)
    if (sel && sel.row.isConnected && el.contains(sel.row)) {
      const delta = offsetOf(el, sel.row) - sel.top
      if (delta !== 0) {
        cur = Math.max(0, cur + delta)
        tops.set(el, cur)
        emitScroll(el)
      }
    }
    anchorSel.set(el, pickAnchor(el, cur))
  }
  return cur
}

function layout(): () => void {
  writes = []
  grown.clear()
  asyncScroll = false
  anchored = false
  pendingScroll.clear()
  const proto = W.HTMLElement.prototype as unknown as Record<string, unknown>
  const saved: Record<string, PropertyDescriptor | undefined> = {}
  const put = (name: string, d: PropertyDescriptor) => {
    saved[name] = Object.getOwnPropertyDescriptor(proto, name)
    Object.defineProperty(proto, name, { configurable: true, ...d })
  }
  put('offsetHeight', { get(this: HTMLElement) {
    return isRow(this) ? rowH(this) : isScroller(this) ? VIEW_H : 0 } })
  put('offsetTop', { get(this: HTMLElement) {
    if (!isRow(this) || !this.parentElement) return 0
    let at = 0
    for (const row of rowsIn(this.parentElement)) {
      if (row === this) return at
      at += rowH(row)
    }
    return at } })
  put('clientHeight', { get(this: HTMLElement) { return isScroller(this) ? VIEW_H : 0 } })
  put('scrollHeight', { get(this: HTMLElement) { return isScroller(this) ? contentH(this) : 0 } })
  put('scrollTop', {
    get(this: HTMLElement) {
      if (!isScroller(this)) return 0
      // a browser CLAMPS a stored offset the moment the content shrinks
      return Math.min(settleAnchoring(this), contentH(this) - VIEW_H)
    },
    set(this: HTMLElement, v: number) {
      if (!isScroller(this)) return
      const max = contentH(this) - VIEW_H
      const cur = tops.get(this) ?? 0
      const next = Math.max(0, Math.min(Number(v) || 0, max))
      writes.push({ from: cur, to: next })
      if (next === cur) return
      tops.set(this, next)
      // scrolling re-selects the browser's anchor node at the new position
      if (anchored) anchorSel.set(this, pickAnchor(this, next))
      emitScroll(this)
    },
  })
  // block:'center' the way reply navigation calls it (desk.tsx locateReply):
  // the scroller MOVES NOW; the event is emitScroll's business — delivered
  // later when §8 models the real browser
  put('scrollIntoView', { value(this: HTMLElement) {
    const s = this.closest('.msgs') as HTMLElement | null
    if (!s || !isRow(this)) return
    s.scrollTop = offsetOf(s, this) - (VIEW_H - rowH(this)) / 2
  }, writable: true })
  return () => {
    grown.clear()
    asyncScroll = false
    anchored = false
    pendingScroll.clear()
    for (const [name, d] of Object.entries(saved)) {
      if (d) Object.defineProperty(proto, name, d)
      else delete proto[name]
    }
  }
}

/** WHAT THE READER SEES: the first row whose bottom edge is below the
 *  scrollport top, and where it sits relative to that top. This pair — row
 *  identity and pixel offset — is the whole claim under test: it must be the
 *  same before a page lands and after. */
interface Sight { id: string | null; offset: number }
const sight = (s: HTMLElement): Sight => {
  const top = s.scrollTop
  let at = 0
  for (const row of rowsIn(s)) {
    const h = rowH(row)
    if (at + h > top) return { id: row.getAttribute('data-reply-event'), offset: at - top }
    at += h
  }
  return { id: null, offset: 0 }
}

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
  return {
    view, server, transport, s,
    rows: () => rowsIn(s).length,
    atBottom: () => s.scrollHeight - s.scrollTop - VIEW_H < 40,
    scrollTo: async (px: number) => {
      await inAct(async () => { s.scrollTop = px; await flush(10) })
    },
    /** a poll landing on its own schedule — NOT awaited, so it can be held */
    poll: async () => { await inAct(async () => { void refreshConvo('org', 'writer'); await flush(4) }) },
    /** let the anchor's post-land settle window run (rAF is a real 16ms timer
     *  under the harness, so this is wall-clock on purpose) */
    settle: async (ms = 80) => {
      await inAct(async () => { await new Promise((r) => setTimeout(r, ms)); await flush(6) })
    },
    unmount: async () => { await view.unmount(); resetConvos() },
  }
}

/** every fixture starts the same way: a fresh visit whose initial fill is two
 *  screens (8 rows, 800px), parked at 300 — outside the 200px paging band —
 *  with the reader unstuck. Returns the parked sight for the test to hold. */
async function parked(d: Awaited<ReturnType<typeof desk>>): Promise<Sight> {
  assert.equal(d.rows(), 8, 'fixture: the initial fill is two screens')
  assert.equal(d.atBottom(), true, 'fixture: a first load lands at the tail')
  await d.scrollTo(300)
  assert.equal(d.atBottom(), false, 'fixture: reading history')
  assert.equal(d.s.scrollTop, 300, 'fixture: parked outside the paging band')
  return sight(d.s)
}

// ─────────────────────────────── §1 the refused re-trigger must not unanchor
test('§1 THE BUG: two scroll events inside the paging band — one flight — '
  + 'still hold the reader’s row through the prepend', async () => {
  const restore = layout()
  const d = await desk(300)
  try {
    await parked(d)
    d.transport.holdAll = true
    await d.scrollTo(150)          // into the band: arms the anchor, starts the page
    assert.ok(d.transport.held.length > 0, 'fixture: a page request is in flight')
    await d.scrollTo(100)          // second event in the band: the store refuses it
    const before = sight(d.s)
    assert.ok(before.id, 'fixture: a row is on screen')
    d.transport.holdAll = false
    await inAct(async () => { d.transport.release(); await flush(12) })
    await d.settle()
    const after = sight(d.s)
    assert.ok(d.rows() > 8, `fixture: the page landed (${d.rows()} rows)`)
    assert.deepEqual(after, before,
      `the prepend moved the reader: ${before.id} at ${before.offset}px became `
      + `${after.id} at ${after.offset}px`)
  } finally { await d.unmount(); restore() }
})

// ─────────────── §2 fresh-visit flights with a mid-flight tail slide, twice
test('§2 REPEATED VISITS: a poll sliding the un-paged tail mid-flight must not '
  + 'spend the anchor, and jumps must not accumulate', async () => {
  const restore = layout()
  const d = await desk(300)
  try {
    await parked(d)
    for (let visit = 0; visit < 2; visit++) {
      d.transport.holdAll = true
      await d.scrollTo(150)        // ONE trigger only — this visit isolates the slide
      assert.ok(d.transport.held.length > 0, `visit ${visit}: a page is in flight`)
      const before = sight(d.s)
      // …a live row arrives and the poll installs the SLID tail while the
      // page is still up (the store's `paged` flag is false on a fresh visit,
      // so the install evicts the oldest rendered row)
      d.server.assistantMsg('live arrival ' + visit, { event_id: 'live' + visit })
      await d.poll()
      await inAct(async () => { d.transport.releaseLast(); await flush(12) })
      const mid = sight(d.s)
      assert.deepEqual(mid, before,
        `visit ${visit}: the mid-flight tail slide moved the reader `
        + `(${before.id}@${before.offset} -> ${mid.id}@${mid.offset})`)
      d.transport.holdAll = false
      await inAct(async () => { d.transport.release(); await flush(12) })
      await d.settle()
      const after = sight(d.s)
      assert.deepEqual(after, before,
        `visit ${visit}: the prepend went unanchored `
        + `(${before.id}@${before.offset} -> ${after.id}@${after.offset})`)
      // leave history — the collapse resets the store's `paged` flag, which is
      // exactly what makes the next visit a fresh one — then park again
      await d.scrollTo(1_000_000)
      await inAct(async () => { await flush(12) })
      assert.equal(d.atBottom(), true, `visit ${visit}: back at the tail`)
      await d.scrollTo(Math.max(0, d.s.scrollHeight - VIEW_H - 100))
      assert.equal(d.atBottom(), false, `visit ${visit}: parked for the next visit`)
    }
  } finally { await d.unmount(); restore() }
})

// ──────────────────────────── §3 the hold is exact under mixed row heights
test('§3 VARIABLE HEIGHTS: the restore holds the reader’s own row at its own '
  + 'offset — not a bottom distance that mixed heights would skew', async () => {
  const restore = layout()
  const d = await desk(300)
  try {
    await parked(d)
    // single clean trigger; the landing page carries 40/80/120/160px rows, so
    // an average- or bottom-based restore lands off by the height mix
    d.transport.holdAll = true
    await d.scrollTo(150)
    const before = sight(d.s)
    d.transport.holdAll = false
    await inAct(async () => { d.transport.release(); await flush(12) })
    await d.settle()
    assert.deepEqual(sight(d.s), before, 'the mixed-height prepend displaced the reader')
    // …and the NEXT band entry pages again, still exactly
    d.transport.holdAll = true
    await d.scrollTo(150)
    const again = sight(d.s)
    d.transport.holdAll = false
    await inAct(async () => { d.transport.release(); await flush(12) })
    await d.settle()
    assert.deepEqual(sight(d.s), again, 'the second mixed-height prepend displaced the reader')
  } finally { await d.unmount(); restore() }
})

// ───────────────────────────── §4 late growth above the reader, after landing
test('§4 DELAYED LAYOUT: a prepended row growing after the landing does not '
  + 'displace the held reader', async () => {
  const restore = layout()
  const d = await desk(300)
  try {
    await parked(d)
    d.transport.holdAll = true
    await d.scrollTo(150)
    const before = sight(d.s)
    d.transport.holdAll = false
    await inAct(async () => { d.transport.release(); await flush(12) })
    assert.ok(d.rows() > 8, 'fixture: the page landed')
    assert.deepEqual(sight(d.s), before, 'fixture: the landing itself was held')
    // a prepended row (ABOVE the reader) settles taller a beat later — the
    // image-arrived / markdown-settled case. Nothing re-renders; only layout
    // moved. The hold must re-assert within its settle window.
    const first = rowsIn(d.s)[0] as HTMLElement
    const firstId = first.getAttribute('data-reply-event')!
    grown.set(firstId, rowH(first) + 320)
    await d.settle(120)
    const after = sight(d.s)
    assert.deepEqual(after, before,
      `late growth above the reader displaced them: ${before.id}@${before.offset} `
      + `-> ${after.id}@${after.offset}`)
  } finally { await d.unmount(); restore() }
})

// ───────────────────────── §5 the reader keeps moving while the page flies
test('§5 INTENTIONAL SCROLL DURING A FLIGHT: the landing holds where the reader '
  + 'IS, never where the page was requested', async () => {
  const restore = layout()
  const d = await desk(300)
  try {
    await parked(d)
    d.transport.holdAll = true
    await d.scrollTo(150)          // request captured here…
    await d.scrollTo(260)          // …but the reader moved on (out of the band,
                                   // so nothing re-triggers — pure movement)
    const before = sight(d.s)
    d.transport.holdAll = false
    await inAct(async () => { d.transport.release(); await flush(12) })
    await d.settle()
    const after = sight(d.s)
    assert.deepEqual(after, before,
      `the landing yanked the reader back to the request point: `
      + `${before.id}@${before.offset} -> ${after.id}@${after.offset}`)
  } finally { await d.unmount(); restore() }
})

// ─────────────────────────────── §6 jumping to the bottom mid-flight wins
test('§6 GUARD: jumping to the bottom while a page is in flight ends at the '
  + 'bottom — the landing neither restores history nor moves the pin', async () => {
  const restore = layout()
  const d = await desk(300)
  try {
    await parked(d)
    d.transport.holdAll = true
    await d.scrollTo(150)
    assert.ok(d.transport.held.length > 0, 'fixture: a page request is in flight')
    // the reader gives up on history while it flies
    await d.scrollTo(1_000_000)
    assert.equal(d.atBottom(), true, 'fixture: back at the tail')
    d.transport.holdAll = false
    await inAct(async () => { d.transport.release(); await flush(12) })
    await d.settle()
    assert.equal(d.atBottom(), true,
      'the landing page pulled a bottom-following reader back into history')
  } finally { await d.unmount(); restore() }
})

// ──────────── §7 a native move whose scroll event has not been delivered
test('§7 ASYNC EVENT RACE: a move made just before the page lands is kept — '
  + 'the landing must not restore the pre-move anchor', async () => {
  const restore = layout()
  const d = await desk(300)
  try {
    await parked(d)
    d.transport.holdAll = true
    await d.scrollTo(150)          // delivered: arms the anchor, starts the page
    assert.ok(d.transport.held.length > 0, 'fixture: a page request is in flight')
    // from here the browser is real: the scroller moves NOW, the event
    // arrives LATER and coalesced, and native scroll anchoring is on
    asyncScroll = true
    anchored = true
    d.s.scrollTop = 260            // the reader's move — its event is now in flight
    const before = sight(d.s)
    assert.ok(before.id, 'fixture: a row is on screen')
    d.transport.holdAll = false
    await inAct(async () => { d.transport.release(); await flush(12) })   // the page lands FIRST…
    await inAct(async () => { flushScroll(); await flush(4) })            // …the event arrives after
    await d.settle()
    const after = sight(d.s)
    assert.ok(d.rows() > 8, `fixture: the page landed (${d.rows()} rows)`)
    assert.deepEqual(after, before,
      `the landing undid a move its event had not reported yet: `
      + `${before.id}@${before.offset} -> ${after.id}@${after.offset}`)
  } finally { await d.unmount(); restore() }
})

// ─────────────── §8 navigation's scrollIntoView racing the landing page
test('§8 NAVIGATION RACE: scrollIntoView just before the page lands is kept — '
  + 'reply navigation must not be undone by the landing', async () => {
  const restore = layout()
  const d = await desk(300)
  try {
    await parked(d)
    d.transport.holdAll = true
    await d.scrollTo(150)          // delivered: arms the anchor, starts the page
    assert.ok(d.transport.held.length > 0, 'fixture: a page request is in flight')
    asyncScroll = true
    anchored = true
    // reply navigation centres the located row exactly like this (desk.tsx
    // locateReply) — the scroller moves now, the event arrives later
    const target = rowsIn(d.s)
      .find(r => r.getAttribute('data-reply-event') === 'e297') as HTMLElement
    assert.ok(target, 'fixture: the navigation target is rendered')
    target.scrollIntoView({ block: 'center' })
    const before = sight(d.s)
    assert.ok(before.id, 'fixture: a row is on screen')
    d.transport.holdAll = false
    await inAct(async () => { d.transport.release(); await flush(12) })
    await inAct(async () => { flushScroll(); await flush(4) })
    await d.settle()
    const after = sight(d.s)
    assert.deepEqual(after, before,
      `the landing undid the navigation: `
      + `${before.id}@${before.offset} -> ${after.id}@${after.offset}`)
  } finally { await d.unmount(); restore() }
})
