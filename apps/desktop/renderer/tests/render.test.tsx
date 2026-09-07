// render.test.tsx — what the desk and the mail list actually put in the DOM.
//
// §6 rendering edges: markdown, fences, wide tables (D-14), rich-text names,
//    unicode/RTL, an empty transcript, a thousand rows, tab switching, and an
//    unmount in the middle of a fetch.
// §7 D-56: paging on SCROLL rather than on a button, in the chat AND in the
//    mail list — the part of D-56 that shipped unverified.
// §8 two DOM views of one node, side by side, must render the same thing.
//
// Run:  cd frontend && node tests/run.mjs render

import {
  advance, FakeServer, fireResize, flush, inAct, installFetch, mountView,
  realClock, resizeWatchers, useFakeClock,
} from './harness'
import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { refreshConvo, resetConvos } from '../src/convo'
import { DeskChat } from '../src/canvas/desk'
import { UserNode } from '../src/canvas/cards'
import { USER } from '../src/canvas/shared'
import { MailList } from '../src/canvas/mail'
import type { CanvasNode } from '../src/canvas/shared'
import type { MailRow } from '../src/canvas/shared'
import type { OpResult } from '../src/types'

let _n = 0
const noop = () => {}
const op = () => Promise.resolve({} as OpResult)

function node(id: string, extra: Partial<CanvasNode> = {}): CanvasNode {
  return {
    id, state: 'live', tier: 'haiku', children: [], seat: 1, grant: 0, free: 0,
    scope: { tools: {}, add_dirs: [] }, model_id: 'haiku', ...extra,
  }
}

function deskEl(nd: CanvasNode, slug: string, extra: Record<string, unknown> = {}) {
  return (
    <DeskChat node={nd} map={new Map([[nd.id, nd]])} op={op} slug={slug}
      toast={noop} pub={false} bare {...extra} />
  )
}

/** a test with the clock mocked, a fresh store key, a FakeServer wired up, and
 *  a teardown that survives a failed assertion (see convo.test.tsx) */
function domTest(name: string,
  body: (k: { SL: string; ND: string; s: FakeServer;
    mount: (el: React.ReactElement) => Promise<{ el: HTMLElement; unmount: () => Promise<void> }> }) => Promise<void>,
  opts: { todo?: string } = {}): void {
  test(name, opts.todo ? { todo: opts.todo } : {}, async (t: TestContext) => {
    useFakeClock()
    const SL = 'org'
    const ND = `d${++_n}`
    const s = new FakeServer()
    installFetch(s)
    const open: { unmount: () => Promise<void> }[] = []
    t.after(async () => {
      for (const m of open) { try { await m.unmount() } catch { /* gone */ } }
      resetConvos()
      realClock()
    })
    await body({
      SL, ND, s,
      mount: async (el) => {
        const v = await mountView(el, (host) => host)
        open.push(v)
        return { el: v.el, unmount: v.unmount }
      },
    })
  })
}

const txt = (el: HTMLElement) => el.textContent ?? ''
const rows = (el: HTMLElement, sel: string) => [...el.querySelectorAll(sel)]

domTest('a Codex desk keeps the user-audience tag on the audience color channel',
  async ({ SL, ND, mount }) => {
    const { el } = await mount(deskEl(node(ND, {
      tier: 'sol', model_id: 'gpt-5.6-sol', audiences_held: [USER],
    }), SL))
    const tag = [...el.querySelectorAll<HTMLElement>('.badge')]
      .find((x) => x.textContent?.trim().startsWith('user'))
    assert.ok(tag, 'the granted user-audience tag is missing from the desk')
    assert.ok(tag.classList.contains('aud-user'),
      'the tag lost its relationship-color hook and will inherit Codex blue')
  })

/** jsdom does no layout, so scroll geometry is stated rather than measured —
 *  which is what makes the paging predicate testable at all */
function geometry(el: Element, g: { top: number; height: number; client: number }) {
  Object.defineProperty(el, 'scrollTop', { value: g.top, configurable: true, writable: true })
  Object.defineProperty(el, 'scrollHeight', { value: g.height, configurable: true })
  Object.defineProperty(el, 'clientHeight', { value: g.client, configurable: true })
}

