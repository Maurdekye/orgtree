// ⚠ THE HARNESS IMPORT COMES FIRST — see the import-order note in harness.ts.
import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { DocketDescription, DESC_FOLD_LINES } from '../src/canvas/docketdesc'
import { foldAt, mergeRows } from '../src/canvas/foldlines'
import { linkifyRefs } from '../src/canvas/refmd'
import { buildMentionIndex } from '../src/canvas/workrefs'
import type { WorkItem } from '../src/types'
import type { RefWorld } from '../src/canvas/reflinks'

// tests/docketdesc.test.tsx — A DESCRIPTION IS COMPLETE, MARKDOWN, AND FOLDED
// (user requirement 2026-09-12).
//
// The backend half — no cap, no truncation, the native rules — is
// `tests/test_work_description_complete.py` and `tests/test_description_doctrine.py`.
// This is the pane: what the reader actually sees.
//
// HOW LAYOUT IS FAKED, and why it has to be. jsdom does no layout: every
// `getBoundingClientRect()` is zeros and a Range has no client rects, so the
// real `foldAt` would answer "nothing to fold" for every input and every
// assertion about folding would pass vacuously. `layout()` below installs the
// smallest honest stand-in — ONE 16px row per text node, stacked 20px apart —
// which is exactly the shape a browser produces for short block-level lines.
// The code under test is the real one; only the measurements are supplied.

const LINE = 20        // row pitch
const HEIGHT = 16      // ink height of a row

/** Install a layout where every text node is its own visual line. Returns the
 *  restore function; each test calls it in a `finally`. */
function layout() {
  const win = (globalThis as unknown as { window: Window & typeof globalThis }).window
  const proto = win.HTMLElement.prototype
  const realRect = proto.getBoundingClientRect
  const realWidth = Object.getOwnPropertyDescriptor(proto, 'offsetWidth')
  const realRects = win.Range.prototype.getClientRects
  // call order IS document order — `foldAt` walks the body with a TreeWalker
  const seen = new Map<Node, number>()
  proto.getBoundingClientRect = function (this: HTMLElement) {
    return { top: 0, left: 0, right: 400, bottom: 1000, width: 400, height: 1000,
      x: 0, y: 0, toJSON: () => ({}) } as DOMRect
  }
  Object.defineProperty(proto, 'offsetWidth',
    { configurable: true, get: () => 400 })
  win.Range.prototype.getClientRects = function (this: Range) {
    const node = this.startContainer
    if (!seen.has(node)) seen.set(node, seen.size)
    const i = seen.get(node)!
    return [{ top: i * LINE, bottom: i * LINE + HEIGHT, left: 0, right: 200,
      width: 200, height: HEIGHT, x: 0, y: i * LINE,
      toJSON: () => ({}) } as DOMRect] as unknown as DOMRectList
  }
  return () => {
    proto.getBoundingClientRect = realRect
    if (realWidth) Object.defineProperty(proto, 'offsetWidth', realWidth)
    else delete (proto as unknown as Record<string, unknown>).offsetWidth
    win.Range.prototype.getClientRects = realRects
  }
}

const WORLD: RefWorld = { org: 'org1', items: new Map(), agents: new Map() }

/** `n` markdown paragraphs, each one text node and therefore one line. */
const paras = (n: number, tag = 'p') =>
  Array.from({ length: n }, (_, i) => `${tag} ${i + 1} of ${n}`).join('\n\n')

const mount = (node: React.ReactNode) => mountView(node, (el) => el)
const clip = (el: HTMLElement) => el.querySelector('.docket-desc-clip') as HTMLElement
const body = (el: HTMLElement) => el.querySelector('.docket-desc-body') as HTMLElement
const toggle = (el: HTMLElement) =>
  el.querySelector('.docket-desc-toggle') as HTMLButtonElement | null
/** ⚠ BOOLEANS, NOT ELEMENTS, IN ASSERTIONS. A failed `assert.equal(el, null)`
 *  asks node:test to serialise a whole jsdom subtree; on a 30-paragraph
 *  description that exhausts the heap and reports an allocation error instead
 *  of the assertion that actually failed. */
