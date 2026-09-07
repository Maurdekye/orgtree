/** w14aace89: the free-space region camera commands aim at when pins cover
 *  part of the viewport (src/canvas/clearRect.ts).
 *
 * The rule under test (user ruling 2026-09-05): pick the SINGLE LARGEST empty
 * rectangle BY AREA, target-independent, ties broken by nearest viewport
 * centre and then a deterministic coordinate order. Pins are clipped to the
 * viewport and grown by a 12px gap; overlapping pins are one union occupancy;
 * separate holes are judged separately, never added or averaged.
 *
 * ⚠ ANTI-VACUITY. The cheap wrong implementation here is `return vp` — it
 * satisfies every "no pins" case for free, and a suite made only of those
 * would be green against a function that does nothing at all. §0 pins that
 * failure down explicitly: it asserts the no-pin identity AND that a covered
 * viewport does NOT come back as the viewport. Every geometry section below
 * asserts an exact rectangle, not merely "smaller than the viewport", so a
 * plausible-but-wrong split is caught rather than rounded off.
 *
 * §0 anti-vacuity: identity when unpinned, and NOT identity when pinned
 * §1 one pin, each edge — the region is the larger side, gap honoured
 * §2 the 12px gap is real, and is applied to the pin not the viewport border
 * §3 area wins, and it is target-independent
 * §4 offscreen and partially offscreen pins (border-independence)
 * §5 overlapping pins are one union, not two obstacles
 * §6 several holes are judged separately — no added area, no averaged centre
 * §7 fully covered -> blocked, so the caller can keep the camera put
 * §8 ties: nearest centre first, then deterministic coordinates
 * §9 fitZoom's own edges
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { clearRegion, fitZoom, obstacleOf, PIN_GAP } from '../src/canvas/clearRect'
import type { Rect } from '../src/canvas/clearRect'

/** A plain 1000x800 viewport at the origin. Deliberately not square, so an
 *  implementation that confuses width and height cannot pass by symmetry. */
const VP: Rect = { x: 0, y: 0, w: 1000, h: 800 }

const R = (x: number, y: number, w: number, h: number): Rect => ({ x, y, w, h })
const areaOf = (r: Rect) => r.w * r.h

test('§0 anti-vacuity: no pins is the identity, and a pin really changes it', () => {
  const none = clearRegion(VP, [])
  assert.deepEqual(none.rect, VP, 'unpinned must be byte-for-byte the viewport')
  assert.equal(none.status, 'full')

  // the same call WITH a pin must not come back as the viewport — this is the
  // assertion that kills `return vp`, which would satisfy the line above.
  const withPin = clearRegion(VP, [R(0, 0, 400, 800)])
  assert.notDeepEqual(withPin.rect, VP,
    'a pin covering the left 400px must not yield the whole viewport')
  assert.equal(withPin.status, 'reduced')
  assert.ok(areaOf(withPin.rect) < areaOf(VP),
    'the chosen region must actually be smaller than the viewport')
})

test('§1 a full-height pin on the left leaves exactly the right-hand strip', () => {
  // pin covers x 0..400; grown by the gap it occupies 0..412. The only empty
  // rectangle is x 412..1000, full height.
  const got = clearRegion(VP, [R(0, 0, 400, 800)])
  assert.deepEqual(got.rect, R(412, 0, 588, 800))
})

test('§1b a full-width pin on the top leaves exactly the lower band', () => {
  const got = clearRegion(VP, [R(0, 0, 1000, 200)])
  assert.deepEqual(got.rect, R(0, 212, 1000, 588))
})

test('§2 the gap is taken from the pin, never from the viewport border', () => {
  // a pin flush in the top-left: the region below it must start at 200+12,
  // and must still begin at x=0 — the viewport edge keeps no gap of its own.
  const got = clearRegion(VP, [R(0, 0, 300, 200)])
  // candidates: below the pin (1000 x 588) vs right of it (688 x 800).
  // areas 588000 vs 550400 -> the band below wins.
  assert.deepEqual(got.rect, R(0, 212, 1000, 588))
  assert.equal(got.rect.x, 0, 'no gap is inserted at the viewport border')

  const ob = obstacleOf(R(0, 0, 300, 200), VP)
  assert.deepEqual(ob, R(0, 0, 312, 212),
    'the obstacle grows right/down into the viewport but not past its edges')
  assert.equal(PIN_GAP, 12)
})

test('§3 area decides, and the SAME region is returned regardless of target', () => {
  // left pin 0..300 (->312), so: right strip 688x800 = 550400,
  // and nothing else larger. Target plays no part in the call at all.
  const got = clearRegion(VP, [R(0, 0, 300, 800)])
  assert.deepEqual(got.rect, R(312, 0, 688, 800))

  // ONE region serves all three camera commands. The agent card, the
  // switchboard and the whole-org bbox are wildly different shapes; under the
  // superseded target-dependent design they would have selected different
  // regions. Here they must all be handed the identical rectangle, and only
  // the zoom that is fitted INSIDE it may differ.
  const agent = fitZoom(got.rect, 124, 124, 48)
  const switchboard = fitZoom(got.rect, 124, 124, 48)
  const wholeOrg = fitZoom(got.rect, 3000, 2000, 48)
  assert.ok(agent > wholeOrg, 'the fitted zooms genuinely differ per target…')
  assert.equal(agent, switchboard)
  // …while the region they were fitted into came from a single call that was
  // never told what any of them were.
  assert.deepEqual(clearRegion(VP, [R(0, 0, 300, 800)]).rect, got.rect)
})