async function scroll(el: Element, times = 1) {
  await inAct(() => {
    for (let i = 0; i < times; i++) {
      el.dispatchEvent(new (globalThis as unknown as { Event: typeof Event }).Event(
        'scroll', { bubbles: true }))
    }
  })
}

// ===================================================================== §6
// RENDERING EDGES
// ===================================================================== §6

domTest('§6.1 markdown, fences and literal angle brackets survive the pipeline',
  async ({ SL, ND, s, mount }) => {
    s.assistantMsg([
      '# heading', '', 'a `Sync<float3>` in prose and a bare <Token> too', '',
      '```ts', 'const x: Map<string, number> = new Map()', '```', '',
      '| a | b |', '| --- | --- |', '| 1 | 2 |',
    ].join('\n'))
    await refreshConvo(SL, ND)
    const { el } = await mount(deskEl(node(ND), SL))
    await flush()
    assert.ok(el.querySelector('h1'), 'the heading rendered')
    assert.ok(el.querySelector('pre code'), 'the fence rendered as code')
    assert.ok(el.querySelector('table'), 'the table rendered')
    assert.ok(txt(el).includes('Sync<float3>'),
      'a generic in prose kept its angle brackets (№16)')
    assert.ok(txt(el).includes('<Token>'), 'a bare tag-shaped token survived')
    assert.ok(txt(el).includes('Map<string, number>'), 'and so did the one in the fence')
  })

domTest('§6.2 agent output cannot inject markup', async ({ SL, ND, s, mount }) => {
  // the sanitizer is the only thing between an agent echoing web content and
  // the page. If DOMPurify were inert (it silently no-ops without a DOM) this
  // suite would be testing nothing, so assert it is alive.
  s.assistantMsg('<img src=x onerror="globalThis.__pwned=1"> <script>globalThis.__pwned=1</script> plain')
  await refreshConvo(SL, ND)
  const { el } = await mount(deskEl(node(ND), SL))
  await flush()
  // `!` not the element: a failing assert.equal on a live jsdom node makes
  // node inspect the whole document to build the diff (70s + OOM, not a message)
  assert.ok(!el.querySelector('script'), 'no script element')
  const img = el.querySelector('img')
  assert.ok(!img || !img.getAttribute('onerror'), 'no inline handler survived')
  assert.equal((globalThis as Record<string, unknown>).__pwned, undefined)
  assert.ok(txt(el).includes('plain'), 'and the safe text still rendered')
})

domTest('§6.3 unicode, RTL and combining marks round-trip',
  async ({ SL, ND, s, mount }) => {
    const samples = [
      'مرحبا بالعالم — RTL',
      'é́́ combining',
      '👨‍👩‍👧‍👦 family ZWJ · 🇯🇵 flag',
      'ｆｕｌｌｗｉｄｔｈ · ﷽',
      'zero​width',
    ]
    samples.forEach((x) => s.assistantMsg(x))
    await refreshConvo(SL, ND)
    const { el } = await mount(deskEl(node(ND), SL))
    await flush()
    for (const x of samples) {
      assert.ok(txt(el).includes(x), `${JSON.stringify(x.slice(0, 12))} rendered intact`)
    }
  })

domTest('§6.4 a rich-text node name is shown, never interpreted',
  async ({ SL, ND, s, mount }) => {
    // slot/agent names carry rich text in this ecosystem ("<color=cyan>Systems")
    // and one session already lost a comparison to it
    await refreshConvo(SL, ND)
    const nd = node(ND, { charter: '<color=cyan>lead' })
    const { el } = await mount(deskEl(nd, SL))
    await flush()
    void s
    assert.ok(txt(el).includes(ND), 'the name renders')
    assert.ok(!el.querySelector('color'), 'and no tag was created from it')
  })

domTest('§6.5 an empty transcript says so, once', async ({ SL, ND, mount }) => {
  await refreshConvo(SL, ND)
  const { el } = await mount(deskEl(node(ND), SL))
  await flush()
  assert.equal(rows(el, '.pad').filter((r) => txt(r as HTMLElement).includes('no conversation yet')).length, 1)
})

