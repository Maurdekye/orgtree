// foldghost.test.tsx — A COLLAPSING SUBTREE ANIMATES INTO ITS STACK
// (USER 2026-11-03 18:22:52Z mf5c66ee4352a; clarified m869529f98deb: expand already animates, only COLLAPSE
// needs it, mirroring expand: same springs, same constants, the reverse path).
//
// Run:  node apps/desktop/renderer/tests/run.mjs foldghost
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join as joinPath } from 'node:path'
import { advanceSprings, ghostAim, nextGhosts, springAtRest, stepSpring } from '../src/canvas/foldghost'
import type { SpringState } from '../src/canvas/foldghost'

declare const __SRC_DIR__: string
const none = new Map<string, string>()
const seen = () => true

test('a newly folded member becomes a ghost heading for its collapsed node; one already hidden does not', () => {
  const g = nextGhosts(new Map([['old', 'root']]), new Map([['old', 'root'], ['a', 'root'], ['b', 'root']]), none, { reduced: false, seen })
  assert.deepEqual([...g.entries()].sort(), [['a', 'root'], ['b', 'root']])
  assert.equal(nextGhosts(none, new Map([['a', 'root']]), none, { reduced: false, seen: id => id !== 'a' }).size, 0, 'never on screen: nothing to animate')
})

test('with reduced motion a collapse is instant: no ghosts', () => {
  assert.equal(nextGhosts(none, new Map([['a', 'root']]), none, { reduced: true, seen }).size, 0)
})

test('a collapse moves through positions strictly between the start and the stack, then rests there', () => {
  const stack = ghostAim({ x: 100, y: 100 })
  const s: SpringState = { x: 300, y: 400, vx: 0, vy: 0 }
  const startDist = Math.hypot(s.x - stack.x, s.y - stack.y)
  let mid = 0, frames = 0
  while (!springAtRest(s, stack) && frames < 600) {
    stepSpring(s, stack, 1 / 60); frames++
    const d = Math.hypot(s.x - stack.x, s.y - stack.y)
    if (d > 2 && d < startDist - 2) mid++
  }
  assert.ok(mid >= 10, 'visible intermediate frames, not a jump: ' + mid)
  assert.ok(frames > 15 && frames < 120, 'about the expand glide\'s length (' + frames + ' frames)')
  assert.ok(springAtRest(s, stack))
})

test('an interrupted collapse (expand mid-way) keeps the ghost\'s spring and continues from the current position', () => {
  const stack = ghostAim({ x: 100, y: 100 })
  const s: SpringState = { x: 300, y: 400, vx: 0, vy: 0 }
  for (let i = 0; i < 12; i++) stepSpring(s, stack, 1 / 60)
  const at = { x: s.x, y: s.y }
  const g = nextGhosts(new Map([['a', 'root']]), none, new Map([['a', 'root']]), { reduced: false, seen })
  assert.equal(g.size, 0, 'shown again: no longer a ghost, its spring is kept as a normal node\'s')
  const layout = { x: 300, y: 400 }
  stepSpring(s, layout, 1 / 60)
  assert.ok(Math.hypot(s.x - at.x, s.y - at.y) < 12, 'no jump: the next frame starts from where it was')
  // and the reverse: collapse during an expand starts from the in-flight position the same way
  assert.deepEqual([...nextGhosts(none, new Map([['a', 'root']]), none, { reduced: false, seen }).keys()], ['a'])
})

test('OrgCanvas keeps ghosts drawn and their springs alive until every one is at rest', () => {
  const src = readFileSync(joinPath(__SRC_DIR__, 'canvas/OrgCanvas.tsx'), 'utf8')
  assert.match(src, /nextGhosts\(/)
  assert.match(src, /advanceSprings\(/, 'the engine frame is the shared pure function the tests run')
  assert.match(src, /prefers-reduced-motion/)
  assert.match(src, /foldGhosts\.current\.has\(/, 'the reaper and the card/wire filters know ghosts')
})

test('THE ENGINE FRAME: a ghost the layout still lists at its parent springs to the stack only, rests there and is removed (build-sol R5: it used to stall 4px short)', () => {
  // canvaslayout.ts keeps every folded-away member in the target map, at its parent's position: exactly this input
  const parent = { x: 147.4, y: 367 }
  const targets = new Map([['parent', parent], ['a1', { ...parent }], ['a2', { ...parent }], ['stay', { x: 400, y: 200 }]])
  const springs = new Map([
    ['parent', { ...parent, vx: 0, vy: 0 }], ['a1', { x: 300, y: 500, vx: 0, vy: 0 }], ['a2', { x: 320, y: 520, vx: 0, vy: 0 }],
    ['stay', { x: 380, y: 190, vx: 0, vy: 0 }]])
  const ghosts = new Map([['a1', 'parent'], ['a2', 'parent']])
  const aim = ghostAim(parent)
  let frames = 0, sawMiddle = false
  const birth = (_id: string, t: { x: number; y: number }) => ({ x: t.x, y: t.y, vx: 0, vy: 0 })
  for (; frames < 600 && ghosts.size; frames++) {
    advanceSprings({ targets: targets, springs, ghosts, dt: 1 / 60, birth })
    const a = springs.get('a1')
    if (a && Math.hypot(a.x - 300, a.y - 500) > 5 && Math.hypot(a.x - aim.x, a.y - aim.y) > 5) sawMiddle = true
  }
  assert.equal(ghosts.size, 0, 'every ghost was removed once at rest (it stalled at the midpoint of two targets before)')
  assert.ok(frames < 200, 'in about the expand glide time: ' + frames)
  assert.ok(sawMiddle, 'and it was seen between its start and the stack')
  assert.equal(springs.has('a1'), false, 'its spring goes with it')
  advanceSprings({ targets, springs, ghosts, dt: 1 / 60, birth })
  for (let i = 0; i < 300; i++) advanceSprings({ targets, springs, ghosts, dt: 1 / 60, birth })
  const stay = springs.get('stay')!
  assert.ok(Math.abs(stay.x - 400) < 0.5 && Math.abs(stay.y - 200) < 0.5, 'an ordinary node still reaches its layout target')
})