test('§4 a fully offscreen pin obstructs nothing', () => {
  assert.equal(obstacleOf(R(2000, 2000, 300, 200), VP), null)
  assert.equal(obstacleOf(R(-500, 0, 300, 200), VP), null, 'entirely left of vp')
  const got = clearRegion(VP, [R(2000, 2000, 300, 200)])
  assert.deepEqual(got.rect, VP)
  assert.equal(got.status, 'full')
})

test('§4b a pin flush against the viewport edge covers nothing', () => {
  // right edge exactly at vp.x: zero visible width, so not an obstacle
  assert.equal(obstacleOf(R(-300, 0, 300, 800), VP), null)
})

test('§4c border-independence: half-offscreen behaves as its visible part', () => {
  // a pin hanging 200px off the left shows x 0..100 -> obstacle 0..112
  const half = clearRegion(VP, [R(-200, 0, 300, 800)])
  const flush = clearRegion(VP, [R(0, 0, 100, 800)])
  assert.deepEqual(half.rect, flush.rect,
    'only the visible part of a pin may influence the region')
  assert.deepEqual(half.rect, R(112, 0, 888, 800))
})

test('§5 overlapping pins form ONE union occupancy, not two obstacles', () => {
  // two heavily overlapping pins spanning 0..500 together, full height.
  const overlapped = clearRegion(VP, [R(0, 0, 300, 800), R(200, 0, 300, 800)])
  // the union occupies 0..500, grown to 0..512
  assert.deepEqual(overlapped.rect, R(512, 0, 488, 800))
  // and one pin covering the identical span must give the identical answer
  const single = clearRegion(VP, [R(0, 0, 500, 800)])
  assert.deepEqual(overlapped.rect, single.rect,
    'union occupancy: overlap must not be counted twice')
})

test('§6 separate holes are judged separately — areas are never added', () => {
  // one vertical pin down the middle splits the viewport into two holes.
  // left hole x 0..394 (pin 394..606 grown), right hole x 618..1000.
  // left = 394*800 = 315200 ; right = 382*800 = 305600 -> LEFT wins on area.
  const got = clearRegion(VP, [R(406, 0, 188, 800)])
  assert.deepEqual(got.rect, R(0, 0, 394, 800))
  assert.ok(areaOf(got.rect) < areaOf(VP),
    'the two holes must not be summed into something viewport-sized')
  // and the winner is a single real rectangle, not a centre averaged between
  // the two holes (which would sit near x=500, inside the pin)
  const centre = got.rect.x + got.rect.w / 2
  assert.ok(centre < 406, 'the chosen centre lies in a real hole, not in the pin')
})

test('§7 a viewport entirely covered reports blocked, and yields no rectangle', () => {
  const got = clearRegion(VP, [R(0, 0, 1000, 800)])
  assert.equal(got.status, 'blocked')
  assert.equal(areaOf(got.rect), 0)
})

test('§7b covered by several pins together is still blocked', () => {
  const got = clearRegion(VP, [R(0, 0, 500, 800), R(500, 0, 500, 800)])
  assert.equal(got.status, 'blocked')
})

test('§8 an exact tie breaks toward the viewport centre', () => {
  // symmetric pins at both ends leave one central hole plus nothing else;
  // make two equal holes instead: pins at far left and far right edges of
  // equal size leave a single centre hole -> unambiguous.
  const got = clearRegion(VP, [R(0, 0, 200, 800), R(800, 0, 200, 800)])
  assert.deepEqual(got.rect, R(212, 0, 576, 800))
  const c = got.rect.x + got.rect.w / 2
  assert.equal(c, 500, 'the surviving hole is centred in the viewport')
})

test('§8b equal-area, equal-drift holes resolve deterministically and stably', () => {
  // a perfectly central vertical pin leaves two mirror-image holes of equal
  // area and equal centre drift. The result must be stable across calls and
  // independent of pin order, not whichever the loop happened to reach.
  const pin = [R(400, 0, 200, 800)]
  const a = clearRegion(VP, pin)
  const b = clearRegion(VP, pin)
  assert.deepEqual(a.rect, b.rect, 'repeated calls agree')
  // left hole 0..388, right hole 612..1000: both 388 wide. Coordinate order
  // resolves to the smaller x.
  assert.deepEqual(a.rect, R(0, 0, 388, 800))
  const reversed = clearRegion(VP, [...pin].reverse())
  assert.deepEqual(reversed.rect, a.rect, 'pin ordering must not change the answer')
})

test('§9 fitZoom refuses to report a fit that does not exist', () => {
  assert.equal(fitZoom(R(0, 0, 100, 100), 0, 10, 0), 0, 'zero-width content')
  assert.equal(fitZoom(R(0, 0, 40, 40), 10, 10, 48), 0,
    'a region smaller than the margin fits nothing — and must not go negative')
  assert.equal(fitZoom(R(0, 0, 248, 148), 100, 100, 48), 1,
    'the tighter of the two axes decides')
  assert.equal(fitZoom(R(0, 0, 1048, 148), 100, 100, 48), 1, 'height-limited')
})

test('§9b a degenerate viewport is blocked rather than crashing', () => {
  assert.equal(clearRegion({ x: 0, y: 0, w: 0, h: 0 }, []).status, 'blocked')
})