domTest('§6.6 a thousand rows render only one window',
  async ({ SL, ND, s, mount }) => {
    for (let i = 0; i < 3000; i++) s.assistantMsg(`row ${i}`)
    await refreshConvo(SL, ND)
    const { el } = await mount(deskEl(node(ND), SL))
    await flush()
    const msgs = rows(el, '.msgs > div').length
    assert.ok(msgs <= 130, `the DOM carries ${msgs} rows for a 3000-row transcript`)
    assert.ok(txt(el).includes('row 2999'), 'and it is the NEWEST window')
    assert.ok(txt(el).includes('earlier messages'), 'with the status line explaining the rest')
  })

domTest('§6.7 rapid tab switching keeps the conversation',
  async ({ SL, ND, s, mount }) => {
    s.assistantMsg('the answer is 42')
    await refreshConvo(SL, ND)
    // the tab strip renders on every desk (switchboard panels mirror the
    // full header since 2026-08-19); a full desk is just the plainest host
    const { el } = await mount(deskEl(node(ND), SL, { bare: false }))
    await flush()
    const tab = (name: string) => rows(el, '.cc-tabs button')
      .find((b) => txt(b as HTMLElement).startsWith(name)) as HTMLElement | undefined
    for (let i = 0; i < 12; i++) {
      for (const name of ['history', 'files', 'inbox', 'chat']) {
        const b = tab(name)
        assert.ok(b, `the ${name} tab exists`)
        await inAct(() => { b!.click() })
      }
    }
    await advance(200)
    assert.ok(txt(el).includes('the answer is 42'), 'back on chat, the transcript is intact')
  })

domTest('§6.8 unmounting while a panel fetch is in flight is not an error',
  async ({ SL, ND, s, mount }) => {
    const errs: unknown[] = []
    const onErr = (e: unknown) => errs.push(e)
    process.on('unhandledRejection', onErr)
    s.latency = 4000
    const m = await mount(deskEl(node(ND), SL, { bare: false }))
    await flush()
    const hist = rows(m.el, '.cc-tabs button')
      .find((b) => txt(b as HTMLElement).startsWith('history')) as HTMLElement
    await inAct(() => { hist.click() })
    await advance(100)
    await m.unmount()
    await advance(8000)
    process.off('unhandledRejection', onErr)
    assert.deepEqual(errs, [], 'no rejection escaped the unmounted panel')
  })

domTest('§6.9 a very long single message renders whole and does not wedge',
  async ({ SL, ND, s, mount }) => {
    const big = Array.from({ length: 400 },
      (_, i) => `paragraph ${i} — ${'lorem ipsum '.repeat(20)}`).join('\n\n')
    s.assistantMsg(big)
    await refreshConvo(SL, ND)
    const t0 = Date.now()
    const { el } = await mount(deskEl(node(ND), SL))
    await flush()
    void t0
    assert.ok(txt(el).includes('paragraph 0'), 'the head rendered')
    assert.ok(txt(el).includes('paragraph 399'), 'and so did the tail')
    assert.ok(rows(el, '.msgs p').length >= 400, 'every paragraph is a node')
  })

domTest('§6.10 a panel showing folder A never renders A’s rows under B',
  async ({ SL, ND, s, mount }) => {
    // usePolled keeps the last value across a deps change, so a panel whose
    // identity changed shows the OLD data until the new fetch lands. The
    // LineagePanel guards this case explicitly (`readingRef`); the polled
    // panels do not. Measured here on the files tab, which changes identity
    // on every folder click.
    void s
    const { el } = await mount(deskEl(node(ND), SL, { bare: false }))
    await flush()
    const files = rows(el, '.cc-tabs button')
      .find((b) => txt(b as HTMLElement).startsWith('files')) as HTMLElement
    await inAct(() => { files.click() })
    await advance(200)
    // slice(1): the first .hist-row is the breadcrumb, and it changes the
    // instant the path does — comparing it would make this test pass without
    // ever looking at the listing
    const shown = () => rows(el, '.msgs.files .hist-row').slice(1)
      .map((r) => txt(r as HTMLElement))
    const root = shown().join('|')
    // the next fetch is slow — the click must not leave the old listing up
    // under the new path
    s.latency = 3000
    const dir = rows(el, '.msgs.files button')
      .find((b) => txt(b as HTMLElement).includes('sub')) as HTMLElement | undefined
    assert.ok(dir, 'the scratch fixture must offer a subfolder, or this proves nothing')
    await inAct(() => { dir!.click() })
    await advance(100)
    assert.notEqual(shown().join('|'), root,
      'the previous folder’s listing is still on screen under the new path')
  })
  // ← PROMOTED 2026-08-11 (implementer): `usePolled` now resets to null when
  // `deps` change — in the hook, exactly where the redteam's report said the
  // fix belonged, never per call site. The read-ack bump (89fecd9) moved to a
  // separate `refreshKey` argument on purpose: it restarts the fetch on the
  // SAME identity, and resetting there would blank the inbox on every
  // mark-read.

