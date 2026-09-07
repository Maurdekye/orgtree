// edgejump.test.ts — the coworker jump cards must not cover the focused desk.
//
// user bug 2026-08-26: at desk zoom the edge jump cards sat at a fixed 6px from
// the window edge and could be 180px wide. A focus glide fits the SQUARE card
// to min(vw, vh) − 48 centred, so the strip beside the desk is exactly 24px on
// any window taller than it is wide — and coworkers share a layout row, so the
// card's elevation lands mid-screen, over the chat text rather than a corner.
//
// ⚠ WHY THIS FILE ASSERTS ON NUMBERS AND NOT ON THE DOM. jsdom implements no
// CSS box model: every getBoundingClientRect() it returns is zeroes. An
// "these two boxes do not overlap" assertion written against jsdom passes on a
// blank page for exactly the same reason it passes here, which makes it an
// abstention wearing a pass's clothes. So we test edgeJumpPlacement() — the
// pure function that decides the form and the y — and reason about the box it
// implies from the width each form is pinned to in styles.css.
//
// ⚠ AND WHY THE CONTROL AT THE BOTTOM IS NOT OPTIONAL. `overlaps()` returning
// false proves nothing on its own; it would also return false if the geometry
// were nonsense. The last test runs the OLD placement — fixed 6px, full width,
// at the neighbour's elevation — through the same predicate and REQUIRES it to
// report an overlap. If that test ever goes green-by-passing, the predicate
// has stopped being able to see anything and every check above it is vacuous.

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  EJ_EDGE, EJ_FULL, EJ_GAP, EJ_H, EJ_MID, edgeJumpPlacement, NODE_H, Z_DESK,
  type EJForm, type EJRect,
} from '../src/canvas/shared'
import { clearRegion } from '../src/canvas/clearRect'

// The widths each form is pinned to by styles.css. `tab` is the
// max-width: 22px on `.edge-jump.ej-tab:not(:hover)`; `mid` drops the name and
// is bounded by EJ_MID; `full` is the .edge-jump max-width.
const WIDTH: Record<EJForm, number> = { full: EJ_FULL, mid: EJ_MID, tab: 22 }

type Reg = { x: number; y: number; w: number; h: number }
const whole = (vw: number, vh: number): Reg => ({ x: 0, y: 0, w: vw, h: vh })

// the desk a focus glide produces: square, side min(rw,rh) − 48, centred IN
// THE FREE REGION — this is centerOn()'s fit, restated so the fixtures are the
// real geometry rather than numbers picked to make the test pass.
function deskIn(r: Reg): EJRect {
  const side = Math.max(Z_DESK * NODE_H, Math.min(r.w, r.h) - 48)
  return {
    x0: r.x + (r.w - side) / 2, x1: r.x + (r.w + side) / 2,
    y0: r.y + (r.h - side) / 2, y1: r.y + (r.h + side) / 2,
  }
}
const deskFor = (vw: number, vh: number): EJRect => deskIn(whole(vw, vh))

// the box the card actually occupies, from the placement's own `inset` plus
// its form's width. ⚠ THE INSET COMES FROM THE PLACEMENT, not from EJ_EDGE:
// reading the constant here instead would hard-code the screen-hugging
// position and every region assertion below would be measuring the old
// behaviour while claiming to measure the new one.
function boxOf(
  side: 'l' | 'r', put: { form: EJForm; y: number; inset: number }, vw: number,
) {
  const w = WIDTH[put.form]
  return {
    x0: side === 'l' ? put.inset : vw - put.inset - w,
    x1: side === 'l' ? put.inset + w : vw - put.inset,
    y0: put.y - EJ_H / 2, y1: put.y + EJ_H / 2,
  }
}

const overlaps = (a: EJRect, b: EJRect) =>
  a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0

// every window shape worth caring about, including the two the probe next door
// measures at and the near-square case that is tight on both axes
const SHAPES: [string, number, number][] = [
  ['wide desktop', 1440, 860],
  ['modest landscape', 1280, 1000],
  ['near square', 900, 860],
  ['narrow', 700, 900],
  ['tall phone-ish', 520, 900],
  ['very narrow', 380, 900],
]

