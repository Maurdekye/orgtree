import { flush, inAct, mountView, FakeServer, installFetch } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { AccountsPanel } from '../src/canvas/accounts'
import { layout, withDraftTree, flatten, NODE_W, NODE_H } from '../src/canvas/shared'
import type { CanvasNode, Pt } from '../src/canvas/shared'
import { agent, project, chain, bunchTree } from './projectbunch-fixture'
import { pruneRetiredView } from '../src/canvas/canvaslayout'

// The extra arguments are ignored by the base: the red control executes the
// actual old layout instead of failing an import of a not-yet-written helper.
const place = layout as (root: CanvasNode, hidden: Map<string, string>, mode: 'row' | 'circular',
  bunch: boolean, source?: ReadonlyMap<string, CanvasNode>) => Map<string, Pt>
const rootOf = (n: ReturnType<typeof agent>) => withDraftTree(bunchTree([n]), null)
const extent = (p: Pt[]) => ({
  w: Math.max(...p.map(p => p.x)) - Math.min(...p.map(p => p.x)) + NODE_W,
  h: Math.max(...p.map(p => p.y)) - Math.min(...p.map(p => p.y)) + NODE_H,
})
function separated(points: Pt[]) {
  for (let i = 0; i < points.length; i++) for (let j = i + 1; j < points.length; j++)
    assert.ok(Math.abs(points[i]!.x - points[j]!.x) >= NODE_W + 7.9
      || Math.abs(points[i]!.y - points[j]!.y) >= NODE_H + 7.9, `cards ${i},${j} have separate hit areas`)
}

