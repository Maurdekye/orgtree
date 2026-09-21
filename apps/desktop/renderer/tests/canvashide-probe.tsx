// canvashide-probe.tsx — DOES `canvasContent="hidden"` ACTUALLY WORK?
//
// This probe exists because I got the same thing wrong twice in the published
// interface, and prose is what let me. Rev 2 §6 specified `inert` +
// `aria-hidden` + `pointer-events: none` and called the canvas hidden;
// multi-window-design had to point out — twice — that none of those three
// paints anything differently, so what I had described was a canvas that was
// unreachable and still fully visible under the Attention stage. Rev 3 §5 adds
// `visibility: hidden` and claims it reaches the world through a
// `display: contents` wrapper by inheritance. THAT IS STILL A CLAIM. It is
// four CSS mechanics stacked on each other, and jsdom implements none of them:
// no `inert`, no `display: contents` layout, no compositing, no hit testing.
//
// So this measures all four in a real Chromium before anything is built on
// them, and it measures the NEGATIVE CONTROL too — the plain positioned
// wrapper I claimed would break the canvas — because "my choice was necessary"
// is a different claim from "my choice works", and rev 3 asserts both.
//
// THE FOUR THINGS UNDER TEST
//   1. visibility: hidden on a `display: contents` wrapper reaches the world
//      children by inheritance (it generates no box, so this is inheritance
//      doing the work, not containment).
//   2. A pinned window — portaled OUT of that subtree, exactly as pins.tsx:402
//      and modalpin.tsx:492 do — keeps visibility: visible, stays hit-testable
//      and stays focusable. This is the whole "retain retained panels" rule.
//   3. LAYOUT IS PRESERVED: `.space`'s geometry is identical hidden and shown,
//      so the camera, the springs and `posOf` survive the switch. This is why
//      the rule is `visibility` and not `display: none`.
//   4. Inserting the wrapper at all changes NOTHING about where the world
//      lands, and a plain positioned wrapper DOES — it becomes a containing
//      block and a stacking context, reparenting `.space`'s transform and
//      inverting the world-vs-pin-layer z-order.
//
// It also separates what `inert` contributes from what `visibility` does, since
// conflating "disabled" with "hidden" is the exact mistake this probe is here
// to stop me repeating: phase B applies inert alone, phase C visibility alone,
// phase D both.
//
// ISOLATION: run through tools/run-probe.mjs, which spawns Electron with
// ORGTREE_DATA and HOME inside a temp root and moves Electron's own state there
// with app.setPath. No server is contacted, no live data root is opened, and
// the installed app is never launched. This probe renders no orgtree component
// and calls no API at all — it is the DOM shape and the real stylesheet.
//
// Run:   node tools/run-probe.mjs apps/desktop/renderer/tests/canvashide-probe.tsx .probe-canvashide
// Reads: result.json — every entry of `checks` must have ok: true.
import '../src/styles.css'

declare global { interface Window { PROBE: Record<string, unknown> } }
const checks: { name: string; ok: boolean; detail: string }[] = []
const record = (name: string, ok: boolean, detail: string) => {
  checks.push({ name, ok, detail })
  window.PROBE = { checks, pass: checks.filter(c => c.ok).length, fail: checks.filter(c => !c.ok).length }
}
window.PROBE = { checks, pass: 0, fail: 0 }

const el = (tag: string, cls: string, style = '') => {
  const n = document.createElement(tag)
  n.className = cls
  n.setAttribute('style', style)
  return n
}
const vis = (n: Element) => getComputedStyle(n).visibility
const rect = (n: Element) => {
  const r = n.getBoundingClientRect()
  return `${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}x${Math.round(r.height)}`
}

