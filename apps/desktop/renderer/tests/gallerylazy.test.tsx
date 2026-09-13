// gallerylazy.test.tsx — the presented-documents list loads CONTINUOUSLY.
//
// The panel used to carry "Newer" and "Older" buttons over a fixed page, which
// is not how anything else in this app browses a long list. The user asked for
// the pattern every comparable surface already uses: a bounded first window,
// and the next older page fetched as you reach the bottom.
//
// ⚠ WHY LAYOUT IS MODELLED. jsdom performs no layout, so a scroller reports
// clientHeight 0, scrollHeight 0 and scrollTop 0 — and those three subtract to
// "you are at the bottom". A scroll test without `layout()` is not a weak
// test, it is a vacuous one: the boundary check would fire on the first commit
// whatever the code did, and the whole history would page in before the first
// assertion. `layout()` installs what a browser reports and makes scrollTop
// clamp and fire `scroll` the way a real scroller does. The component's own
// `clientHeight > 0` guard is what keeps an unmeasured panel from doing this
// for real, and §2 fails without it.
//
// WHAT EACH SECTION WOULD CATCH, since each fails for a different reason:
//   §1  the buttons are gone — the visible half of the request.
//   §2  the FIRST window is bounded. A fix that simply asked for everything
//       would pass every scrolling test below and fail here.
//   §3  the boundary actually loads, appends, and keeps newest-first order.
//   §4  the list stays duplicate-free and gap-free while documents arrive
//       underneath the reader — the failure mode an offset cursor has and a
//       window read from zero does not.
//   §5  it STOPS at the end of the history instead of asking forever.
//   §6  a failed page keeps what is loaded, says so, and can be asked again.
//   §7  the reader is not moved by a page landing, or by an ordinary poll.
//   §8  selection and the open document survive a growth.
//   §9  a filter that empties the WINDOW does not stop the loading, or the
//       panel would report an empty gallery over a full one.
//   §10 the agent-scoped list on the desk is the same list, with no buttons.
//   §11 a reference or notification aimed at a document below the window
//       widens the window to reach it rather than hopping to a middle slice.
//   §12 the FIRST request failing is reported as a failure, not as an empty
//       gallery — the end marker cannot speak when there are no rows.
//   §13 and a jump no window can reach gives up after ONE correction, which
//       is the difference between one unanswered jump and a request loop.
//   §14 the scroller is a labelled TAB STOP. Scrolling is the only route to
//       older documents now, and the two controls a keyboard could reach are
//       the ones this change deleted — so if the list is not focusable in its
//       own right, the older half of the history is pointer-only.
//
// Run:  node apps/desktop/renderer/tests/run.mjs gallerylazy

import { advance, flush, inAct, mountView, realClock, useFakeClock } from './harness'
import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { AgentGalleryView, DOC_PAGE, DocGalleryModal } from '../src/canvas/gallery'
import type { DocRow } from '../src/api'

const W = window as unknown as Window & typeof globalThis

// ---------------------------------------------------------------- fixtures

const row = (o: Partial<DocRow>): DocRow => ({
  id: 'd1', node: 'agent1', title: 'a plan', at: '2026-09-03T00:00:00.000Z',
  evicted: false, node_state: 'live', ...o,
})

/** `n` documents, newest first, exactly as the server orders them */
const many = (n: number, o: (i: number) => Partial<DocRow> = () => ({})): DocRow[] =>
  Array.from({ length: n }, (_, i) => row({
    id: `d${i}`, title: `document ${i}`,
    at: new Date(Date.UTC(2026, 8, 13) - i * 60_000).toISOString(),
    ...o(i),
  }))

interface ListCall { offset: number; limit: number; node: string; locate: string }

/** The documents endpoint, faithfully: `engine/backend/orgtree/api.py`
 *  `documents_list` filters by node, clamps the limit, snaps a `locate` to its
 *  page, and answers `{documents, total, offset, located, next_offset}`. The
 *  paging contract is the thing under test, so the fake has to keep it. */