// ===================================================================== §7
// D-56 — PAGING ON SCROLL
// ===================================================================== §7

domTest('§7.1 the chat pages in older messages on scroll, with no button',
  async ({ SL, ND, s, mount }) => {
    for (let i = 0; i < 3000; i++) s.assistantMsg(`row ${i}`)
    await refreshConvo(SL, ND)
    const { el } = await mount(deskEl(node(ND), SL))
    await flush()
    assert.equal(rows(el, '.loadolder-status button').length, 0,
      'the status line is not a control')
    const msgs = el.querySelector('.msgs')!
    const before = rows(el, '.msgs > div').length
    geometry(msgs, { top: 10, height: 4000, client: 600 })
    await scroll(msgs)
    await advance(500)
    const after = rows(el, '.msgs > div').length
    assert.ok(after > before,
      `scrolling to the top loaded nothing (${before} → ${after} rows)`)
  })

domTest('§7.2 one chat gesture pages one window, and the cap is explained',
  async ({ SL, ND, s, mount }) => {
    for (let i = 0; i < 3000; i++) s.assistantMsg(`row ${i}`)
    await refreshConvo(SL, ND)
    const { el } = await mount(deskEl(node(ND), SL))
    await flush()
    const msgs = el.querySelector('.msgs')!
    geometry(msgs, { top: 10, height: 4000, client: 600 })
    await scroll(msgs, 8)                 // one flick, eight scroll events
    await advance(500)
    const after = rows(el, '.msgs > div').length
    assert.ok(after <= 260,
      `one gesture paged ${after} rows in — more than one window`)
    // …and keep scrolling to the API's cap
    for (let i = 0; i < 20; i++) { await scroll(msgs); await advance(400) }
    assert.ok(txt(el).includes('beyond the window'),
      'at the cap the status line explains why scrolling up stopped working')
  })

domTest('§7.3 the mail list pages on scroll, only grows, and stops', async () => {
  useFakeClock()
  const mails: MailRow[] = Array.from({ length: 200 }, (_, i) => ({
    id: `m${i}`, from: 'agent', kind: 'message', body: `mail body ${i}`,
    at: new Date(1_700_000_000_000 - i * 60_000).toISOString(),
  }))
  const v = await mountView(<MailList delivered={mails} />, (h) => h)
  try {
    await flush()
    const list = v.el.querySelector('.mailer-list')!
    const count = () => v.el.querySelectorAll('.mailrow').length
    assert.equal(count(), 40, 'one window to start')
    assert.ok(txt(v.el).includes('160 earlier'), 'and a status line, not a button')
    assert.equal(v.el.querySelectorAll('.mailer-list button.loadolder').length, 0)
    // scroll to the bottom: the next window renders
    geometry(list, { top: 1000, height: 1700, client: 600 })
    await scroll(list)
    assert.ok(count() > 40, `paging on scroll did nothing (${count()} rows)`)
    const oneGesture = count()
    assert.ok(oneGesture <= 80, `one scroll event paged ${oneGesture} rows`)
    // a flick emits a burst of events before React can re-render
    await scroll(list, 8)
    assert.ok(count() <= oneGesture + 40,
      `a burst of 8 scroll events paged ${count() - oneGesture} extra rows in one gesture`)
    // page all the way and stop
    for (let i = 0; i < 40; i++) await scroll(list)
    assert.equal(count(), 200, 'everything is shown')
    assert.ok(!txt(v.el).includes('earlier'), 'and the status line is gone')
    await scroll(list, 5)
    assert.equal(count(), 200, 'further scrolling changes nothing')
  } finally {
    await v.unmount()
    realClock()
  }
})

// ===================================================================== §8
// TWO DOM VIEWS OF ONE NODE
// ===================================================================== §8