const folded = (el: HTMLElement) => !!el.querySelector('.docket-desc-fold.folded')
const hasToggle = (el: HTMLElement) => toggle(el) !== null
const rect = (top: number, bottom: number): DOMRect =>
  ({ top, bottom, left: 0, right: 200, width: 200, height: bottom - top,
    x: 0, y: top, toJSON: () => ({}) }) as DOMRect

// ────────────────────────────────────────────── §1 the measurement itself

test('§1 fragments sharing a visual row are one line, and a gap is not a line', () => {
  const r = (top: number, left: number): DOMRect =>
    ({ top, bottom: top + 16, left, right: left + 40, width: 40, height: 16,
      x: left, y: top, toJSON: () => ({}) }) as DOMRect
  // two fragments on one row (prose + inline code), then a second row
  assert.equal(mergeRows([r(0, 0), r(1, 40), r(20, 0)]).length, 2)
  // a paragraph gap is empty space, so it contributes no row of its own
  assert.equal(mergeRows([r(0, 0), r(60, 0)]).length, 2)
  assert.deepEqual(mergeRows([]), [])
})

test('§1b an unmeasurable body folds nothing rather than guessing', () => {
  // the jsdom default: no width, no rects. "I cannot tell" must read as "do
  // not fold", never as "fold at zero".
  const el = document.createElement('div')
  assert.deepEqual(foldAt(el, DESC_FOLD_LINES), { limit: null, lines: 0 })
})

// ─────────────────────────────────── §2 the ten-line boundary and default

test('§2 a description of ten rendered lines or fewer is shown whole, with no control', async () => {
  const restore = layout()
  try {
    for (const n of [1, 5, DESC_FOLD_LINES]) {
      const v = await mount(
        <DocketDescription text={paras(n)} world={WORLD} slug="an-item" />)
      await flush()
      assert.equal(hasToggle(v.el), false,
        `a ${n}-line description was given an expand control it does not need`)
      assert.equal(folded(v.el), false)
      assert.equal(clip(v.el).style.maxHeight, '')
      await v.unmount()
    }
  } finally { restore() }
})

test('§2b one line past ten starts COLLAPSED, clipped to ten lines', async () => {
  const restore = layout()
  try {
    const v = await mount(
      <DocketDescription text={paras(DESC_FOLD_LINES + 1)} world={WORLD} slug="an-item" />)
    await flush()
    const t = toggle(v.el)
    assert.ok(t, 'an eleven-line description got no expand control')
    assert.equal(t.getAttribute('aria-expanded'), 'false')
    assert.ok(folded(v.el), 'the description did not start collapsed')
    // the clip sits between the tenth row and the eleventh, never inside one
    const tenth = (DESC_FOLD_LINES - 1) * LINE + HEIGHT
    assert.equal(clip(v.el).style.maxHeight,
      `${tenth + (DESC_FOLD_LINES * LINE - tenth) / 2}px`)
    await v.unmount()
  } finally { restore() }
})

// ─────────────────────────────────────────────────── §3 expand / collapse

test('§3 expanding reveals the whole description and collapsing puts it back', async () => {
  const restore = layout()
  try {
    const text = paras(40)
    const v = await mount(
      <DocketDescription text={text} world={WORLD} slug="an-item" />)
    await flush()
    // ⚠ THE WHOLE TEXT IS PRESENT EVEN WHILE COLLAPSED — the fold is a clip,
    // not a cut, which is what keeps find-in-page and "copy contents" honest.
    assert.match(body(v.el).textContent ?? '', /p 40 of 40/)
    assert.equal(toggle(v.el)!.textContent, 'show all 40 lines')

    await inAct(() => toggle(v.el)!.click())
    await flush()
    assert.equal(toggle(v.el)!.getAttribute('aria-expanded'), 'true')
    assert.equal(folded(v.el), false)
    assert.equal(clip(v.el).style.maxHeight, '', 'the clip survived expansion')
    assert.equal(toggle(v.el)!.textContent, 'show less')
    assert.match(body(v.el).textContent ?? '', /p 40 of 40/)

    await inAct(() => toggle(v.el)!.click())
    await flush()
    assert.equal(toggle(v.el)!.getAttribute('aria-expanded'), 'false')
    assert.ok(folded(v.el))
    await v.unmount()
  } finally { restore() }
})