function serve(all: DocRow[], bodies: Record<string, string> = {}) {
  const s = {
    all, list: [] as ListCall[], bodyCalls: [] as string[],
    /** reject the next N LIST requests (the body route is unaffected) */
    fail: 0, failWith: 'the engine is not answering',
    /** the newest end of the list can move while a reader is in it */
    present(r: DocRow) { s.all = [r, ...s.all] },
    dismissTop(n: number) { s.all = s.all.slice(n) },
    /** answer every `locate` with this offset however wide the window — the
     *  pathological server the correction latch exists for */
    stubborn: 0,
  }
  const headers = new Headers()
  const ok = (body: unknown) => Promise.resolve(
    { ok: true, status: 200, headers, json: () => Promise.resolve(body) })
  const bad = (status: number, detail: string) => Promise.resolve(
    { ok: false, status, headers, statusText: 'Error',
      json: () => Promise.resolve({ detail }) })
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch =
    ((url: string, init?: RequestInit) => {
      const path = String(url)
      if ((init?.method ?? 'GET') === 'DELETE') return ok({ ok: true, node: 'agent1' })
      const one = path.match(/\/documents\/([^/?]+)$/)
      if (one) {
        const id = one[1]!
        s.bodyCalls.push(id)
        const r = s.all.find((x) => x.id === id)
        if (!r || bodies[id] == null) return bad(404, `no document ${id}`)
        return ok({ id, node: r.node, title: r.title, at: r.at, body: bodies[id] })
      }
      const q = new URL(path, 'http://host').searchParams
      const node = q.get('node') ?? ''
      const locate = q.get('locate') ?? ''
      const limit = Math.max(1, Math.min(Number(q.get('limit') ?? 100), 5000))
      let offset = Math.max(0, Number(q.get('offset') ?? 0))
      s.list.push({ offset, limit, node, locate })
      if (s.fail > 0) { s.fail--; return bad(503, s.failWith) }
      const rows = node ? s.all.filter((r) => r.node === node) : s.all
      if (locate) {
        const i = rows.findIndex((r) => r.id === locate && !r.evicted)
        if (i < 0) return bad(404, 'The presented document is no longer available.')
        offset = s.stubborn || Math.floor(i / limit) * limit
      }
      return ok({
        documents: rows.slice(offset, offset + limit), total: rows.length,
        offset, located: locate,
        next_offset: offset + limit < rows.length ? offset + limit : null,
      })
    }) as typeof fetch
  return s
}

// ------------------------------------------------------------------ layout
//
// One scroller (`.mailer-list`), rows of a fixed height, and a status line at
// the end that takes one row's worth. A viewport DELIBERATELY shorter than the
// first window: the point of §2 is that the first page overflows it, so
// nothing grows until the reader asks.

const ROW_H = 40
const VIEW_H = 400
const isRow = (el: Element) => el.classList?.contains('mailrow')
const isScroller = (el: Element) => el.classList?.contains('mailer-list')
const rowsIn = (el: Element) => [...el.querySelectorAll('.mailrow')]
const contentH = (el: Element) =>
  rowsIn(el).length * ROW_H + (el.querySelector('.doc-list-end') ? ROW_H : 0)
const tops = new WeakMap<Element, number>()