// ── the structure, mirroring OrgCanvas: world children + the ADOPTED pin layer
// as siblings inside `.viewport`. adoptPinLayer does host.appendChild(layer)
// (pinspace.ts:121-128), so the pin layer really is a DOM child of the
// viewport — which is the reason the mark can never go on the viewport itself.
function build(wrapperStyle: string, wrapperTag = 'div') {
  document.body.innerHTML = ''
  const root = el('div', 'probe-root', 'position:relative;width:900px;height:700px')
  const vp = el('div', 'viewport', 'position:relative;width:900px;height:700px;overflow:hidden')
  const wrap = el(wrapperTag, 'cc-world', wrapperStyle)
  const bg = el('div', 'canvas-bg', 'position:absolute;inset:0')
  // the real .space carries the camera transform; a transform makes it a
  // containing block, which is part of what a wrapper can disturb
  const space = el('div', 'space', 'position:absolute;left:0;top:0;width:1400px;'
    + 'height:1000px;transform:translate(40px,30px) scale(1.25);transform-origin:0 0')
  const card = el('div', 'sq', 'position:absolute;left:100px;top:80px;width:240px;height:120px')
  const cardbtn = document.createElement('button')
  cardbtn.id = 'cardbtn'
  cardbtn.textContent = 'card control'
  card.appendChild(cardbtn)
  space.appendChild(card)
  // ⚠ THE CHROME THAT DERIVES A DEFINITE HEIGHT FROM ITS CONTAINING BLOCK.
  // This is `.tray-wrap`'s real shape, and styles.css:5156-5159 says why in its
  // own words: "top+bottom (not bottom-only) gives the wrap a DEFINITE height —
  // the canvas viewport's own height minus this margin — so .tray's
  // max-height: 100% below is bound by the real canvas". An element like this
  // is the one that a boxed wrapper destroys, and it is what my first pass at
  // phase F failed to include.
  const tray = el('div', 'probe-tray', 'position:absolute;top:10px;bottom:10px;left:0;width:200px')
  const trayInner = el('div', 'probe-tray-inner', 'max-height:100%;height:100%')
  tray.appendChild(trayInner)
  wrap.appendChild(bg)
  wrap.appendChild(space)
  wrap.appendChild(tray)
  vp.appendChild(wrap)
  // the pin layer, appended to the VIEWPORT as adoptPinLayer does — and its
  // window deliberately OVERLAPS the card, so z-order is measurable rather
  // than assumed
  const layer = el('div', 'pin-layer', '')
  const pinwin = el('div', 'pinwin', 'position:absolute;left:150px;top:120px;width:260px;height:160px;background:#222')
  const pinbtn = document.createElement('button')
  pinbtn.id = 'pinbtn'
  pinbtn.textContent = 'pin control'
  pinwin.appendChild(pinbtn)
  layer.appendChild(pinwin)
  vp.appendChild(layer)
  root.appendChild(vp)
  document.body.appendChild(root)
  return { vp, wrap, bg, space, card, cardbtn, layer, pinwin, pinbtn }
}

const CONTENTS = 'display:contents'
const HIDDEN_CONTENTS = 'display:contents;visibility:hidden;pointer-events:none'

document.title = 'phase A'
// ── PHASE A: the wrapper is inert in the ENGLISH sense — does inserting a
// display:contents wrapper move anything at all?
{
  const bare = build('')                       // no wrapper styling: plain div
  const bareCard = rect(bare.card)
  const barePin = rect(bare.pinwin)
  const wrapped = build(CONTENTS)              // same tree, display:contents
  const wrappedCard = rect(wrapped.card)
  const wrappedPin = rect(wrapped.pinwin)
  record('A1 display:contents wrapper does not move the world',
    bareCard === wrappedCard,
    `plain-div wrapper: ${bareCard} · display:contents: ${wrappedCard}`)
  record('A2 …nor the pin layer', barePin === wrappedPin,
    `plain-div: ${barePin} · display:contents: ${wrappedPin}`)
  record('A3 the display:contents wrapper generates no box of its own',
    getComputedStyle(wrapped.wrap).display === 'contents',
    `computed display = ${getComputedStyle(wrapped.wrap).display}`)
}