domTest('§8.1 a card and its switchboard panel render the same conversation',
  async ({ SL, ND, s, mount }) => {
    s.userMsg('what is the status')
    s.assistantMsg('all green')
    await refreshConvo(SL, ND)
    const card = await mount(deskEl(node(ND), SL, { bare: false }))
    const board = await mount(deskEl(node(ND), SL, { compact: true }))
    await flush()
    const body = (el: HTMLElement) =>
      rows(el, '.msgs > div').map((r) => txt(r as HTMLElement)).join('␟')
    assert.equal(body(board.el), body(card.el), 'identical at first paint')
    // …and after the world moves under them, with no event delivered at all
    s.assistantMsg('and one more thing')
    s.liveRow('tool', 'Read · notes.md', 'tid')
    await advance(9000)
    assert.equal(body(board.el), body(card.el), 'identical after a silent update')
    assert.ok(txt(card.el).includes('and one more thing'),
      'and both caught the new row from polling alone')
  })

// ===================================================================== §9
// STICKY BOTTOM SURVIVES A RESIZE
domTest('§9.5 a widening panel that clamps a reader to the bottom re-sticks them',
  async ({ SL, ND, s, mount }) => {
    // The other direction of the same bug, and the subtler one. A panel that
    // gets WIDER re-wraps SHORTER, so the browser clamps a scrolled-up
    // reader's scrollTop and can deposit them AT the bottom with no scroll
    // gesture of their own. If the observer only ever pins the already-stuck,
    // `stickRef` stays false: the ⇩ chip sits over an already-bottomed view
    // and the next agent message does not pin — the same silent left-behind,
    // reached through the fix's own path.
    s.assistantMsg('all green')
    await refreshConvo(SL, ND)
    const { el } = await mount(deskEl(node(ND), SL, { compact: true }))
    await flush()
    const msgs = el.querySelector('.msgs')!
    // parked 100px up: 1000 − 500 − 400 = 100 ≥ the 40px slack ⇒ unstuck
    geometry(msgs, { top: 500, height: 1000, client: 400 })
    await scroll(msgs)
    assert.ok(el.querySelector('.jumpbottom'), 'the reader is off the bottom')
    // a sibling tab closes: this panel widens, the transcript re-wraps to 800,
    // and the browser clamps 500 → 400, which IS the bottom now
    geometry(msgs, { top: 400, height: 800, client: 400 })
    await inAct(() => { fireResize(msgs) })
    assert.ok(!el.querySelector('.jumpbottom'),
      'the clamp re-armed the sticky bottom without a scroll event')
  })

/** a stated scrollport rect — jsdom computes none */
const rectAt = (top: number) => () => ({ top, bottom: top + 400, left: 0,
  right: 0, width: 0, height: 400, x: 0, y: top, toJSON: () => ({}) })

domTest('§9.6 a resize can ARM the ↑ chip, not only retire it',
  async ({ SL, ND, s, mount }) => {
    // §9.4 proves the observer RETIRES a chip; both directions matter, and
    // only this one catches a stale closure. The observer is built once, in
    // `attachScroller`, during render #1 — when the transcript has not loaded
    // and `userTurns` is []. Capture `calcPin` directly instead of through
    // `calcPinRef` and that empty-handed copy is the one that runs forever:
    // it can only ever compute null, so the chip would be wrongly retired on
    // every tab toggle and could never be armed by one.
    s.assistantMsg('all green')
    await refreshConvo(SL, ND)
    const { el } = await mount(deskEl(node(ND), SL, { compact: true }))
    await flush()
    const msgs = el.querySelector('.msgs')!
    // hold the chip down while a user turn arrives AFTER mount
    msgs.getBoundingClientRect = rectAt(-100)
    s.userMsg(`FROM ${USER} (user)

please check the deploy`)
    await inAct(async () => { await refreshConvo(SL, ND, { force: true }) })
    await flush()
    assert.ok(!el.querySelector('.pinuser'), 'no chip yet')
    // now that row IS above the fold — and only a resize says so
    msgs.getBoundingClientRect = rectAt(0)
    geometry(msgs, { top: 0, height: 1000, client: 400 })
    await inAct(() => { fireResize(msgs) })
    assert.ok(el.querySelector('.pinuser'),
      'the resize armed the chip for a user turn that arrived after mount')
  })