function layout(): () => void {
  const proto = W.HTMLElement.prototype as unknown as Record<string, unknown>
  const saved: Record<string, PropertyDescriptor | undefined> = {}
  const put = (name: string, d: PropertyDescriptor) => {
    saved[name] = Object.getOwnPropertyDescriptor(proto, name)
    Object.defineProperty(proto, name, { configurable: true, ...d })
  }
  put('offsetHeight', { get(this: HTMLElement) {
    return isRow(this) ? ROW_H : isScroller(this) ? VIEW_H : 0 } })
  put('clientHeight', { get(this: HTMLElement) { return isScroller(this) ? VIEW_H : 0 } })
  put('scrollHeight', { get(this: HTMLElement) {
    return isScroller(this) ? Math.max(VIEW_H, contentH(this)) : 0 } })
  put('scrollTop', {
    get(this: HTMLElement) {
      if (!isScroller(this)) return 0
      // a browser CLAMPS a stored offset the moment the content shrinks
      return Math.min(tops.get(this) ?? 0, Math.max(0, contentH(this) - VIEW_H))
    },
    set(this: HTMLElement, v: number) {
      if (!isScroller(this)) return
      const max = Math.max(0, contentH(this) - VIEW_H)
      const cur = tops.get(this) ?? 0
      const next = Math.max(0, Math.min(Number(v) || 0, max))
      if (next === cur) return
      tops.set(this, next)
      this.dispatchEvent(new W.Event('scroll', { bubbles: false, cancelable: false }))
    },
  })
  return () => {
    for (const [name, d] of Object.entries(saved)) {
      if (d) Object.defineProperty(proto, name, d)
      else delete proto[name]
    }
  }
}

// ------------------------------------------------------------------- tools

const noop = () => {}
const rows = (el: HTMLElement) => [...el.querySelectorAll('.mailrow')]
const titles = (el: HTMLElement) =>
  rows(el).map((r) => r.querySelector('.l1 .mfrom')?.textContent ?? '')
const list = (el: HTMLElement) => el.querySelector('.mailer-list') as HTMLElement
const end = (el: HTMLElement) => el.querySelector('.doc-list-end')
const pane = (el: HTMLElement) => el.querySelector('.mailer-read')
const showRetired = (el: HTMLElement) =>
  el.querySelector('.gallery-showretired input') as HTMLInputElement

/** the reader's own gesture: move the scroller and let what it triggers settle */
const scrollTo = async (el: HTMLElement, top: number) => {
  await inAct(async () => { list(el).scrollTop = top; await flush(8) })
}
const toBottom = async (el: HTMLElement) => {
  const s = list(el)
  await scrollTo(el, Math.max(0, contentH(s) - VIEW_H))
}

function uiTest(name: string, body: (mount: (v: React.ReactElement)
  => Promise<{ el: HTMLElement }>) => Promise<void>) {
  test(name, async (t: TestContext) => {
    useFakeClock()
    const undoLayout = layout()
    let open: { el: HTMLElement; unmount: () => Promise<void> } | null = null
    t.after(async () => {
      try { await open?.unmount() } finally { undoLayout(); realClock() }
    })
    await body(async (v) => {
      const view = await mountView(v, (host) => host)
      open = view
      await flush(8)
      return { el: view.el }
    })
  })
}

const gallery = (extra?: { jumpTo?: { id: string; seq: number } | null
  onJumpHandled?: () => void; toast?: (m: string[]) => void }) => (
  <DocGalleryModal slug="org1" toast={extra?.toast ?? noop} close={noop}
    jumpTo={extra?.jumpTo} onJumpHandled={extra?.onJumpHandled} />
)

const retryButton = (el: HTMLElement) =>
  el.querySelector('.doc-list-retry') as HTMLButtonElement | null

// ---------------------------------------------------------------- the tests

uiTest('§1 the manual paging controls are GONE — nothing in the panel offers '
  + 'Newer or Older', async (mount) => {
  serve(many(130))
  const { el } = await mount(gallery())
  await flush()
  const labels = [...el.querySelectorAll('button')].map((b) => b.textContent ?? '')
  assert.equal(labels.filter((t) => /^\s*(Newer|Older)\s*$/.test(t)).length, 0,
    `a manual pager survived: ${JSON.stringify(labels)}`)
  assert.doesNotMatch(el.textContent ?? '', /\bNewer\b/)
  assert.doesNotMatch(el.textContent ?? '', /\bOlder\b/)
})

uiTest('§2 the FIRST window is bounded — one request for one page, and the '
  + 'other ninety documents are not fetched or rendered', async (mount) => {
  const s = serve(many(130))
  const { el } = await mount(gallery())
  await flush()
  assert.equal(s.list.length, 1, 'exactly one list request on open')
  assert.equal(s.list[0]!.offset, 0, 'read from the newest end')
  assert.equal(s.list[0]!.limit, DOC_PAGE, 'and asked for one page of it')
  assert.equal(rows(el).length, DOC_PAGE, 'one page is what is on screen')
  assert.equal(titles(el)[0], 'document 0', 'newest first')
  assert.equal(titles(el)[DOC_PAGE - 1], `document ${DOC_PAGE - 1}`)
})