document.title = 'phase B'
// ── PHASE B: `inert` ALONE. This is what rev 2 shipped in its prose. If inert
// alone hides anything, rev 2 was right and multi-window-design was wrong; I
// expect the opposite and want it on the record.
{
  const t = build(CONTENTS)
  t.wrap.setAttribute('inert', '')
  t.wrap.setAttribute('aria-hidden', 'true')
  record('B1 inert + aria-hidden do NOT hide anything visually',
    vis(t.space) === 'visible' && vis(t.card) === 'visible',
    `space=${vis(t.space)} card=${vis(t.card)} — rev 2's mistake, measured`)
  t.cardbtn.focus()
  record('B2 inert DOES refuse focus inside the subtree',
    document.activeElement !== t.cardbtn,
    `activeElement = ${document.activeElement?.id || document.activeElement?.tagName}`)
  const hitInert = document.elementFromPoint(200, 200)
  record('B3 inert alone still leaves the world in the hit-test path',
    !!hitInert, `elementFromPoint(200,200) = ${hitInert?.id || hitInert?.className}`)
}

document.title = 'phase C'
// ── PHASE C: `visibility: hidden` alone, through the box-less wrapper. THE
// CLAIM REV 3 RESTS ON: inheritance carries it to children the wrapper does
// not contain in the layout sense.
{
  const t = build(HIDDEN_CONTENTS)
  record('C1 visibility:hidden INHERITS through display:contents to the world',
    vis(t.space) === 'hidden' && vis(t.card) === 'hidden' && vis(t.bg) === 'hidden',
    `space=${vis(t.space)} card=${vis(t.card)} bg=${vis(t.bg)}`)
  record('C2 …and reaches a nested control, not just the direct children',
    vis(t.cardbtn) === 'hidden', `cardbtn=${vis(t.cardbtn)}`)
  record('C3 THE PIN LAYER IS UNAFFECTED — it is a sibling, not a descendant',
    vis(t.pinwin) === 'visible' && vis(t.pinbtn) === 'visible',
    `pinwin=${vis(t.pinwin)} pinbtn=${vis(t.pinbtn)}`)
  record('C4 the viewport itself is untouched',
    vis(t.vp) === 'visible', `viewport=${vis(t.vp)}`)
  t.pinbtn.focus()
  record('C5 the pinned window stays FOCUSABLE while the canvas is hidden',
    document.activeElement === t.pinbtn,
    `activeElement = ${document.activeElement?.id || document.activeElement?.tagName}`)
  const hit = document.elementFromPoint(260, 220)
  record('C6 the hidden world is out of the hit-test path; the pin answers',
    !!hit && (hit === t.pinwin || hit === t.pinbtn || t.pinwin.contains(hit)),
    `elementFromPoint(260,220) = ${hit?.id || hit?.className}`)
}

document.title = 'phase D'
// ── PHASE D: LAYOUT PRESERVED. The reason the rule is `visibility` and not
// `display: none`: the camera and posOf must survive the switch untouched.
{
  const shown = build(CONTENTS)
  const shownCard = rect(shown.card)
  const shownSpace = rect(shown.space)
  const hid = build(HIDDEN_CONTENTS)
  hid.wrap.setAttribute('inert', '')
  hid.wrap.setAttribute('aria-hidden', 'true')
  record('D1 .space geometry is identical hidden and shown',
    shownSpace === rect(hid.space), `shown ${shownSpace} · hidden ${rect(hid.space)}`)
  record('D2 a card inside the transform keeps its exact position',
    shownCard === rect(hid.card), `shown ${shownCard} · hidden ${rect(hid.card)}`)
  record('D3 the full rule together: hidden world, live pin',
    vis(hid.card) === 'hidden' && vis(hid.pinbtn) === 'visible',
    `card=${vis(hid.card)} pinbtn=${vis(hid.pinbtn)}`)
  // and it must be REVERSIBLE with no layout recomputation surprise
  hid.wrap.setAttribute('style', CONTENTS)
  hid.wrap.removeAttribute('inert')
  hid.wrap.removeAttribute('aria-hidden')
  record('D4 restoring the canvas returns the exact same geometry',
    rect(hid.card) === shownCard && vis(hid.card) === 'visible',
    `restored ${rect(hid.card)} vis=${vis(hid.card)} · expected ${shownCard}`)
}