domTest('§9.7 the watcher follows the scroller back from another tab',
  async ({ SL, ND, s, mount }) => {
    // Why the observer rides the ref callback and not `useEffect(…, [])`:
    // `.msgs` is conditional on `view === 'chat'`, so it genuinely REMOUNTS
    // when the reader visits files/history and comes back. A one-shot effect
    // leaves that returning scroller permanently unwatched — the original bug,
    // back for that panel, for the rest of its mount, silently.
    s.assistantMsg('all green')
    await refreshConvo(SL, ND)
    const { el } = await mount(deskEl(node(ND), SL, { compact: true }))
    await flush()
    // ⚠ FilesView renders `.msgs files` too — `.msgs` alone is only
    // unambiguous while the chat tab is up
    const first = el.querySelector('.msgs:not(.files)')!
    assert.ok(resizeWatchers(first) > 0, 'watched at first')
    const tab = (label: string) => [...el.querySelectorAll('.cc-tabs button')]
      .find((b) => (b.textContent ?? '').trim() === label) as HTMLElement
    await inAct(() => { tab('files').click() })
    await flush()
    assert.equal(resizeWatchers(first), 0, 'released when the chat tab left')
    await inAct(() => { tab('chat').click() })
    await flush()
    const back = el.querySelector('.msgs:not(.files)')!
    assert.ok(back !== first, 'the scroller really remounted')
    assert.ok(resizeWatchers(back) > 0,
      'and the returning scroller is watched again')
  })

domTest('§9.8 the ↑ chip fades only when its label is really cut',
  async ({ SL, ND, s, mount }) => {
    // The chip wraps to three lines and fades where the text is cut (user,
    // 2026-08-19). The fade is a MEASUREMENT, not a length guess: the same
    // label wraps to one line in a wide panel and to five in a narrow one,
    // and a fade over text that ended on its own claims content that is not
    // there. So it must arm and retire on the panel's width alone — which,
    // on a memoized panel, only the ResizeObserver can report.
    s.userMsg(`FROM ${USER} (user)

please check the deploy, and the staging one too`)
    s.assistantMsg('all green')
    await refreshConvo(SL, ND)
    const { el } = await mount(deskEl(node(ND), SL, { compact: true }))
    await flush()
    const msgs = el.querySelector('.msgs')!
    const text = el.querySelector('.pinuser-t')!
    assert.ok(!el.querySelector('.pinuser.clipped'),
      'nothing measured as cut, so nothing is faded')
    // five lines of label inside a three-line box
    geometry(text, { top: 0, height: 90, client: 45 })
    await inAct(() => { fireResize(msgs) })
    assert.ok(el.querySelector('.pinuser.clipped'),
      'the fade did not arm for a label that overflows its three lines')
    // a wider panel re-wraps the same label to fit
    geometry(text, { top: 0, height: 45, client: 45 })
    await inAct(() => { fireResize(msgs) })
    assert.ok(!el.querySelector('.pinuser.clipped'),
      'the fade outlived the overflow — it now hides the end of a label that '
      + 'is fully visible')
  })

// ===================================================================== §9
// Opening or closing a switchboard tab re-widths its SIBLING panels through
// flex alone: no prop changes, and DeskChat is memoized, so those panels never
// re-render and the layout effect that re-pins them never runs. The re-wrap
// moves scrollHeight while scrollTop stays put, so a reader stuck at the
// bottom drifts up and new messages land off-screen (user bug 2026-08-19).
// Only assistant rows here on purpose: with no user turns `calcPin` settles on
// null and cannot re-render the view, so the pin under test can ONLY have come
// from the resize path itself.

domTest('§9.1 a panel re-widthed by a tab toggle stays pinned to the bottom',
  async ({ SL, ND, s, mount }) => {
    s.assistantMsg('all green')
    await refreshConvo(SL, ND)
    const { el } = await mount(deskEl(node(ND), SL, { compact: true }))
    await flush()
    const msgs = el.querySelector('.msgs')
    assert.ok(msgs, 'the transcript scroller rendered')
    // the mechanism must exist at all — a fix that only touches the render
    // path leaves this at 0 and would never see a flex re-layout
    assert.ok(resizeWatchers(msgs!) > 0,
      'the scroller is watched for size changes')
    // the reader sits at the bottom, and says so with a real scroll event
    geometry(msgs!, { top: 600, height: 1000, client: 400 })
    await scroll(msgs!)
    // a sibling tab closes: this panel narrows, the markdown re-wraps taller.
    // No React render accompanies it — that is the whole point.
    geometry(msgs!, { top: 600, height: 1400, client: 400 })
    await inAct(() => { fireResize(msgs!) })
    // the INVARIANT, not the number: a browser clamps scrollTop to
    // scrollHeight − clientHeight, jsdom's stated `scrollTop` stores the
    // over-set verbatim, and pinning `=== scrollHeight` would make the
    // browser-equivalent `pin()` (`scrollHeight - clientHeight`) fail here
    assert.ok(msgs!.scrollTop >= 1400 - 400,
      `the resize re-pinned the scroller to the new bottom (scrollTop=${msgs!.scrollTop})`)
  })