// ⚠ THE ONE TEST THAT DELIBERATELY HAS NO LAYOUT. Everything above and below
// installs `layout()`; this asserts what happens without it, which is the real
// state of a panel rendered before its box is measured — and of every other
// suite in this directory. Three zeroes subtract to "at the bottom", so a
// boundary check that trusts them pages the ENTIRE history in on mount,
// silently, with no gesture from anybody. That is the failure this guards.
test('§2b an UNMEASURED scroller is not "the bottom" — a panel with no layout '
  + 'must not walk the whole history by itself', async (t: TestContext) => {
  useFakeClock()
  let open: { el: HTMLElement; unmount: () => Promise<void> } | null = null
  t.after(async () => { try { await open?.unmount() } finally { realClock() } })
  const s = serve(many(130))
  const view = await mountView(gallery(), (host) => host)
  open = view
  await inAct(async () => { await flush(20) })
  assert.equal(s.list.length, 1,
    `one request, not a walk of the gallery (made ${s.list.length})`)
  assert.equal(rows(view.el).length, DOC_PAGE)
})

uiTest('§3 reaching the bottom loads the next older page and APPENDS it — '
  + 'newest-first order intact, nothing repeated', async (mount) => {
  const s = serve(many(130))
  const { el } = await mount(gallery())
  await flush()
  await toBottom(el)
  assert.equal(s.list.length, 2, 'the boundary asked for exactly one more page')
  assert.equal(s.list[1]!.limit, DOC_PAGE * 2,
    'and it asked for the whole WINDOW from zero, not a detached page')
  assert.equal(rows(el).length, DOC_PAGE * 2)
  assert.deepEqual(titles(el), many(DOC_PAGE * 2).map((r) => r.title),
    'the older page lands BELOW the rows already read, in server order')
  // …and again, so this is a repeatable gesture and not a one-off
  await toBottom(el)
  assert.equal(rows(el).length, DOC_PAGE * 3)
  assert.equal(new Set(titles(el)).size, DOC_PAGE * 3, 'no row appears twice')
})

uiTest('§3b A LIST TOO SHORT TO SCROLL still loads — the window is filtered '
  + 'down to a handful of rows, so no scroll event can ever fire and the '
  + 'boundary has to be re-checked after the commit instead', async (mount) => {
  // every fourth card is from a currently-hired agent; the rest are behind
  // the "show retired" box. One window renders ten rows into a scroller that
  // fits ten — nothing overflows, so there is nothing to scroll and a
  // scroll-only pager would stop here with history still to come.
  const s = serve(many(130, (i) => i % 4 === 0
    ? { node: 'live-one', node_state: 'live' as const }
    : { node: 'oldie', node_state: 'archived' as const }))
  const { el } = await mount(gallery())
  await inAct(async () => { await flush(20) })
  assert.equal(list(el).scrollTop, 0, 'fixture: nobody scrolled anything')
  assert.equal(s.list.length, 2, 'it asked for a second window on its own')
  assert.equal(rows(el).length, 20, 'and the rows the second window added are shown')
  // …and it stops as soon as the rows DO overflow: this is a fill, not a walk
  assert.ok(rows(el).length * ROW_H - VIEW_H >= 240,
    'fixture: the list now overflows, which is why the filling stopped')
})