test('§1 no jump card overlaps the focused desk, at any window shape', () => {
  for (const [name, vw, vh] of SHAPES) {
    const desk = deskFor(vw, vh)
    const vp = { width: vw, height: vh }
    for (const side of ['l', 'r'] as const) {
      // the worst case: a coworker on the same layout row, so the card's
      // natural elevation is dead centre — straight over the chat text
      const put = edgeJumpPlacement(side, desk, vp, (desk.y0 + desk.y1) / 2,
        whole(vw, vh))
      const box = boxOf(side, put, vw)
      assert.equal(overlaps(box, desk), false,
        `${name} ${vw}x${vh} side=${side}: ${put.form} card `
        + `[${box.x0},${box.x1}]x[${box.y0},${box.y1}] covers the desk `
        + `[${desk.x0},${desk.x1}]x[${desk.y0},${desk.y1}]`)
    }
  }
})

test('§2 a card is always inside the viewport — degraded, never dropped', () => {
  for (const [name, vw, vh] of SHAPES) {
    const desk = deskFor(vw, vh)
    for (const side of ['l', 'r'] as const) {
      const put = edgeJumpPlacement(side, desk, { width: vw, height: vh },
        (desk.y0 + desk.y1) / 2, whole(vw, vh))
      const box = boxOf(side, put, vw)
      assert.ok(box.y0 >= 0 && box.y1 <= vh,
        `${name}: card escaped the viewport vertically (${box.y0}..${box.y1})`)
      assert.ok(box.x0 >= 0 && box.x1 <= vw,
        `${name}: card escaped the viewport horizontally (${box.x0}..${box.x1})`)
    }
  }
})

test('§3 the form matches the room actually available', () => {
  const vp = (w: number, h: number) => ({ width: w, height: h })
  // wide: the gutter takes a full named card, at the coworker's own elevation
  let d = deskFor(1440, 860)
  let put = edgeJumpPlacement('l', d, vp(1440, 860), 430, whole(1440, 860))
  assert.equal(put.form, 'full')
  assert.equal(put.band, false)
  assert.equal(put.y, 430, 'a card with room stays at the neighbour elevation')

  // narrow: gutter is 24px, but the band above/below is deep — keep the NAME
  // by moving into the band rather than shedding down to a tab
  d = deskFor(700, 900)
  put = edgeJumpPlacement('l', d, vp(700, 900), 450, whole(700, 900))
  assert.equal(put.form, 'full')
  assert.equal(put.band, true)
  assert.ok(put.y + EJ_H / 2 <= d.y0,
    `band card (y=${put.y}) must sit clear above the desk top (${d.y0})`)

  // near square: thin gutter AND shallow band — the one shape with nowhere to
  // go, which is what the tab form exists for
  d = deskFor(900, 860)
  put = edgeJumpPlacement('l', d, vp(900, 860), 430, whole(900, 860))
  assert.equal(put.form, 'tab')
  assert.equal(put.band, false)

  // a gutter between the two thresholds sheds only the name
  d = deskFor(1280, 1000)
  put = edgeJumpPlacement('l', d, vp(1280, 1000), 500, whole(1280, 1000))
  assert.equal(put.form, 'mid')
})

test('§4 the Z_DESK floor case: desk overflows, gutter is negative', () => {
  // centerOn floors the focus zoom at Z_DESK so a focus gesture always opens a
  // desk, which means on a very small window the desk overflows the viewport
  // and there is NO gutter at all. The tab is the only form that fits in the
  // desk's own padding, so it must be what we choose — and it must still be
  // chosen rather than the code falling over on negative numbers.
  const vw = 260, vh = 260
  const desk = deskFor(vw, vh)
  assert.ok(desk.x0 < 0, 'fixture must actually overflow, else §4 proves nothing')
  for (const side of ['l', 'r'] as const) {
    const put = edgeJumpPlacement(side, desk, { width: vw, height: vh }, 130,
      whole(vw, vh))
    assert.equal(put.form, 'tab')
    assert.ok(Number.isFinite(put.y), 'y must stay a real number')
  }
})