document.title = 'phase E'
// ── PHASE E: THE NEGATIVE CONTROL. Rev 3 claims a plain positioned wrapper
// would BREAK the canvas by becoming a containing block and a stacking
// context. If this phase shows no difference, that claim is wrong and the
// document must stop making it.
{
  const good = build(CONTENTS)
  const goodHit = document.elementFromPoint(260, 220)
  const goodOverPin = !!goodHit && (goodHit === good.pinwin || goodHit === good.pinbtn
    || good.pinwin.contains(goodHit))
  const bad = build('position:relative;z-index:0')
  const badHit = document.elementFromPoint(260, 220)
  const badOverPin = !!badHit && (badHit === bad.pinwin || badHit === bad.pinbtn
    || bad.pinwin.contains(badHit))
  record('E1 with display:contents the pin layer still paints OVER the world',
    goodOverPin, `elementFromPoint = ${goodHit?.id || goodHit?.className}`)
  // ⚠ MEASURED FALSE ON THE FIRST RUN, AND THE DOCUMENT WAS CORRECTED.
  // Rev 3 §5 claimed a positioned wrapper would invert the world-vs-pin-layer
  // z-order. It does not: the wrapper's stacking context is placed at its own
  // z-index (0) as a SIBLING of `.pin-layer` inside the viewport, and 16 still
  // beats 0, so pins keep painting on top. The check is kept, inverted, so the
  // claim cannot quietly come back — and so the z-order hazard is documented as
  // the one that ISN'T real, separately from the containing-block hazard in
  // phase F, which is.
  record('E2 a positioned wrapper does NOT invert the z-order (claim retracted)',
    badOverPin,
    `plain wrapper elementFromPoint = ${badHit?.id || badHit?.className}`
    + ' — .pin-layer z-index 16 is a sibling of the wrapper and still wins')
  record('E3 …and the two wrappers are genuinely being compared',
    goodOverPin === badOverPin,
    `display:contents overPin=${goodOverPin} · plain overPin=${badOverPin}`)
}