uiTest('§4 NO DUPLICATES AND NO GAPS while the list moves underneath the '
  + 'reader — a card presented and cards dismissed between growths',
async (mount) => {
  const s = serve(many(90))
  const { el } = await mount(gallery())
  await flush()
  await toBottom(el)
  assert.equal(rows(el).length, DOC_PAGE * 2)
  // a brand-new card arrives at the TOP: every row the reader holds has just
  // shifted down one. An offset cursor would now re-serve its last row.
  s.present(row({ id: 'fresh', title: 'just presented' }))
  await advance(5200)                     // the panel's own heartbeat
  await toBottom(el)
  // …and three of the newest are dismissed, shifting everything the other way,
  // which is the direction that leaves a HOLE rather than a repeat.
  s.dismissTop(3)
  await advance(5200)
  const shown = titles(el)
  assert.equal(new Set(shown).size, shown.length, 'every row is distinct')
  // the truth is whatever the server holds now: the window is a prefix of it
  const expected = s.all.map((r) => r.title).slice(0, shown.length)
  assert.deepEqual(shown, expected,
    'the rows on screen are the newest N of the CURRENT list, in order — '
    + 'no repeat, and nothing skipped over')
})

uiTest('§5 it STOPS at the end of the history — the last page is fetched once '
  + 'and further scrolling asks for nothing', async (mount) => {
  const s = serve(many(50))
  const { el } = await mount(gallery())
  await flush()
  await toBottom(el)
  assert.equal(rows(el).length, 50, 'the whole history is loaded')
  const asked = s.list.length
  await toBottom(el)
  await scrollTo(el, 0)
  await toBottom(el)
  assert.equal(s.list.length, asked,
    'scrolling at an exhausted boundary issues no further requests')
  assert.match(end(el)?.textContent ?? '', /end of the list/,
    'and the list says it has reached the end')
  assert.match(end(el)?.textContent ?? '', /50 documents/)
})

uiTest('§6 a FAILED page keeps the loaded rows, says so, and can be asked for '
  + 'again', async (mount) => {
  const s = serve(many(130))
  const { el } = await mount(gallery())
  await flush()
  assert.equal(rows(el).length, DOC_PAGE)
  s.fail = 1
  await toBottom(el)
  assert.equal(rows(el).length, DOC_PAGE,
    'the rows already read stay on screen — a dropped page is not a reset')
  const warn = el.querySelector('.doc-list-end.ask-warn')
  assert.ok(warn, 'the failure is reported at the end of the list')
  assert.match(warn.textContent ?? '', /the engine is not answering/,
    'and it names what went wrong')
  const retry = warn.querySelector('button') as HTMLButtonElement
  assert.ok(retry, 'with a control to ask again')
  // a failed boundary must not keep firing on every scroll event
  const asked = s.list.length
  await scrollTo(el, 0)
  await toBottom(el)
  assert.equal(s.list.length, asked, 'a failed window does not retry itself in a loop')
  await inAct(async () => { retry.click(); await flush(8) })
  assert.equal(el.querySelector('.doc-list-end.ask-warn'), null, 'the warning clears')
  assert.equal(rows(el).length, DOC_PAGE * 2, 'and the page the reader asked for arrives')
})

uiTest('§7 the reader is NOT MOVED — neither by a page landing nor by an '
  + 'ordinary refresh', async (mount) => {
  const s = serve(many(130))
  const { el } = await mount(gallery())
  await flush()
  const bottom = DOC_PAGE * ROW_H - VIEW_H      // as far as one window goes
  await scrollTo(el, bottom - 300)              // comfortably above the threshold
  assert.equal(list(el).scrollTop, bottom - 300, 'fixture: parked where we said')
  assert.equal(rows(el).length, DOC_PAGE, 'fixture: parking loaded nothing')
  await scrollTo(el, bottom - 200)              // …and now inside it
  assert.equal(rows(el).length, DOC_PAGE * 2, 'fixture: a page arrived')
  assert.equal(list(el).scrollTop, bottom - 200,
    'the appended page did not move the reader')
  // an ordinary heartbeat over the SAME window must not move them either
  const held = list(el).scrollTop
  const asked = s.list.length
  await advance(5200)
  assert.ok(s.list.length > asked, 'fixture: the heartbeat really did refetch')
  assert.equal(rows(el).length, DOC_PAGE * 2, 'the refresh re-served the same window')
  assert.equal(list(el).scrollTop, held, 'and left the reader exactly where they were')
})