for (const mode of ['row', 'circular'] as const) for (const n of [2, 3, 5, 7, 8, 12, 20]) {
  test(`${mode}: ${n} direct projects form a tightly packed round serpentine with separate cards`, () => {
    const root = rootOf(chain(n)), snapshot = JSON.stringify(root)
    const out = place(root, new Map(), mode, true)
    const points = Array.from({ length: n }, (_, i) => out.get(`project-${i + 1}`)!)
    const shape = extent(points)
    assert.ok(shape.w > NODE_W * 1.3, 'bunch uses width rather than a vertical column')
    assert.ok(Math.max(shape.w / shape.h, shape.h / shape.w) < 1.6, 'roughly round outline')
    assert.ok(shape.w * shape.h < n * (NODE_W + 8) ** 2 * 1.5, 'no large empty gaps inside the blob')
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1]!, b = points[i]!
      const gap = Math.hypot(Math.max(0, Math.abs(a.x - b.x) - NODE_W),
        Math.max(0, Math.abs(a.y - b.y) - NODE_H))
      assert.ok(gap >= 7.9 && gap <= 16, 'each chain link joins adjacent cards across a small even gap')
      assert.ok(b.y >= a.y, 'the snake progresses down through the blob')
    }
    if (n >= 3) assert.ok(points.some((p, i) => i && p.x < points[i - 1]!.x), 'the order doubles back')
    const rows = new Set(points.map(p => Math.round(p.y)))
    assert.ok(rows.size >= Math.floor(Math.sqrt(n)) && rows.size <= Math.ceil(Math.sqrt(n)) + 1,
      'larger bunches gain turns instead of stretching one zigzag')
    separated([...out.values()])
    assert.equal(out.size, n + 3, 'eye, every project and both members retained')
    assert.equal(JSON.stringify(root), snapshot, 'layout never reparents input')
    if (mode === 'row') {
      const old = place(root, new Map(), mode, false)
      assert.ok(extent(points).h < extent(Array.from({ length: n }, (_, i) => old.get(`project-${i + 1}`)!)).h,
        'uses less vertical room than the old column')
      for (let i = 2; i <= n; i++) assert.equal(old.get(`project-${i}`)!.y - old.get(`project-${i - 1}`)!.y, 200)
    }
  })
}
test('singletons and side-by-side projects keep the exact existing layout', () => {
  const root = rootOf(project('outer', [project('left', [agent('a')]), project('right', [agent('b')])]))
  for (const mode of ['row', 'circular'] as const)
    assert.deepEqual(place(root, new Map(), mode, true), place(root, new Map(), mode, false))
})
test('splits and intervening agents end a bunch; runs below each break bunch independently', () => {
  for (const middle of [
    [chain(2, [agent('leaf-a')], 'left'), chain(2, [agent('leaf-b')], 'right')],
    [agent('middle', [chain(2, [agent('leaf')], 'lower')])],
  ]) {
    const root = rootOf(chain(2, middle, 'upper')), out = place(root, new Map(), 'row', true)
    const prefixes = middle.length === 2 ? ['upper', 'left', 'right'] : ['upper', 'lower']
    for (const prefix of prefixes) assert.ok(out.get(`${prefix}-2`)!.x > out.get(`${prefix}-1`)!.x, `${prefix} bunch`)
    separated([...out.values()])
  }
})
test('a hidden retired side branch is still a structural break', () => {
  const root = rootOf(project('outer', [project('inner', [agent('worker')]), { ...agent('retired'), state: 'archived' }]))
  const pruned = pruneRetiredView(root, true, new Set()).root
  const source = flatten(root, {})
  assert.deepEqual(place(pruned, new Map(), 'row', true, source), place(pruned, new Map(), 'row', false, source))
})
test('Display has a default-on bunch switch that persists opt-out and remounts', async t => {
  localStorage.removeItem('orgtree-project-bunches')
  const previous = globalThis.fetch
  installFetch(new FakeServer())
  t.after(() => { globalThis.fetch = previous; localStorage.removeItem('orgtree-project-bunches') })
  const render = () => <AccountsPanel toast={() => {}} close={() => {}} initialTab="display" />
  const view = await mountView(render(), el => el)
  t.after(() => view.unmount())
  await flush(8)
  const toggle = view.el.querySelector<HTMLInputElement>('input[aria-label="bunch consecutive projects"]')
  assert.ok(!!toggle, 'Display switch exists')
  assert.equal(toggle!.checked, true)
  await inAct(() => toggle!.click())
  assert.equal(localStorage.getItem('orgtree-project-bunches'), '0')
  await view.unmount()
  const remount = await mountView(render(), el => el)
  t.after(() => remount.unmount())
  await flush(8)
  assert.equal(remount.el.querySelector<HTMLInputElement>('input[aria-label="bunch consecutive projects"]')!.checked, false)
})
test('Display offers rearranging beside bunching, default off, with an independent persisted opt-in', async t => {
  localStorage.clear()
  const previous = globalThis.fetch
  installFetch(new FakeServer())
  t.after(() => { globalThis.fetch = previous; localStorage.clear() })
  const render = () => <AccountsPanel toast={() => {}} close={() => {}} initialTab="display" />
  const view = await mountView(render(), el => el)
  t.after(() => view.unmount())
  await flush(8)
  const label = 'input[aria-label="rearrange projects in a bunch"]'
  const toggle = view.el.querySelector<HTMLInputElement>(label)
  assert.ok(!!toggle, 'Display switch exists')
  assert.equal(toggle!.checked, false)
  const toggles = [...view.el.querySelectorAll('input[type="checkbox"]')].map(e => e.getAttribute('aria-label'))
  assert.equal(toggles.indexOf('rearrange projects in a bunch'), toggles.indexOf('bunch consecutive projects') + 1)
  await inAct(() => toggle!.click())
  assert.equal(localStorage.getItem('orgtree-project-bunch-rearrange'), '1')
  assert.equal(view.el.querySelector<HTMLInputElement>('input[aria-label="bunch consecutive projects"]')!.checked, true)
  await view.unmount()
  const remount = await mountView(render(), el => el)
  t.after(() => remount.unmount())
  await flush(8)
  assert.equal(remount.el.querySelector<HTMLInputElement>(label)!.checked, true)
  await inAct(() => remount.el.querySelector<HTMLInputElement>(label)!.click())
  assert.equal(localStorage.getItem('orgtree-project-bunch-rearrange'), '0')
})