test('§3b the control is reachable and labelled — it says what it does and what it drives', async () => {
  const restore = layout()
  try {
    const v = await mount(
      <DocketDescription text={paras(30)} world={WORLD} slug="an-item" />)
    await flush()
    const t = toggle(v.el)!
    assert.equal(t.tagName, 'BUTTON', 'the control is not focusable')
    assert.equal(t.getAttribute('type'), 'button')
    // aria-controls must NAME the region it expands, or a screen reader is
    // told a control exists and not what it opens
    assert.equal(t.getAttribute('aria-controls'), clip(v.el).id)
    assert.ok(clip(v.el).id)
    assert.match(t.getAttribute('aria-label') ?? '', /Expand the description/)
    await inAct(() => t.click())
    await flush()
    assert.match(toggle(v.el)!.getAttribute('aria-label') ?? '', /Collapse the description/)
    await v.unmount()
  } finally { restore() }
})

test('§3c keyboard focus landing below the fold reveals the description', async () => {
  const restore = layout()
  try {
    const v = await mount(
      <DocketDescription text={paras(30)} world={WORLD} slug="an-item" />)
    await flush()
    assert.ok(folded(v.el))
    // a target whose bottom is past the clip's is what "focus went somewhere
    // invisible" looks like; the pane must open rather than leave the caret
    // out of sight. The rects are per-element so the prototype stub, which
    // answers the same box for everything, cannot decide this by itself.
    const region = clip(v.el)
    const target = region.querySelector('p:last-of-type') as HTMLElement
    assert.ok(target, 'no element to focus below the fold')
    region.getBoundingClientRect = () => rect(0, 200)
    target.getBoundingClientRect = () => rect(900, 916)
    await inAct(() => {
      target.dispatchEvent(new window.Event('focusin', { bubbles: true }))
    })
    await flush()
    assert.equal(folded(v.el), false,
      'focus below the fold left the description collapsed')
    await v.unmount()
  } finally { restore() }
})

// ──────────────────────────────────────────────────── §4 full markdown