test('§5 the gutter threshold is honoured exactly at the boundary', () => {
  // A TALL desk, so the band above/below is only 5px and the band branch is
  // genuinely unavailable. Without this the test proves nothing about the
  // gutter: a shallow desk leaves a deep band, the band branch fires, and the
  // card legitimately keeps its full form for a reason unrelated to the
  // threshold under test. (That is precisely what this test caught on its
  // first run — the assertion was wrong, not the code.)
  const vh = 1000
  const want = EJ_EDGE + EJ_FULL + EJ_GAP
  const vp = { width: want + 900, height: vh }
  const wholeVp = whole(vp.width, vp.height)
  const tall = (x0: number): EJRect =>
    ({ x0, x1: x0 + 400, y0: 5, y1: vh - 5 })

  const at = tall(want)
  assert.equal(Math.max(at.y0, vh - at.y1) < EJ_H + EJ_GAP, true,
    'fixture must leave no usable band, else this tests the wrong branch')
  assert.equal(edgeJumpPlacement('l', at, vp, 500, wholeVp).form, 'full')

  // one pixel less and it must step down rather than cover the desk
  const put = edgeJumpPlacement('l', tall(want - 1), vp, 500, wholeVp)
  assert.equal(put.form, 'mid',
    'a gutter one pixel under the threshold must shed the name')
  assert.equal(overlaps(boxOf('l', put, vp.width), tall(want - 1)), false)

  // and the mid → tab boundary, same isolation
  const midEdge = EJ_EDGE + EJ_MID + EJ_GAP
  assert.equal(edgeJumpPlacement('l', tall(midEdge), vp, 500, wholeVp).form, 'mid')
  assert.equal(edgeJumpPlacement('l', tall(midEdge - 1), vp, 500, wholeVp).form,
    'tab')
})

// ---------------------------------------------------------------------------
// THE CONTROL. Everything above asserts that overlaps() reports false. That is
// only worth something if overlaps() is capable of reporting true on this
// geometry — so here is the pre-fix placement, run through the identical
// predicate, REQUIRED to fail. If this test ever passes by finding no overlap,
// the checks above have stopped measuring and are reporting success by never
// really running.
test('§6 CONTROL — the old fixed placement DOES overlap, as it must', () => {
  const offenders: string[] = []
  for (const [name, vw, vh] of SHAPES) {
    const desk = deskFor(vw, vh)
    for (const side of ['l', 'r'] as const) {
      // the old code: always full width, always at the neighbour's elevation
      const old = boxOf(side,
        { form: 'full', y: (desk.y0 + desk.y1) / 2, inset: EJ_EDGE }, vw)
      if (overlaps(old, desk)) offenders.push(`${name}/${side}`)
    }
  }
  assert.ok(offenders.length > 0,
    'CONTROL BROKEN: the pre-fix placement overlapped nothing, so the '
    + 'no-overlap assertions above prove nothing about the fix')
  // and specifically at the shape the user reported it on
  const narrow = deskFor(700, 900)
  const oldNarrow = boxOf('l', { form: 'full', y: 450, inset: EJ_EDGE }, 700)
  assert.equal(overlaps(oldNarrow, narrow), true,
    'CONTROL BROKEN: the reported narrow-window case did not reproduce')
})

// ---------------------------------------------------------------------------
// user bug 2026-09-05: WITH A PIN DOCKED ON AN EDGE, THE CARD ON THAT EDGE WAS
// GONE. Pins paint in z-index band 10–16 and a jump card is 7, so a card 6px
// from the window edge under a docked pin is not crowded — it is covered.
// Placement now measures against the clear region (clearRect.ts), the same one
// the camera fits the desk into.

const PIN_GAP = 12   // clearRect.PIN_GAP, restated so a drift shows up here

/** the raw pin rectangles, NOT the gap-grown obstacles: what the reader
 *  actually sees painted over the canvas, which is what a card must clear. */
type Pin = { x: number; y: number; w: number; h: number }
const hits = (b: EJRect, p: Pin) =>
  b.x0 < p.x + p.w && b.x1 > p.x && b.y0 < p.y + p.h && b.y1 > p.y

// a tall pin down the LEFT and a squat one at the BOTTOM-RIGHT: both sides
// obstructed, asymmetrically, which is the shape that catches a fix applied to
// one side only or to a symmetric inset.
const VW = 1280, VH = 900
const PINS: Pin[] = [
  { x: 0, y: 0, w: 360, h: VH },
  { x: VW - 420, y: VH - 300, w: 420, h: 300 },
]

