// circularlayout.test.ts — org chart circular arrangement (user 2026-09-30).
// Run:  cd apps/desktop/renderer && node tests/run.mjs circularlayout
declare const __SRC_DIR__: string
import { inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { chartLayoutOf, layout, NODE_H, NODE_W, peerOrder, ringInsertSide, setChartLayout, USER, DRAFT, withDraftTree } from '../src/canvas/shared'
import type { CanvasNode } from '../src/canvas/shared'
import { ChartLayoutSetting } from '../src/canvas/accounts'

const node = (id: string, children: CanvasNode[] = []): CanvasNode =>
  ({ id, title: id, tier: 't', state: 'live', children } as unknown as CanvasNode)
const eye = (kids: CanvasNode[]): CanvasNode =>
  ({ id: USER, title: 'you', tier: null, state: 'user', children: kids } as CanvasNode)
const tree = (fan: number, depth: number, pre = 'n'): CanvasNode[] =>
  depth === 0 ? [] : Array.from({ length: fan }, (_, i) => node(`${pre}${i}`, tree(fan, depth - 1, `${pre}${i}.`)))
const centre = (p: { x: number; y: number }) => ({ x: p.x + NODE_W / 2, y: p.y + NODE_H / 2 })
const overlaps = (t: Map<string, { x: number; y: number }>) => {
  const ps = [...t.values()].sort((a, b) => a.x - b.x)
  for (let i = 0; i < ps.length; i++)
    for (let j = i + 1; j < ps.length && ps[j]!.x - ps[i]!.x < NODE_W; j++)
      if (Math.abs(ps[j]!.y - ps[i]!.y) < NODE_H) return true
  return false
}

test('row is the default and the setting round-trips', () => {
  localStorage.removeItem('orgtree-chart-layout')
  assert.equal(chartLayoutOf(), 'row')
  setChartLayout('circular'); assert.equal(chartLayoutOf(), 'circular')
  setChartLayout('row'); assert.equal(chartLayoutOf(), 'row')
})

test('row mode is unchanged: circular is only used when asked', () => {
  const root = eye(tree(3, 2))
  assert.deepEqual([...layout(root)], [...layout(root, new Map(), 'row')])
  assert.notDeepEqual([...layout(root)], [...layout(root, new Map(), 'circular')])
})

test('eye at centre, depths on increasing rings, every agent placed', () => {
  const root = eye(tree(4, 3))
  const t = layout(root, new Map(), 'circular')
  assert.equal(t.size, 1 + 4 + 16 + 64)
  const c = centre(t.get(USER)!)
  const rad = (id: string) => Math.hypot(centre(t.get(id)!).x - c.x, centre(t.get(id)!).y - c.y)
  for (let i = 0; i < 4; i++) assert.ok(Math.abs(rad(`n${i}`) - rad('n0')) < 1e-6)
  assert.ok(rad('n0.0') > rad('n0') && rad('n0.0.0') > rad('n0.0'))
  assert.equal(overlaps(t), false)
})

const ringAngles = (t: Map<string, { x: number; y: number }>, ids: string[]) => {
  const c = centre(t.get(USER)!)
  return ids.map(id => Math.atan2(centre(t.get(id)!).y - c.y, centre(t.get(id)!).x - c.x))
}
const ringRadius = (t: Map<string, { x: number; y: number }>, id: string) => {
  const c = centre(t.get(USER)!), p = centre(t.get(id)!)
  return Math.hypot(p.x - c.x, p.y - c.y)
}
const flat = (n: number, pre = 'k') => Array.from({ length: n }, (_, i) => node(`${pre}${i}`))
const chord = (t: Map<string, { x: number; y: number }>, a: string, b: string) => {
  const p = centre(t.get(a)!), q = centre(t.get(b)!)
  return Math.hypot(p.x - q.x, p.y - q.y)
}

test('a sparse ring packs its agents at the dense spacing in one arc centred at the bottom', () => {
  for (const n of [1, 2, 3, 4]) {
    const t = layout(eye(flat(n)), new Map(), 'circular')
    const ids = Array.from({ length: n }, (_, i) => `k${i}`)
    const ang = ringAngles(t, ids)
    const mean = ang.reduce((x, y) => x + y, 0) / n
    assert.ok(Math.abs(mean - Math.PI / 2) < 1e-9, `n=${n}: arc is centred at the bottom`)
    for (const id of ids) assert.ok(Math.abs(ringRadius(t, id) - ringRadius(t, 'k0')) < 1e-6)
    for (let i = 1; i < n; i++) {
      assert.ok(centre(t.get(`k${i}`)!).x > centre(t.get(`k${i - 1}`)!).x, 'ring order reads left to right')
      assert.ok(Math.abs(chord(t, `k${i - 1}`, `k${i}`) - 190) < 1e-6, `n=${n}: neighbours sit one dense pitch apart`)
    }
    assert.ok(ang.every(a => a > 0 && a < Math.PI), 'a short arc stays on the lower half')
    assert.equal(overlaps(t), false)
  }
})

test('the arc grows until it closes at the top, then the ring grows in radius as before', () => {
  const r1 = ringRadius(layout(eye(flat(1)), new Map(), 'circular'), 'k0')
  let cap = 0
  for (let n = 1; n < 40; n++) {
    const t = layout(eye(flat(n)), new Map(), 'circular')
    if (Math.abs(ringRadius(t, 'k0') - r1) > 1e-6) { cap = n - 1; break }
  }
  assert.ok(cap > 4, `the first ring fills at ${cap}`)
  const full = layout(eye(flat(cap)), new Map(), 'circular')
  const gapAtTop = chord(full, 'k0', `k${cap - 1}`)
  assert.ok(gapAtTop >= 190 - 1e-6 && gapAtTop < 190 * 1.6, `the two ends meet near the top at about one pitch (${gapAtTop})`)
  const after = layout(eye(flat(cap + 1)), new Map(), 'circular')
  assert.ok(ringRadius(after, 'k0') > r1 + 1, 'past full the radius grows')
  assert.equal(overlaps(after), false)
})

const signedAngle = (a: number) => Math.atan2(Math.sin(a), Math.cos(a))
const relativeAngles = (t: Map<string, { x: number; y: number }>, parent: string, ids: string[]) => {
  const origin = ringAngles(t, [parent])[0]!
  return ringAngles(t, ids).map(a => signedAngle(a - origin))
}
test('a superior at the top has a centred sibling arc at every depth, including across the angle seam', () => {
  for (const index of [0, 3, 6, 11]) {
    const roots = flat(12)
    roots[index]!.children = [node('a', [node('grand', [node('great')])]), node('b'), node('c')]
    const t = layout(eye(roots), new Map(), 'circular')
    const deltas = relativeAngles(t, `k${index}`, ['a', 'b', 'c'])
    assert.ok(Math.abs(deltas.reduce((a, b) => a + b, 0)) < 1e-9, `parent ${index}: centred`)
    assert.ok(deltas[0]! > deltas[1]! && deltas[1]! > deltas[2]!, 'counterclockwise tree order')
    assert.ok(Math.abs(chord(t, 'a', 'b') - 190) < 1e-6)
    assert.ok(Math.abs(relativeAngles(t, 'a', ['grand'])[0]!) < 1e-9)
    assert.ok(Math.abs(relativeAngles(t, 'grand', ['great'])[0]!) < 1e-9)
    if (index === 0) assert.ok(centre(t.get('b')!).y < 0, 'top parent keeps reports at the top')
    assert.equal(overlaps(t), false)
  }
})

test('colliding neighbouring teams move equally in opposite directions only as far as needed', () => {
  const t = layout(eye([node('a', flat(4, 'a')), node('b', flat(4, 'b'))]), new Map(), 'circular')
  const shiftA = relativeAngles(t, 'a', ['a0', 'a3']).reduce((a, b) => a + b, 0) / 2
  const shiftB = relativeAngles(t, 'b', ['b0', 'b3']).reduce((a, b) => a + b, 0) / 2
  assert.ok(shiftA > 0 && shiftB < 0)
  assert.ok(Math.abs(shiftA + shiftB) < 1e-9, 'equal displacement shares the collision')
  assert.ok(Math.abs(chord(t, 'a3', 'b0') - 190) < 1e-6, 'arcs touch at one neighbour pitch')
  assert.equal(overlaps(t), false)
})

test('a remote noncolliding team and ancestors stay fixed when another team gains reports', () => {
  const roots = flat(12)
  roots[0]!.children = flat(1, 'a')
  roots[6]!.children = flat(2, 'b')
  const before = layout(eye(roots), new Map(), 'circular')
  roots[0]!.children = flat(4, 'a')
  const after = layout(eye(roots), new Map(), 'circular')
  for (const id of [...roots.map(n => n.id), 'b0', 'b1']) {
    assert.ok(chord(new Map([['before', before.get(id)!], ['after', after.get(id)!]]), 'before', 'after') < 1e-8, id)
  }
  assert.ok(Math.abs(relativeAngles(after, 'k6', ['b0', 'b1']).reduce((a, b) => a + b, 0)) < 1e-9)
})

test('full levels spread evenly in sibling order even for unequal teams', () => {
  const roots = [node('a', flat(31, 'a')), node('b', flat(7, 'b')), node('c', flat(19, 'c'))]
  const t = layout(eye(roots), new Map(), 'circular')
  const ids = roots.flatMap(p => p.children.map(c => c.id)), angles = ringAngles(t, ids)
  for (let i = 0; i < ids.length; i++) {
    const next = (i + 1) % ids.length
    assert.ok(Math.abs(chord(t, ids[i]!, ids[next]!) - 190) < 1e-6)
    assert.ok(Math.abs(signedAngle(angles[i]! - angles[next]!) - 2 * Math.PI / ids.length) < 1e-9)
  }
  assert.equal(overlaps(t), false)
})

test('1331 agents: no overlap and cheap', () => {
  const root = eye(tree(10, 1).concat(Array.from({ length: 110 }, (_, i) => node(`w${i}`, tree(5, 1, `w${i}.`).concat(tree(2, 2, `w${i}x`))))))
  const t0 = performance.now()
  const t = layout(root, new Map(), 'circular')
  const ms = performance.now() - t0
  assert.equal(t.size, 1331)
  assert.equal(overlaps(t), false)
  assert.ok(ms < 200, `took ${ms}ms`)
})

test('hidden subtrees take no space', () => {
  const root = eye([node('a', [node('a0')]), node('b')])
  const t = layout(root, new Map([['a0', 'a']]), 'circular')
  assert.ok(!t.has('a0'))
})

test('the Display setting shows, saves and follows the stored layout', async (t) => {
  localStorage.removeItem('orgtree-chart-layout')
  t.after(() => localStorage.removeItem('orgtree-chart-layout'))
  const view = await mountView(<ChartLayoutSetting />, el => el)
  t.after(() => view.unmount())
  const sel = () => view.el.querySelector('select[aria-label="Org chart layout"]') as HTMLSelectElement
  assert.equal(sel().value, 'row', 'unset shows Row')
  await inAct(() => {
    sel().value = 'circular'
    sel().dispatchEvent(new (globalThis as unknown as { window: { Event: typeof Event } }).window.Event('change', { bubbles: true }))
  })
  assert.equal(localStorage.getItem('orgtree-chart-layout'), 'circular')
  assert.equal(sel().value, 'circular')
  await inAct(() => { setChartLayout('row') })
  assert.equal(sel().value, 'row', 'another writer flips the mounted select')
})

test('ring neighbour lines join angular neighbours, not an up-and-down zig-zag', () => {
  const kids = Array.from({ length: 12 }, (_, i) => node(`k${i}`))
  const root = eye(kids)
  const t = layout(root, new Map(), 'circular')
  const ids = kids.map(k => k.id)
  const gap = (order: string[]) => {
    const d: number[] = []
    for (let i = 0; i + 1 < order.length; i++) {
      const a = centre(t.get(order[i]!)!), b = centre(t.get(order[i + 1]!)!)
      d.push(Math.hypot(a.x - b.x, a.y - b.y))
    }
    return d
  }
  const ring = gap(peerOrder(ids, t, true))
  assert.ok(Math.max(...ring) - Math.min(...ring) < 1, 'every ring link is one equal step along the ring')
  const row = gap(peerOrder(ids, t, false))
  assert.ok(Math.max(...row) > 1.5 * Math.max(...ring), 'the row order (sorted by x) would jump up and down the ring sides')
  const sorted = peerOrder(['b', 'a'], new Map([['b', { x: 5, y: 0 }], ['a', { x: 1, y: 9 }]]), false)
  assert.deepEqual(sorted, ['a', 'b'], 'row mode still reads left to right')
})

test('the animated sibling route uses the same neighbour order as the drawn lines', async () => {
  const { readFileSync } = await import('node:fs')
  const path = await import('node:path')
  const src = readFileSync(path.join(__SRC_DIR__, 'canvas', 'OrgCanvas.tsx'), 'utf8').split('\r\n').join('\n')
  const at = src.indexOf('const launchSpark = useCallback')
  const body = src.slice(at, src.indexOf('}, [])', at))
  assert.match(body, /peerOrder\(/, 'the route orders siblings through peerOrder')
  assert.doesNotMatch(body, /\.sort\(/, 'and does not x-sort them itself')
  assert.match(body, /wireRef\.current\.peerSeg/, 'with the latest wire builders, since launchSpark is memoised once')
})

test('a hire-coworker button puts the new agent in the gap between the anchor and its ring neighbour on the arrow side, everywhere on the ring', () => {
  const build = (weights: number[]) => ({
    roots: weights.map((w, i) => ({ id: 'k' + i, title: 'k' + i, tier: 't', state: 'live',
      children: Array.from({ length: w }, (_, j) => ({ id: `k${i}.${j}`, title: '', tier: 't', state: 'live', children: [] })) })),
  }) as unknown as Parameters<typeof withDraftTree>[0]
  let cases = 0, flips = 0
  for (const weights of [Array(12).fill(0), Array(7).fill(0), Array(3).fill(0), [1, 5, 9], [2, 8, 3, 11, 1], [4, 1, 1, 7, 2, 1], [9, 1, 1, 1, 12]]) {
    const tree = build(weights)
    const t = layout(withDraftTree(tree, null), new Map(), 'circular')
    const ids = weights.map((_, i) => 'k' + i), n = ids.length
    const eyeC = centre(t.get(USER)!)
    for (let i = 0; i < n; i++) {
      const a = centre(t.get(ids[i]!)!)
      // each gap points at the sibling on that side; the first and last have an
      // open end that heads on along the (counter-clockwise) ring instead
      const gapDx = (id: string | undefined, step: 1 | -1, side: 'left' | 'right') => {
        const want = side === 'left' ? -1 : 1
        if (id === undefined) return want * step * (a.y - eyeC.y) / Math.hypot(a.x - eyeC.x, a.y - eyeC.y)
        const p = centre(t.get(id)!), dx = p.x - a.x, dy = p.y - a.y
        return want * dx / Math.hypot(dx, dy)
      }
      for (const side of ['left', 'right'] as const) {
        const pin = ringInsertSide(side, ids[i]!, ids, t, true)
        const before = gapDx(ids[i - 1], -1, side), after = gapDx(ids[i + 1], 1, side)
        const chosen = pin === 'left' ? before : after, other = pin === 'left' ? after : before
        assert.ok(chosen >= other - 1e-9, `${weights} #${i} ${side}: the gap pointing closest to the arrow is chosen`)
        cases++; if (pin !== side) flips++
        // and the real insertion puts the draft right next to the anchor in ring order
        const withDraft = withDraftTree(tree, { parent: null, tier: 't', beside: { anchor: ids[i]!, side: pin } })
        const order = withDraft.children.map(c => c.id)
        assert.equal(order.indexOf(DRAFT) + (pin === 'left' ? 1 : -1), order.indexOf(ids[i]!), 'draft sits next to the anchor')
      }
    }
  }
  assert.ok(cases >= 80 && flips >= 15, `covered ${cases} cases, ${flips} flipped`)
  const t = layout(withDraftTree(build([0, 0, 0, 0]), null), new Map(), 'row')
  assert.equal(ringInsertSide('left', 'k1', ['k0', 'k1', 'k2', 'k3'], t, false), 'left', 'row layout is unchanged')
})

// user 2026-10-01 (3.0.8): "the arc swaps the left-right ordering of agents
// when going between circular and row alignment"
test('the circle arc and the row show agents in the same left-to-right order', () => {
  const xs = (t: Map<string, { x: number; y: number }>, ids: string[]) => ids.map(id => centre(t.get(id)!).x)
  const ascending = (v: number[]) => v.every((x, i) => i === 0 || x > v[i - 1]!)
  const r1 = ringRadius(layout(eye(flat(1)), new Map(), 'circular'), 'k0')
  let cap = 0
  for (let n = 1; n < 40; n++) {
    const ids = Array.from({ length: n }, (_, i) => `k${i}`)
    const circle = layout(eye(flat(n)), new Map(), 'circular')
    if (Math.abs(ringRadius(circle, 'k0') - r1) > 1e-6) { cap = n - 1; break }
    assert.ok(ascending(xs(layout(eye(flat(n)), new Map(), 'row'), ids)), `n=${n}: row reads k0..k${n - 1} left to right`)
    if (n <= 4) assert.ok(ascending(xs(circle, ids)), `n=${n}: the arc reads k0..k${n - 1} left to right too`)
    // a longer arc curls up the sides; along its lower half it still reads left to right
    const low = ids.filter(id => centre(circle.get(id)!).y > centre(circle.get(USER)!).y)
    assert.ok(ascending(xs(circle, low)), `n=${n}: the lower half of the arc reads left to right`)
  }
  assert.ok(cap > 4)
  // the full ring the arc grows into keeps the same direction: first agent just left of the top
  const full = layout(eye(flat(cap + 1)), new Map(), 'circular'), eyeC = centre(full.get(USER)!)
  assert.ok(centre(full.get('k0')!).x < eyeC.x && centre(full.get(`k${cap}`)!).x > eyeC.x, 'first agent left of the top, last right of it')
  const ids = Array.from({ length: cap + 1 }, (_, i) => `k${i}`)
  assert.ok(ascending(xs(full, ids.filter(id => centre(full.get(id)!).y > eyeC.y))), 'the bottom of the full ring reads left to right')
  // a second ring: teams stay left to right, and so do the agents inside them
  const two = eye([node('a', flat(3, 'a')), node('b', flat(2, 'b'))])
  for (const mode of ['row', 'circular'] as const) {
    const t = layout(two, new Map(), mode)
    assert.ok(ascending(xs(t, ['a', 'b'])), `${mode}: a left of b`)
    assert.ok(ascending(xs(t, ['a0', 'a1', 'a2', 'b0', 'b1'])), `${mode}: a0 a1 a2 b0 b1 left to right`)
  }
})

// user 2026-10-01 (3.0.8): "neighbor hires appear on the wrong sides of agents
// again" — the 3.0.6 arc drew siblings right to left, and its open ends were
// treated as touching, so the pressed side and the drawn side disagreed
test('a neighbour hire lands next to its anchor on the pressed side, in the circle arc and the row, and stays there after the hire', () => {
  type T = Parameters<typeof withDraftTree>[0]
  const leaf = (id: string) => ({ id, title: id, tier: 't', state: 'live', children: [] as unknown[] })
  const configs: { name: string; tree: T; parent: string | null; sibs: string[] }[] = []
  for (let n = 1; n <= 6; n++) {
    const sibs = Array.from({ length: n }, (_, i) => `k${i}`)
    configs.push({ name: `top ${n}`, tree: { roots: sibs.map(leaf) } as unknown as T, parent: null, sibs })
  }
  for (const [team, size] of [['a', 3], ['b', 2], ['b', 1]] as const) {
    const sibs = Array.from({ length: size }, (_, i) => `${team}${i}`)
    const other = team === 'a' ? ['b0', 'b1'] : ['a0', 'a1', 'a2']
    const roots = team === 'a'
      ? [{ ...leaf('a'), children: sibs.map(leaf) }, { ...leaf('b'), children: other.map(leaf) }]
      : [{ ...leaf('a'), children: other.map(leaf) }, { ...leaf('b'), children: sibs.map(leaf) }]
    configs.push({ name: `team ${team} of ${size}`, tree: { roots } as unknown as T, parent: team, sibs })
  }
  let cases = 0
  for (const mode of ['row', 'circular'] as const) {
    for (const c of configs) {
      const t = layout(withDraftTree(c.tree, null), new Map(), mode)
      for (const anchor of c.sibs) {
        for (const side of ['left', 'right'] as const) {
          const pin = ringInsertSide(side, anchor, c.sibs, t, mode === 'circular')
          const draft = layout(withDraftTree(c.tree, { parent: c.parent, tier: 't', beside: { anchor, side: pin } }), new Map(), mode)
          const dx = centre(draft.get(DRAFT)!).x - centre(draft.get(anchor)!).x
          assert.ok(side === 'left' ? dx < 0 : dx > 0, `${mode} ${c.name} ${anchor} ${side}: the new card is drawn ${side} of its anchor (dx ${dx.toFixed(0)})`)
          // the hire then pins the same order (reorderNode before/after the anchor)
          const kids = withDraftTree(c.tree, { parent: c.parent, tier: 't', beside: { anchor, side: pin } })
          const group = (c.parent === null ? kids : kids.children.find(k => k.id === c.parent)!).children.map(k => k.id)
          const at = group.indexOf(DRAFT)
          assert.equal(group[pin === 'left' ? at + 1 : at - 1], anchor, 'and sits right next to the anchor, no card skipped')
          cases++
        }
      }
    }
  }
  assert.ok(cases >= 100, `covered ${cases} cases`)
})

test('the HireSheet coworker pin is taken before the hire op, not after the tree refreshes', () => {
  const src = readFileSync('src/canvas/OrgCanvas.tsx', 'utf8')
  const at = src.indexOf('onHire={(tier, name, grant, placement)')
  const body = src.slice(at, src.indexOf('</MaybePortal>', at))
  const pinAt = body.indexOf('ringSide(a, placement)'), opAt = body.indexOf("op({ op: 'hire'")
  assert.ok(pinAt > 0 && opAt > 0 && pinAt < opAt, 'ringSide runs synchronously before the hire op')
  assert.equal(body.split('ringSide(').length - 1, 1, 'and nowhere inside the .then')
})