test('§4 the description renders the supported markdown, not its punctuation', async () => {
  const restore = layout()
  try {
    const text = [
      '# Problem',
      'It was **plain** text with `code` and a [link](https://example.invalid/x).',
      '## Requirements',
      '- first rule',
      '- second rule',
      '1. ordered',
      '> quoted ruling',
      '```js',
      'const kept = true',
      '```',
      '| field | rule |',
      '| --- | --- |',
      '| objective | uncapped |',
    ].join('\n')
    const v = await mount(
      <DocketDescription text={text} world={WORLD} slug="an-item" />)
    await flush()
    const md = body(v.el)
    for (const sel of ['h1', 'h2', 'strong', 'code', 'a[href]', 'ul li',
      'ol li', 'blockquote', 'pre code', 'table td']) {
      assert.ok(md.querySelector(sel), `markdown produced no ${sel}`)
    }
    // and the source punctuation is GONE from the rendered text — the whole
    // complaint was reading `**bold**` and `##` on screen
    assert.doesNotMatch(md.textContent ?? '', /\*\*|^## /m)
    assert.equal(md.querySelector('a[href]')?.getAttribute('href'),
      'https://example.invalid/x')
    await v.unmount()
  } finally { restore() }
})

test('§4b markdown cannot smuggle script in — the body is still sanitized', async () => {
  const restore = layout()
  try {
    const v = await mount(
      <DocketDescription world={WORLD} slug="an-item"
        text={'Problem <img src=x onerror="throw 1"> and <script>bad()</script> here.'} />)
    await flush()
    assert.equal(body(v.el).querySelector('script'), null)
    assert.equal(body(v.el).querySelector('img[onerror]'), null)
    await v.unmount()
  } finally { restore() }
})

test('§4c a bare item name inside markdown is still a control', async () => {
  const restore = layout()
  try {
    const went: string[] = []
    const index = buildMentionIndex([
      { slug: 'the-other-ticket', title: 'The other ticket' } as WorkItem,
    ])
    const v = await mount(
      <DocketDescription world={WORLD} slug="an-item" index={index}
        onPick={(s) => went.push(s)}
        text={'Problem stated.\n\n- blocked behind the-other-ticket\n- then ship'} />)
    await flush()
    const link = body(v.el).querySelector('.docket-ref') as HTMLElement | null
    assert.ok(link, 'a bare item name in a markdown list stopped being a link')
    assert.equal(link.textContent, 'the-other-ticket')
    // the list item still reads as the sentence the author wrote
    assert.match(body(v.el).textContent ?? '', /blocked behind the-other-ticket/)
    await inAct(() => link.click())
    assert.deepEqual(went, ['the-other-ticket'])
    await v.unmount()
  } finally { restore() }
})

// ───────────────────────────────────────────── §5 editing and item changes

test('§5 an edited description is re-rendered and re-measured', async () => {
  const restore = layout()
  try {
    const v = await mount(
      <DocketDescription text={paras(3)} world={WORLD} slug="an-item" />)
    await flush()
    assert.equal(hasToggle(v.el), false)

    // the same item, rewritten to a long spec — the pane must not keep
    // showing the short one, and must now offer the control
    await v.render(
      <DocketDescription text={paras(25, 'rule')} world={WORLD} slug="an-item" />)
    await flush()
    assert.match(body(v.el).textContent ?? '', /rule 25 of 25/)
    assert.doesNotMatch(body(v.el).textContent ?? '', /p 1 of 3/)
    assert.equal(toggle(v.el)?.textContent, 'show all 25 lines')

    // …and shortening it again takes the control away
    await v.render(
      <DocketDescription text={paras(2)} world={WORLD} slug="an-item" />)
    await flush()
    assert.equal(hasToggle(v.el), false)
    await v.unmount()
  } finally { restore() }
})

test('§5b reading a DIFFERENT item starts collapsed again', async () => {
  const restore = layout()
  try {
    const v = await mount(
      <DocketDescription text={paras(30)} world={WORLD} slug="first-item" />)
    await flush()
    await inAct(() => toggle(v.el)!.click())
    await flush()
    assert.equal(toggle(v.el)!.getAttribute('aria-expanded'), 'true')

    await v.render(
      <DocketDescription text={paras(30, 'other')} world={WORLD} slug="second-item" />)
    await flush()
    assert.equal(toggle(v.el)!.getAttribute('aria-expanded'), 'false',
      'the next item inherited the previous one\'s expansion')
    await v.unmount()
  } finally { restore() }
})

test('§5c a short existing description is untouched by any of this', async () => {
  const restore = layout()
  try {
    const v = await mount(
      <DocketDescription world={WORLD} slug="old-item"
        text={'Something is broken. Fix it by doing the obvious thing.'} />)
    await flush()
    assert.equal(hasToggle(v.el), false)
    assert.equal(body(v.el).textContent?.trim(),
      'Something is broken. Fix it by doing the obvious thing.')
    assert.equal(clip(v.el).style.maxHeight, '')
    await v.unmount()
  } finally { restore() }
})

// ───────────────────────────── §6 one measurement, two callers, two limits

test('§6 the shared measurement answers per caller — mail still folds at five', async () => {
  const restore = layout()
  try {
    // the received-mail preview and this pane now share `foldAt`; the only
    // difference between them is the number they pass, so pin that it is
    // really the parameter deciding and not a constant left behind.
    const v = await mount(
      <DocketDescription text={paras(7)} world={WORLD} slug="an-item" />)
    await flush()
    // seven lines: under the description's ten, over mail's five
    assert.equal(hasToggle(v.el), false)
    const measured = foldAt(body(v.el), 5)
    assert.equal(measured.lines, 7)
    assert.ok(measured.limit !== null, 'seven lines did not fold at five')
    assert.equal(foldAt(body(v.el), DESC_FOLD_LINES).limit, null)
    await v.unmount()
  } finally { restore() }
})

// ─────────────────────── §7 the index changes under a description on screen

test('§7 a name that ENTERS the index becomes a control without a reload', async () => {
  // ⚠ THE REGRESSION account-pro FOUND REVIEWING 704d946. An unknown bare
  // name leaves no chip, so the cheap exit had nothing that disagreed when
  // the index later learned the name: every chip still matched and the pass
  // returned without ever looking at the word beside them.
  const restore = layout()
  try {
    const text = 'Follow alpha-ticket and beta-ticket.'
    const one = buildMentionIndex([{ slug: 'alpha-ticket', title: 'A' } as WorkItem])
    const two = buildMentionIndex([
      { slug: 'alpha-ticket', title: 'A' } as WorkItem,
      { slug: 'beta-ticket', title: 'B' } as WorkItem,
    ])
    const went: string[] = []
    const v = await mount(
      <DocketDescription text={text} world={WORLD} slug="this-ticket"
        index={one} onPick={(s) => went.push(s)} />)
    await flush()
    assert.equal(v.el.querySelectorAll('.docket-ref').length, 1)

    await v.render(
      <DocketDescription text={text} world={WORLD} slug="this-ticket"
        index={two} onPick={(s) => went.push(s)} />)
    await flush()
    assert.equal(v.el.querySelectorAll('.docket-ref').length, 2,
      'a name that entered the index stayed prose')
    const names = [...v.el.querySelectorAll('.docket-ref')].map(e => e.textContent)
    assert.deepEqual(names, ['alpha-ticket', 'beta-ticket'])
    // and the new one really works, rather than merely looking like a control
    await inAct(() => (v.el.querySelectorAll('.docket-ref')[1] as HTMLElement).click())
    assert.deepEqual(went, ['beta-ticket'])

    // …and a name LEAVING the index gives the word back
    await v.render(
      <DocketDescription text={text} world={WORLD} slug="this-ticket"
        index={one} onPick={(s) => went.push(s)} />)
    await flush()
    assert.equal(v.el.querySelectorAll('.docket-ref').length, 1)
    assert.match(body(v.el).textContent ?? '', /Follow alpha-ticket and beta-ticket\./)
    await v.unmount()
  } finally { restore() }
})

test('§7b the same names arriving in a fresh index rebuild nothing', async () => {
  // the other half of §7, and the reason the check is a fingerprint of the
  // NAMES rather than the index object: the docket rebuilds its index from a
  // re-fetched list every poll, so an identical-but-new Map arrives every few
  // seconds. Rebuilding on those would drop the reader's text selection
  // repeatedly — a worse fault than the one §7 fixes.
  const host = document.createElement('div')
  host.innerHTML = '<p>Follow alpha-ticket and beta-ticket.</p>'
  const mk = () => buildMentionIndex([
    { slug: 'alpha-ticket', title: 'A' } as WorkItem,
    { slug: 'beta-ticket', title: 'B' } as WorkItem,
  ])
  const onPick = () => {}
  assert.equal(linkifyRefs(host, WORLD, true, { index: mk(), onPick }), 2)
  const before = [...host.querySelectorAll('.docket-ref')]
  // ⚠ IDENTITY, ELEMENT BY ELEMENT — never `deepEqual` on DOM nodes, which
  // can never fail (deepdom.test §1 guards the whole directory against it).
  // Rebuilt chips would be equal in every field and still be new objects, so
  // identity is the only comparison that says what this test means.
  const sameNodes = () => {
    const now = [...host.querySelectorAll('.docket-ref')]
    return now.length === before.length && now.every((el, i) => el === before[i])
  }
  // a DIFFERENT Map with the same contents — "nothing needed doing" is -1,
  // and the very same elements are still on screen
  assert.equal(linkifyRefs(host, WORLD, true, { index: mk(), onPick }), -1)
  assert.equal(sameNodes(), true, 'an identical index replaced the chips')
  // insertion order is the fetch's, not a fact about the index
  const reversed = buildMentionIndex([
    { slug: 'beta-ticket', title: 'B' } as WorkItem,
    { slug: 'alpha-ticket', title: 'A' } as WorkItem,
  ])
  assert.equal(linkifyRefs(host, WORLD, true, { index: reversed, onPick }), -1)
  assert.equal(sameNodes(), true, 'a reordered index replaced the chips')
})

test('§7c a bare host with no index scans, records, and then notices one arriving', () => {
  // the direct-call shape of §7, without React in the way
  const host = document.createElement('div')
  host.innerHTML = '<p>Follow alpha-ticket and beta-ticket.</p>'
  const onPick = () => {}
  assert.equal(linkifyRefs(host, WORLD, true), 0)
  assert.equal(host.querySelectorAll('.docket-ref').length, 0)
  const two = buildMentionIndex([
    { slug: 'alpha-ticket', title: 'A' } as WorkItem,
    { slug: 'beta-ticket', title: 'B' } as WorkItem,
  ])
  assert.equal(linkifyRefs(host, WORLD, true, { index: two, onPick }), 2)
  assert.equal(host.querySelectorAll('.docket-ref').length, 2)
})

test('§7d two DIFFERENT name sets are never mistaken for each other', () => {
  // ⚠ THE SECOND account-pro FINDING, on 075a63f. The first fix compared a
  // HASH of the name set, which is lossy by construction — and the loss lands
  // exactly on the bug: a set that changed while hashing the same fires the
  // exit and the new name never links. `an-ticket` and `c0-ticket` are both
  // ordinary slugs and collide under a polynomial hash (97*31+110 ===
  // 99*31+48), so swapping one for the other was invisible. Set membership
  // cannot collide; this pins that it is membership being compared.
  const host = document.createElement('div')
  host.innerHTML = '<p>Follow alpha-ticket and c0-ticket.</p>'
  const onPick = () => {}
  const item = (slug: string) => ({ slug, title: slug.toUpperCase() } as WorkItem)
  // the unmentioned third name is the one that changes; alpha's chip is
  // identical either way, so nothing else in the exit can notice
  const before = buildMentionIndex([item('alpha-ticket'), item('an-ticket')])
  const after = buildMentionIndex([item('alpha-ticket'), item('c0-ticket')])

  assert.equal(linkifyRefs(host, WORLD, true, { index: before, onPick }), 1)
  assert.equal(host.querySelectorAll('.docket-ref').length, 1)
  assert.equal(linkifyRefs(host, WORLD, true, { index: after, onPick }), 2)
  const names = [...host.querySelectorAll('.docket-ref')].map(e => e.textContent)
  assert.deepEqual(names, ['alpha-ticket', 'c0-ticket'],
    'a colliding name swap left the prose undecorated')
})

test('§7e a same-size swap in either direction is seen, and identity is not', () => {
  // the general shape of §7d: equal sizes, one name exchanged. Also pins that
  // the record is per-HOST, so one description learning a name says nothing
  // about another.
  const onPick = () => {}
  const item = (slug: string) => ({ slug, title: slug } as WorkItem)
  const mk = (second: string) =>
    buildMentionIndex([item('alpha-ticket'), item(second)])

  const a = document.createElement('div')
  a.innerHTML = '<p>Follow alpha-ticket and beta-ticket.</p>'
  assert.equal(linkifyRefs(a, WORLD, true, { index: mk('gamma-ticket'), onPick }), 1)
  assert.equal(linkifyRefs(a, WORLD, true, { index: mk('beta-ticket'), onPick }), 2)
  // and back again — the name that left gives its word up
  assert.equal(linkifyRefs(a, WORLD, true, { index: mk('gamma-ticket'), onPick }), 1)

  const b = document.createElement('div')
  b.innerHTML = '<p>Follow alpha-ticket and beta-ticket.</p>'
  // a host that has never been scanned does its own full walk regardless of
  // what any other host was told
  assert.equal(linkifyRefs(b, WORLD, true, { index: mk('beta-ticket'), onPick }), 2)
})