domTest('§9.2 a resize does not yank a reader who scrolled up',
  async ({ SL, ND, s, mount }) => {
    s.assistantMsg('all green')
    await refreshConvo(SL, ND)
    const { el } = await mount(deskEl(node(ND), SL, { compact: true }))
    await flush()
    const msgs = el.querySelector('.msgs')!
    // parked well above the bottom, declared by a real scroll event
    geometry(msgs, { top: 100, height: 1000, client: 400 })
    await scroll(msgs)
    geometry(msgs, { top: 100, height: 1400, client: 400 })
    await inAct(() => { fireResize(msgs) })
    assert.equal(msgs.scrollTop, 100,
      'an unstuck reader keeps their place through a re-width')
  })

domTest('§9.3 the watcher is torn down with the panel',
  async ({ SL, ND, s, mount }) => {
    s.assistantMsg('all green')
    await refreshConvo(SL, ND)
    const v = await mount(deskEl(node(ND), SL, { compact: true }))
    await flush()
    const msgs = v.el.querySelector('.msgs')!
    assert.ok(resizeWatchers(msgs) > 0, 'watched while mounted')
    await v.unmount()
    assert.equal(resizeWatchers(msgs), 0,
      'and released on unmount — a leaked observer would pin a dead node')
  })

domTest('§9.4 a resize recomputes the ↑-jump target, not just the pin',
  async ({ SL, ND, s, mount }) => {
    // FR-20's chip points at the nearest HUMAN turn above the scrollport. A
    // re-width re-wraps the transcript, so which turns are above the fold
    // changes — and on a memoized panel the resize is the ONLY thing that can
    // notice. Without `calcPinRef.current()` in the observer this passes
    // nothing: the chip keeps pointing at a message that is already on screen
    // until the reader happens to scroll.
    s.userMsg(`FROM ${USER} (user)

please check the deploy`)
    s.assistantMsg('all green')
    await refreshConvo(SL, ND)
    const { el } = await mount(deskEl(node(ND), SL, { compact: true }))
    await flush()
    const msgs = el.querySelector('.msgs')!
    // jsdom rects are all-zero, so the row reads as above the scrollport and
    // the chip is up
    assert.ok(el.querySelector('.pinuser'), 'the chip is up to begin with')
    // now state a scrollport that starts ABOVE the row — the target is on
    // screen, so calcPin must retire the chip
    msgs.getBoundingClientRect = () => ({ top: -100, bottom: 300, left: 0,
      right: 0, width: 0, height: 400, x: 0, y: -100, toJSON: () => ({}) })
    geometry(msgs, { top: 600, height: 1000, client: 400 })
    // NO scroll event — a resize alone must be enough
    await inAct(() => { fireResize(msgs) })
    // ⚠ `!` not the element itself: a failing assert.equal on a live jsdom
    // node makes node inspect the whole document to build the diff — 70s and
    // an OOM in place of the message
    assert.ok(!el.querySelector('.pinuser'),
      'the resize retired a chip whose target came back on screen')
  })

// ===================================================================== §10
// THE SWITCHBOARD, END TO END
// ===================================================================== §10
// §9 fires resizes at a bare panel. This mounts the REAL thing — UserNode
// focused, which renders EyeDesk — and closes a real tab, because the bug's
// premise is a claim about the switchboard, not about DeskChat: the surviving
// panel must be re-pinned *and* must not have re-rendered to get there.