test('§7 IDENTITY — region = viewport is the old placement, term for term', () => {
  // The region argument is required precisely so that nobody gets the old
  // behaviour by accident; this pins down that passing the viewport IS the old
  // behaviour, so the unpinned canvas is provably unchanged rather than
  // unchanged-looking.
  for (const [, vw, vh] of SHAPES) {
    const desk = deskFor(vw, vh)
    for (const side of ['l', 'r'] as const) {
      const put = edgeJumpPlacement(side, desk, { width: vw, height: vh },
        (desk.y0 + desk.y1) / 2, whole(vw, vh))
      assert.equal(put.inset, EJ_EDGE,
        `unpinned, the card must sit at the styles.css 6px inset (${side})`)
    }
  }
})

test('§8 a card clears every pin and stays inside the free region', () => {
  const reg = clearRegion({ x: 0, y: 0, w: VW, h: VH }, PINS)
  assert.equal(reg.status, 'reduced',
    'fixture must actually reduce the region, else §8 is vacuous')
  const r = reg.rect
  // the desk the camera puts in that region — the same fit centerOn performs
  const desk = deskIn(r)
  for (const side of ['l', 'r'] as const) {
    const put = edgeJumpPlacement(side, desk, { width: VW, height: VH },
      (desk.y0 + desk.y1) / 2, r)
    const box = boxOf(side, put, VW)
    for (const [i, pin] of PINS.entries()) {
      assert.equal(hits(box, pin), false,
        `side=${side}: the ${put.form} card [${box.x0},${box.x1}]x`
        + `[${box.y0},${box.y1}] is underneath pin ${i} `
        + `[${pin.x},${pin.x + pin.w}]x[${pin.y},${pin.y + pin.h}]`)
    }
    assert.ok(box.x0 >= r.x - 0.001 && box.x1 <= r.x + r.w + 0.001,
      `side=${side}: card [${box.x0},${box.x1}] escaped the free region `
      + `[${r.x},${r.x + r.w}]`)
    assert.ok(box.y0 >= r.y - 0.001 && box.y1 <= r.y + r.h + 0.001,
      `side=${side}: card [${box.y0},${box.y1}] escaped the free region `
      + `vertically [${r.y},${r.y + r.h}]`)
    assert.equal(overlaps(box, desk), false,
      `side=${side}: the card still covers the desk it sits beside`)
  }
})

test('§9 the left card moves off the window edge by the left pin width', () => {
  // Not a restatement of §8: this says the card MOVED, and by how much. A fix
  // that clamped cards into the region without shifting the inset would pass a
  // no-overlap check on the right-hand side alone.
  const r = clearRegion({ x: 0, y: 0, w: VW, h: VH }, PINS).rect
  const desk = deskIn(r)
  const put = edgeJumpPlacement('l', desk, { width: VW, height: VH },
    (desk.y0 + desk.y1) / 2, r)
  assert.ok(put.inset >= 360 + PIN_GAP,
    `the left card is inset ${put.inset}px from the window, but the left pin `
    + `plus its ${PIN_GAP}px gap occupies the first ${360 + PIN_GAP}px`)
})

// ---------------------------------------------------------------------------
// THE CONTROL FOR §8/§9. `hits()` reporting false proves nothing until it is
// shown to report true on this exact geometry. Here is the SHIPPED-BEFORE
// placement — the same call with the whole viewport as its region, which §7
// establishes is the old code — run through the identical predicate and
// REQUIRED to land under the pin. If this ever stops finding an overlap, §8
// has stopped being a check.
test('§10 CONTROL — screen-edge placement DOES vanish under the pin', () => {
  const desk = deskIn(clearRegion({ x: 0, y: 0, w: VW, h: VH }, PINS).rect)
  const old = edgeJumpPlacement('l', desk, { width: VW, height: VH },
    (desk.y0 + desk.y1) / 2, whole(VW, VH))
  const box = boxOf('l', old, VW)
  assert.equal(box.x0, EJ_EDGE, 'the control must be the screen-hugging card')
  assert.equal(hits(box, PINS[0]!), true,
    'CONTROL BROKEN: the pre-fix card did NOT land under the left pin, so §8 '
    + 'proves nothing about the fix')
})