uiTest('§8 selection survives a growth — the open document stays open and its '
  + 'row stays marked', async (mount) => {
  serve(many(130), { d3: 'the body of document three' })
  const { el } = await mount(gallery())
  await flush()
  await inAct(async () => { (rows(el)[3] as HTMLElement).click(); await flush(4) })
  assert.match(pane(el)?.textContent ?? '', /the body of document three/)
  await toBottom(el)
  assert.equal(rows(el).length, DOC_PAGE * 2, 'fixture: the window grew')
  assert.match(pane(el)?.textContent ?? '', /the body of document three/,
    'the document the reader opened is still open')
  assert.ok(rows(el)[3]!.classList.contains('on'), 'and its row is still the selected one')
})

uiTest('§9 a filter that empties the WINDOW does not stop the loading — the '
  + 'panel finds the hired agent\'s card instead of declaring the gallery empty',
async (mount) => {
  // one card from a currently-hired agent, a long way down; everything above
  // it is from retired ones, which the default list hides
  const all = many(120, (i) => i === 100
    ? { title: 'the one hired card', node: 'live-one', node_state: 'live' as const }
    : { node: 'oldie', node_state: 'archived' as const })
  const s = serve(all)
  const { el } = await mount(gallery())
  await inAct(async () => { await flush(40) })
  assert.ok(s.list.length > 1, 'fixture: it kept asking past the first window')
  assert.equal(titles(el).length, 1, 'exactly the hired agent\'s card is listed')
  assert.equal(titles(el)[0], 'the one hired card')
  assert.doesNotMatch(el.textContent ?? '', /no cards have been presented yet/,
    'the panel never claimed an empty gallery over a full one')
  // …and the checkbox still reveals the rest of what has been loaded
  await inAct(async () => { showRetired(el).click(); await flush(8) })
  assert.ok(rows(el).length > 100, 'the retired cards join the same list')
})

uiTest('§10 the AGENT-SCOPED list on the desk is the same continuous list — no '
  + 'buttons, and the boundary loads', async (mount) => {
  const s = serve(many(130, () => ({ node: 'agent1' })))
  const { el } = await mount(
    <AgentGalleryView slug="org1" nid="agent1" toast={noop} />)
  await flush()
  assert.doesNotMatch(el.textContent ?? '', /\bNewer\b|\bOlder\b/,
    'the desk list lost its pager too')
  assert.equal(rows(el).length, DOC_PAGE)
  assert.equal(s.list[0]!.node, 'agent1', 'still scoped to the one agent')
  assert.equal(s.list[0]!.limit, DOC_PAGE)
  await toBottom(el)
  assert.equal(rows(el).length, DOC_PAGE * 2)
  assert.equal(s.list[1]!.node, 'agent1', 'the growth keeps the scope')
  assert.equal(new Set(titles(el)).size, DOC_PAGE * 2)
})

uiTest('§11 a jump to a document BELOW the first window opens it — the window '
  + 'grows to reach it instead of hopping to a detached page', async (mount) => {
  const s = serve(many(130), { d95: 'the ninety-fifth body' })
  let handled = 0
  const { el } = await mount(gallery({
    jumpTo: { id: 'd95', seq: 1 }, onJumpHandled: () => { handled++ },
  }))
  await inAct(async () => { await flush(20) })
  assert.ok(handled >= 1, 'the jump was answered')
  assert.match(pane(el)?.textContent ?? '', /the ninety-fifth body/,
    'the referenced document is open')
  assert.equal(titles(el)[0], 'document 0',
    'and the list is still a prefix from the newest end, not a middle slice')
  assert.ok(rows(el).length > 95, 'the window grew far enough to hold it')
  assert.ok(s.list.every((c) => c.offset === 0),
    'every request read from zero — no detached offset was ever adopted')
})