const userNodeEl = (map: Map<string, CanvasNode>, slug: string) => (
  <UserNode pos={{ x: 0, y: 0 }} isDrop={false}
    stats={{ circ: 0, seats: 0, free: 0 }} pip={null} seats={{ haiku: 1 }}
    kiosk={undefined} pub={false} kioskRemaining={null} pxc={1} zoom={1}
    onSpawn={noop} onMailLink={noop} focused eyeW={2000}
    posX={(id) => (id === 'a' ? 0 : 1)} map={map} op={op} slug={slug}
    toast={noop} />
)

domTest('§10.1 closing a tab re-pins the panels it re-widths',
  async ({ SL, s, mount }) => {
    // two direct lines; both open (nothing is in `orgtree-eyeseen-*` yet, so
    // neither counts as a NEW arrival and neither starts minimized)
    localStorage.removeItem('orgtree-eyemin-' + SL)
    localStorage.removeItem('orgtree-eyeseen-' + SL)
    const A = node('a', { parent: USER }), B = node('b', { parent: USER })
    const map = new Map([[A.id, A], [B.id, B]])
    s.assistantMsg('all green')
    await refreshConvo(SL, 'a')
    await refreshConvo(SL, 'b')
    const { el } = await mount(userNodeEl(map, SL))
    await flush()
    const panels = () => [...el.querySelectorAll('.eye-panel')]
    assert.equal(panels().length, 2, 'both direct lines opened')
    const keep = panels()[0]!.querySelector('.msgs')!
    assert.ok(resizeWatchers(keep) > 0, 'the surviving panel is watched')
    // A's reader is at the bottom and says so
    geometry(keep, { top: 600, height: 1000, client: 400 })
    await scroll(keep)
    // close B's tab — the real control, not a simulated prop change
    const tabs = [...el.querySelectorAll('.eye-tab-main')]
    assert.equal(tabs.length, 2, 'a tab per direct line')
    await inAct(() => { (tabs[1] as HTMLElement).click() })
    assert.equal(panels().length, 1, 'B’s panel closed')
    // …which is exactly the moment flex re-widths A, with no prop change.
    // jsdom does no layout, so the browser's reflow is stated here.
    geometry(keep, { top: 600, height: 1400, client: 400 })
    await inAct(() => { fireResize(keep) })
    assert.ok(keep.scrollTop >= 1400 - 400,
      `A stayed pinned to the bottom through B closing (scrollTop=${keep.scrollTop})`)
  })

domTest('§10.2 closing a tab does not re-render the panels that survive',
  async ({ SL, s, mount }) => {
    // constraint №21: the spring engine re-renders the canvas every animation
    // frame, so DeskChat is memoized on its DATA props. "Just drop the
    // comparator so flex re-layout always re-renders" would also make §10.1
    // pass — and turn a three-panel switchboard into a slideshow during every
    // camera glide. This is the test that refuses that trade.
    //
    // The probe: mutate a field on the SAME node object, so the comparator's
    // `p.node === n.node` still holds. An intact memo shows nothing; a
    // defeated one paints the spinner.
    localStorage.removeItem('orgtree-eyemin-' + SL)
    localStorage.removeItem('orgtree-eyeseen-' + SL)
    const A = node('a', { parent: USER }), B = node('b', { parent: USER })
    const map = new Map([[A.id, A], [B.id, B]])
    s.assistantMsg('all green')
    await refreshConvo(SL, 'a')
    await refreshConvo(SL, 'b')
    const { el } = await mount(userNodeEl(map, SL))
    await flush()
    const spinners = () =>
      el.querySelectorAll('.eye-panel .cc-head .cc-spin').length
    assert.equal(spinners(), 0, 'no panel is busy to begin with')
    A.busy = true                       // in place: same object identity
    const tabs = [...el.querySelectorAll('.eye-tab-main')]
    await inAct(() => { (tabs[1] as HTMLElement).click() })
    assert.equal(el.querySelectorAll('.eye-panel').length, 1, 'B’s panel closed')
    // …and that the surviving panel is A. Without this, inverting EyeDesk's
    // open-set (`!minned.has` → `minned.has`) leaves B on screen — not busy,
    // so the spinner probe alone stays green for the wrong reason.
    assert.equal(el.querySelector('.eye-panel .cc-name')?.textContent, 'a',
      'it is A that survived')
    assert.equal(spinners(), 0,
      'A did not re-render for B’s toggle — the memo (№21) still holds')
  })