document.title = 'phase F'
// ── PHASE F: THE HAZARD THAT IS REAL. A positioned wrapper becomes a
// CONTAINING BLOCK, and `.space` is absolutely positioned — so the camera's
// origin resolves against the wrapper instead of the viewport. This is the
// half of the rev 3 claim I had bundled together with the z-order half and had
// not measured separately. It is the actual reason the wrapper must be
// box-less.
// ⚠ METHODOLOGY, LEARNED BY GETTING IT WRONG ON THE FIRST RUN OF THIS PHASE.
// `build()` clears document.body, so every tree it made before is DETACHED,
// and a detached element measures 0,0 0x0. My first version built all five
// trees and then compared their rects, which measured detachment rather than
// containing blocks — three "results" that meant nothing, two of which looked
// like confirmations of what I wanted. So each shape is now built and measured
// while it is the one attached to the document, and the reference is taken the
// same way.
{
  const measure = (wrapperStyle: string) => {
    const t = build(wrapperStyle)
    const tray = t.vp.querySelector('.probe-tray')!
    const inner = t.vp.querySelector('.probe-tray-inner')!
    return {
      space: rect(t.space), card: rect(t.card), pin: rect(t.pinwin),
      bgH: Math.round(t.bg.getBoundingClientRect().height),
      trayH: Math.round(tray.getBoundingClientRect().height),
      innerH: Math.round(inner.getBoundingClientRect().height),
    }
  }
  const ref = measure(CONTENTS)              // the shape rev 3 specifies
  const staticDiv = measure('')              // unstyled div — not a containing block
  const relative = measure('position:relative')
  const absolute = measure('position:absolute;inset:0')
  const transformed = measure('transform:translateZ(0)')

  record('F1 an unstyled div wrapper is harmless (creates no containing block)',
    staticDiv.space === ref.space && staticDiv.card === ref.card,
    `display:contents ${ref.space} / ${ref.card} · static div ${staticDiv.space} / ${staticDiv.card}`)
  // ⚠ CLAIM RETRACTED, MEASURED TWICE. Rev 3 §5 said a boxed wrapper would move
  // the camera origin and invert the pin z-order. Neither happens: `.space` is
  // `position:absolute` with the transform origin at its own top-left, and a
  // block wrapper's padding box starts at the same point, so absolutely
  // positioned children with explicit offsets land identically. These two
  // checks now assert the retraction so the wrong reason cannot come back.
  record('F2 RETRACTED: a boxed wrapper does NOT move the camera origin',
    relative.space === ref.space && absolute.space === ref.space
    && transformed.space === ref.space,
    `contents ${ref.space} · rel ${relative.space} · abs ${absolute.space}`
    + ` · transform ${transformed.space} — all identical`)
  record('F3 RETRACTED: nor does it move the cards',
    relative.card === ref.card, `contents ${ref.card} · rel ${relative.card}`)

  // ⚠ THE HAZARD THAT IS ACTUALLY REAL, and the codebase names it itself.
  // `.tray-wrap` sets top AND bottom to derive a DEFINITE HEIGHT from the
  // viewport, so `.tray`'s `max-height: 100%` is "bound by the real canvas"
  // (styles.css:5156-5159). A BOXED wrapper becomes that containing block, and
  // its own height is zero because every child in it is absolutely positioned
  // — so the tray's definite height collapses and the chrome vanishes. Same
  // mechanism for `.canvas-bg`'s `inset: 0`.
  record('F4 THE REAL HAZARD: a boxed wrapper collapses chrome with a definite height',
    relative.trayH !== ref.trayH && relative.trayH === 0,
    `tray height — display:contents ${ref.trayH}px · position:relative ${relative.trayH}px`
    + ` (inner: ${ref.innerH}px vs ${relative.innerH}px)`
    + ' — if these MATCH, there is no containing-block hazard at all')
  record('F5 …and it collapses inset:0 backdrops the same way',
    relative.bgH !== ref.bgH && relative.bgH === 0,
    `canvas-bg height — display:contents ${ref.bgH}px · position:relative ${relative.bgH}px`)
  // ⚠ AND THE HAZARD IS NARROWER THAN "ANY BOX" — third correction to this
  // claim, measured. `position:absolute; inset:0` establishes a containing
  // block too, but it HAS a definite height (the viewport's), so the tray
  // survives it. A `transform` on an otherwise static div establishes one with
  // height 0 and collapses it, exactly like position:relative. So the precise
  // rule is: a wrapper breaks the chrome when it establishes a containing block
  // AND has no definite height of its own — not merely when it generates a box.
  record('F5b the hazard needs BOTH a containing block and no definite height',
    transformed.trayH === 0 && absolute.trayH === ref.trayH,
    `tray height — contents ${ref.trayH} · position:relative ${relative.trayH}`
    + ` · transform ${transformed.trayH} (both collapse: containing block, height 0)`
    + ` · position:absolute inset:0 ${absolute.trayH} (SAFE: containing block but`
    + ' definite height) — so "any wrapper with a box breaks it" is too strong')
  record('F5c an UNSTYLED div does NOT collapse it — the hazard is specific to '
    + 'wrappers that establish a containing block',
    staticDiv.trayH === ref.trayH,
    `tray height — contents ${ref.trayH} · unstyled div ${staticDiv.trayH}`
    + ' — absolute positioning skips STATIC ancestors, so only a positioned or'
    + ' transformed wrapper becomes the containing block. display:contents is'
    + ' chosen because it is neutral by definition, not because every other'
    + ' shape fails.')
  record('F6 the pin layer is never relocated by any wrapper shape — it is a sibling',
    staticDiv.pin === ref.pin && relative.pin === ref.pin
    && absolute.pin === ref.pin && transformed.pin === ref.pin,
    `contents ${ref.pin} · static ${staticDiv.pin} · rel ${relative.pin}`
    + ` · abs ${absolute.pin} · transform ${transformed.pin}`)
}

document.title = 'done'
window.PROBE = {
  checks,
  pass: checks.filter(c => c.ok).length,
  fail: checks.filter(c => !c.ok).length,
  failed: checks.filter(c => !c.ok).map(c => c.name),
  done: true,
}