uiTest('§12 THE VERY FIRST request failing is reported too — the end marker '
  + 'lives inside a list that does not exist yet, so the empty state carries '
  + 'the failure and the same way back', async (mount) => {
  const s = serve(many(130))
  s.fail = 1
  const { el } = await mount(gallery())
  await flush()
  assert.equal(rows(el).length, 0, 'fixture: nothing was read')
  assert.doesNotMatch(el.textContent ?? '', /no cards have been presented yet/,
    'a panel that could not READ the gallery must not report an EMPTY one')
  assert.match(el.textContent ?? '', /could not load the presented documents/)
  assert.match(el.textContent ?? '', /the engine is not answering/)
  const retry = retryButton(el)
  assert.ok(retry, 'and a way to ask again')
  await inAct(async () => { retry!.click(); await flush(8) })
  assert.equal(rows(el).length, DOC_PAGE, 'the retry loads the first window')
  assert.equal(retryButton(el), null, 'and the failure clears')
})

uiTest('§13 A JUMP THAT NO WINDOW CAN REACH stops after ONE correction — a '
  + 'server that answers every locate with the row\'s own page is reported, '
  + 'not chased forever', async (mount) => {
  // what the server's own ceiling looks like from here: the row sits past the
  // widest window it will serve, so no width ever snaps the answer back to a
  // prefix. Without the one-correction latch this is an unbounded request
  // loop that takes the whole panel with it.
  const s = serve(many(130))
  s.stubborn = 100
  const said: string[] = []
  const { el } = await mount(gallery({
    jumpTo: { id: 'd120', seq: 1 }, toast: (m) => said.push(...m),
  }))
  await inAct(async () => { await flush(40) })
  assert.equal(s.list.length, 2,
    `the first ask and exactly one correction (made ${s.list.length})`)
  assert.deepEqual(s.list.map((c) => c.offset), [0, 0],
    'and both still read from the newest end')
  assert.ok(s.list[1]!.limit > s.list[0]!.limit, 'the correction widened the window')
  assert.match(said.join(' '), /too far down the list/,
    'the reader is told the jump could not be placed')
  assert.match(el.textContent ?? '', /could not load the presented documents/)
})

uiTest('§14 THE LIST IS REACHABLE BY KEYBOARD — scrolling is now the only way '
  + 'to older documents, and the controls that used to be tabbable are gone, '
  + 'so the scroller itself is an explicitly labelled tab stop', async (mount) => {
  const s = serve(many(130))
  const { el } = await mount(gallery())
  await flush()
  const scroller = list(el)
  // EXPLICIT, not inherited from the platform. Chromium 127+ would make a
  // scroll container with no focusable children focusable on its own, which
  // covers the packaged app today — but that is a browser default that a
  // single focusable child inside a row would silently withdraw, and it is
  // not something this list can promise. tabIndex 0 is the promise.
  assert.equal(scroller.tabIndex, 0,
    'the scroll container is in the tab order in its own right')
  assert.equal(scroller.getAttribute('aria-label'), 'Presented documents',
    'and it says what it is when it takes focus')
  // …and it genuinely takes focus, rather than merely carrying the attribute
  await inAct(() => { scroller.focus() })
  assert.equal(el.ownerDocument.activeElement, scroller, 'focus lands on the list')
  // the keyboard path is exactly the pointer path from here: a browser scrolls
  // a focused scroll container on arrow/PageDown, and THAT is what loads. jsdom
  // performs no native scrolling, so the reachable half is asserted above and
  // the loading half is driven directly — together they are the whole route.
  await toBottom(el)
  assert.equal(rows(el).length, DOC_PAGE * 2,
    'and reaching the bottom of the focused list is what fetches the next page')
  assert.equal(s.list.length, 2)
})

uiTest('§14b the agent-scoped list is a tab stop too, and names its agent',
  async (mount) => {
  serve(many(60, () => ({ node: 'agent1' })))
  const { el } = await mount(
    <AgentGalleryView slug="org1" nid="agent1" toast={noop} />)
  await flush()
  assert.equal(list(el).tabIndex, 0)
  assert.equal(list(el).getAttribute('aria-label'),
    'Presented documents from agent1',
    'the desk list says WHOSE documents it holds — there can be several on screen')
})
