import { advance, FakeServer, flush, inAct, installFetch, mountView, realClock, useFakeClock } from './harness'
import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { OrgCanvas } from '../src/canvas/OrgCanvas'
import { AccountsPanel } from '../src/canvas/accounts'
import { resetConvos } from '../src/convo'
import { USER, setChartLayout, treeParents, withPendingMoves } from '../src/canvas/shared'
import { withPendingOrder } from '../src/canvas/pendingorder'
import { setProjectBunchesOn } from '../src/canvas/projectbunchprefs'
import { projectBunchRotation, withProjectBunchRotation } from '../src/canvas/projectbunchmove'
import { projectDraftSteps } from '../src/canvas/newproject'
import { agent, chain, bunchTree, project, retired } from './projectbunch-fixture'
import type { TreePayload } from '../src/types'

const W = window as unknown as Window & typeof globalThis
const numbers = (s: string) => (s.match(/-?\d+(\.\d+)?(e-?\d+)?/g) ?? []).map(Number)
const card = (el: HTMLElement, id: string) => el.querySelector<HTMLElement>(
  id === USER ? '.sq.user' : `.sq[data-copy-agent-name="${id}"]`)
function at(el: HTMLElement, id: string) {
  const c = card(el, id)
  assert.ok(!!c, `card ${id} present`)
  const [x, y] = numbers(c!.style.transform)
  return { x: x!, y: y! }
}
function client(el: HTMLElement, p: { x: number; y: number }) {
  const [x, y, z] = numbers(el.querySelector<HTMLElement>('.space')!.style.transform)
  return { clientX: x! + p.x * z!, clientY: y! + p.y * z! }
}
async function canvas(t: TestContext, tree = bunchTree([chain(3)]), mode: 'row' | 'circular' = 'row', rearrange = true) {
  useFakeClock(); t.after(realClock)
  resetConvos()
  localStorage.clear()
  setChartLayout(mode)
  setProjectBunchesOn(true)
  // Rotation tests explicitly opt in; a fresh profile keeps ordinary dragging.
  if (rearrange) localStorage.setItem('orgtree-project-bunch-rearrange', '1')
  const proto = W.HTMLElement.prototype
  const old = { rect: proto.getBoundingClientRect, w: Object.getOwnPropertyDescriptor(proto, 'clientWidth'),
    h: Object.getOwnPropertyDescriptor(proto, 'clientHeight'), capture: proto.setPointerCapture }
  proto.setPointerCapture = () => {}
  proto.getBoundingClientRect = function () {
    return this.classList.contains('viewport') ? { left: 0, top: 0, right: 1600, bottom: 1000, width: 1600, height: 1000 } as DOMRect
      : old.rect.call(this)
  }
  Object.defineProperty(proto, 'clientWidth', { configurable: true, get() { return this.classList.contains('viewport') ? 1600 : 0 } })
  Object.defineProperty(proto, 'clientHeight', { configurable: true, get() { return this.classList.contains('viewport') ? 1000 : 0 } })
  t.after(() => {
    proto.getBoundingClientRect = old.rect; proto.setPointerCapture = old.capture
    if (old.w) Object.defineProperty(proto, 'clientWidth', old.w)
    if (old.h) Object.defineProperty(proto, 'clientHeight', old.h)
  })
  const previous = globalThis.fetch
  installFetch(new FakeServer())
  const fallback = globalThis.fetch
  const gestures: { steps: Record<string, unknown>[] }[] = [], ops: unknown[] = [], errors: string[] = []
  let resolve!: (value: unknown) => void, reject!: (error: Error) => void
  const answer = new Promise((yes, no) => { resolve = yes; reject = no })
  globalThis.fetch = ((url, init) => {
    if (String(url).endsWith('/gesture')) {
      gestures.push(JSON.parse(String(init?.body)))
      return answer.then(value => new Response(JSON.stringify(value), { status: 200 }))
    }
    return fallback(url, init)
  }) as typeof fetch
  t.after(() => { globalThis.fetch = previous })
  const render = (tree: TreePayload) => <OrgCanvas tree={tree} slug={tree.slug} mailEvt={null}
    op={async b => { ops.push(b); return {} as never }} toast={lines => errors.push(...(lines ?? []))} />
  const view = await mountView(render(tree), el => el)
  t.after(() => view.unmount())
  await flush(); await advance(3000, 50); await flush()
  return { ...view, gestures, ops, errors, resolve, reject,
    show: async (next: TreePayload) => { await view.render(render(next)); await advance(1500, 50); await flush() } }
}
async function drag(el: HTMLElement, id: string, world: { x: number; y: number }, cancel = false,
  during?: () => Promise<void>) {
  const p = at(el, id), c = card(el, id)!
  const start = client(el, { x: p.x + 62, y: p.y + 62 }), finish = client(el, world)
  for (const [type, point] of [['pointerdown', start], ['pointermove', finish], [cancel ? 'pointercancel' : 'pointerup', finish]] as const) {
    await inAct(() => c.dispatchEvent(new W.PointerEvent(type, { bubbles: true, button: 0, pointerId: 1, ...point })))
    if (type === 'pointermove') await during?.()
  }
  await flush()
}
function endPoint(el: HTMLElement, id: string, neighbour: string) {
  const p = at(el, id), q = at(el, neighbour), dx = p.x - q.x, dy = p.y - q.y
  const scale = 40 / Math.max(Math.abs(dx), Math.abs(dy))
  return { x: p.x + 62 + dx * scale, y: p.y + 62 + dy * scale }
}
function apply(tree: TreePayload, steps: Record<string, unknown>[]) {
  let current = tree
  for (const step of steps) {
    if (step.op === 'moves') {
      for (const move of step.moves as { node: string; new_parent: string | null }[]) {
        const next = withPendingMoves(current, new Map([[move.node, move.new_parent]]))
        assert.notEqual(next, current, 'each step is a valid non-cyclic move')
        current = next
      }
    } else if (step.op === 'reorder') {
      current = withPendingOrder(current, { parent: treeParents(current).get(step.node as string)!,
        block: [step.node as string], slot: { before: step.before as string | undefined, after: step.after as string | undefined }, settled: false })
    } else assert.fail('only existing moves/reorder operations are allowed')
  }
  return current
}
test('bunch links are short curves between nearby card edges, using the ordinary edge class', async t => {
  const view = await canvas(t, bunchTree([chain(8)]))
  const edges = [...view.el.querySelectorAll<SVGPathElement>('.project-bunch-edge')]
  assert.equal(edges.length, 7)
  for (const edge of edges) {
    assert.equal(edge.classList.contains('edge'), true)
    const d = edge.getAttribute('d') ?? ''
    assert.ok(d.includes('C'), 'each local connector is a curve')
    const p = numbers(d), gap = Math.hypot(p[6]! - p[0]!, p[7]! - p[1]!)
    assert.ok(gap <= 20, 'links never cross the blob')
  }
})
for (const mode of ['row', 'circular'] as const) {
  test(`${mode}: dragging the head to the end is one atomic rotation; members stay below the new bottom`, async t => {
    const tree = bunchTree([agent('boss', [agent('left'), chain(3), agent('right')])])
    const view = await canvas(t, tree, mode)
    assert.equal(view.el.querySelectorAll('.project-bunch-edge').length, 2, 'real order line rendered')
    await drag(view.el, 'project-1', endPoint(view.el, 'project-3', 'project-2'))
    assert.equal(view.gestures.length, 1, 'one atomic gesture')
    assert.equal(view.ops.length, 0)
    const next = apply(tree, view.gestures[0]!.steps), parents = treeParents(next)
    assert.equal(parents.get('project-2'), 'boss')
    assert.equal(parents.get('project-3'), 'project-2')
    assert.equal(parents.get('project-1'), 'project-3')
    assert.equal(parents.get('worker-a'), 'project-1')
    assert.equal(parents.get('worker-b'), 'project-1')
    assert.deepEqual(next.roots[0]!.children.map(n => n.id), ['left', 'project-2', 'right'])
    await advance(1200, 50)
    assert.ok(at(view.el, 'project-2').x < at(view.el, 'project-1').x, 'shown before server reply')
    await inAct(() => view.resolve({ results: [] }))
    await view.show(next)
    assert.ok(at(view.el, 'project-2').x < at(view.el, 'project-1').x, 'feed agrees with preview')
  })
}
test('refused in-bunch reorder restores all cards; cancellation sends nothing', async t => {
  const view = await canvas(t), original = at(view.el, 'project-3')
  await drag(view.el, 'project-3', endPoint(view.el, 'project-1', 'project-2'))
  assert.equal(view.gestures.length, 1)
  await inAct(() => view.reject(new Error('permission refused')))
  await advance(1500, 50); await flush()
  assert.ok(Math.abs(at(view.el, 'project-3').x - original.x) < 2)
  assert.ok(view.errors.some(line => line.includes('permission refused')))
  await drag(view.el, 'project-3', endPoint(view.el, 'project-1', 'project-2'), true)
  assert.equal(view.gestures.length, 1)
})
test('drag insertion follows a middle row running right to left', async t => {
  const tree = bunchTree([chain(7)]), view = await canvas(t, tree)
  const a = at(view.el, 'project-4'), b = at(view.el, 'project-5')
  assert.ok(a.x > b.x && Math.abs(a.y - b.y) < 1, 'the fixture reaches a reversed row')
  await drag(view.el, 'project-1', { x: (a.x + b.x + 124) / 2, y: a.y + 62 })
  assert.equal(view.gestures.length, 1)
  const next = apply(tree, view.gestures[0]!.steps), parents = treeParents(next)
  assert.equal(parents.get('project-1'), 'project-4')
  assert.equal(parents.get('project-5'), 'project-1')
  assert.equal(parents.get('worker-a'), 'project-7')
  await inAct(() => view.resolve({ results: [] }))
  await view.show(next)
})
test('dragging outside a bunch retains the existing whole-subtree move', async t => {
  const view = await canvas(t, bunchTree([chain(3), agent('outside')]), 'row', false), point = at(view.el, 'outside')
  await drag(view.el, 'project-2', { x: point.x + 62, y: point.y + 62 })
  assert.equal(view.gestures.length, 0)
  assert.deepEqual(view.ops, [{ op: 'demote', node: 'project-2', new_parent: 'outside' }])
})

test('retired project cards keep their own order links and respond to the live Display preference', async t => {
  const view = await canvas(t, bunchTree([retired(chain(5, [agent('worker')]))]))
  assert.equal(view.el.querySelectorAll('.sq.project.archived').length, 5)
  assert.equal(view.el.querySelectorAll('.project-bunch-edge').length, 4)
  const bunched = at(view.el, 'project-5')
  await inAct(() => setProjectBunchesOn(false))
  await advance(1500, 50)
  assert.equal(view.el.querySelectorAll('.project-bunch-edge').length, 0)
  assert.ok(at(view.el, 'project-5').y > bunched.y + 200)
  await inAct(() => setProjectBunchesOn(true))
  await advance(1500, 50)
  assert.equal(view.el.querySelectorAll('.project-bunch-edge').length, 4)
})

for (const partlyRestored of [false, true]) test(`${partlyRestored ? 'partly restored' : 'retired'} bunch dragging cannot offer a rotation into an archived parent`, async t => {
  const head = retired(chain(3))
  if (partlyRestored) head.state = 'live'
  const view = await canvas(t, bunchTree([head]), 'row', true)
  await drag(view.el, 'project-1', endPoint(view.el, 'project-3', 'project-2'), false, async () => {
    await advance(50, 50)
    assert.equal(!!view.el.querySelector('[data-project-bunch-insert]'), false)
  })
  assert.equal(view.gestures.length, 0)
  assert.equal(view.ops.length, 0)
  assert.deepEqual(view.errors, [])
})
test('fresh profiles drag the entire subtree inside a bunch without an insertion point or rotation', async t => {
  const view = await canvas(t, bunchTree([chain(3)]), 'row', false)
  const head = at(view.el, 'project-1'), tail = at(view.el, 'project-3')
  await drag(view.el, 'project-1', endPoint(view.el, 'project-3', 'project-2'), false, async () => {
    await advance(50, 50) // ordinary subtree dragging paints on the animation frame
    assert.equal(!!view.el.querySelector('[data-project-bunch-insert]'), false)
    const movedHead = at(view.el, 'project-1'), movedTail = at(view.el, 'project-3')
    assert.ok(Math.hypot(movedHead.x - head.x, movedHead.y - head.y) > 20, 'actual drag ran')
    // Rendered positions can trail the spring's final snap by its rest epsilon.
    assert.ok(Math.abs((movedHead.x - head.x) - (movedTail.x - tail.x)) < .1,
      JSON.stringify({ head, tail, movedHead, movedTail }))
    assert.ok(Math.abs((movedHead.y - head.y) - (movedTail.y - tail.y)) < .1)
  })
  assert.equal(view.gestures.length, 0)
  assert.equal(view.ops.length, 0, 'dropping on its own descendant does not reparent')
})
test('rearranging off still permits ordinary reparenting within the bunch', async t => {
  const view = await canvas(t, bunchTree([chain(3)]), 'row', false), head = at(view.el, 'project-1')
  await drag(view.el, 'project-3', { x: head.x + 62, y: head.y + 62 })
  assert.equal(view.gestures.length, 0)
  assert.deepEqual(view.ops, [{ op: 'promote', node: 'project-3', new_parent: 'project-1' }])
})
test('the app setting and cross-window storage events change rearranging on a mounted canvas', async t => {
  const view = await canvas(t, bunchTree([chain(3)]), 'row', false)
  const settings = await mountView(<AccountsPanel initialTab="display" toast={() => {}} close={() => {}} />, el => el)
  t.after(() => settings.unmount())
  await flush(8)
  const toggle = settings.el.querySelector<HTMLInputElement>('input[aria-label="rearrange projects in a bunch"]')
  assert.ok(!!toggle, 'app setting exists')
  const preview = async (enabled: boolean) => {
    await drag(view.el, 'project-1', endPoint(view.el, 'project-3', 'project-2'), true, async () => {
      assert.equal(!!view.el.querySelector('[data-project-bunch-insert]'), enabled)
    })
    assert.equal(view.gestures.length, 0, 'cancel sends nothing')
  }
  assert.equal(toggle!.checked, false)
  await inAct(() => toggle!.click())
  assert.equal(toggle!.checked, true)
  await preview(true)
  await inAct(() => toggle!.click())
  await preview(false)
  await inAct(() => {
    localStorage.setItem('orgtree-project-bunch-rearrange', '1')
    window.dispatchEvent(new W.StorageEvent('storage', { key: 'orgtree-project-bunch-rearrange', newValue: '1' }))
  })
  assert.equal(toggle!.checked, true)
  await preview(true)
  await inAct(() => {
    localStorage.removeItem('orgtree-project-bunch-rearrange')
    window.dispatchEvent(new W.StorageEvent('storage', { key: null }))
  })
  assert.equal(toggle!.checked, false, 'clearing storage restores the default')
  await preview(false)
  assert.equal(view.el.querySelectorAll('.project-bunch-edge').length, 2, 'layout remains bunched')
})
test('disabling rearranging during a drag removes its marker and prevents a rotation on release', async t => {
  const view = await canvas(t)
  await drag(view.el, 'project-1', endPoint(view.el, 'project-3', 'project-2'), false, async () => {
    assert.equal(!!view.el.querySelector('[data-project-bunch-insert]'), true)
    await inAct(() => {
      localStorage.setItem('orgtree-project-bunch-rearrange', '0')
      window.dispatchEvent(new W.StorageEvent('storage', { key: 'orgtree-project-bunch-rearrange', newValue: '0' }))
    })
    assert.equal(!!view.el.querySelector('[data-project-bunch-insert]'), false)
  })
  assert.equal(view.gestures.length, 0)
  assert.equal(view.ops.length, 0)
})
test('existing above placement joins above a project or a sole bottom agent; a split stays separate', async t => {
  for (const anchor of ['project-2', 'worker']) assert.deepEqual(
    projectDraftSteps({ parent: anchor === 'worker' ? 'project-2' : 'project-1',
      tier: 'project', project: true, above: { anchor } }, 'inserted', ''),
    [{ op: 'create_project', name: 'inserted', above: anchor }])
  const initial = bunchTree([chain(2, [agent('worker')])]), view = await canvas(t, initial)
  assert.equal(view.el.querySelectorAll('.project-bunch-edge').length, 1)
  await view.show(bunchTree([project('project-1', [project('inserted', [project('project-2', [agent('worker')])])])]))
  assert.equal(view.el.querySelectorAll('.project-bunch-edge').length, 2)
  await view.show(bunchTree([project('project-1', [project('project-2', [project('inserted', [agent('worker')])])])]))
  assert.equal(view.el.querySelectorAll('.project-bunch-edge').length, 2)
  await view.show(bunchTree([project('project-1', [project('project-2', [project('inserted', [agent('worker')]), agent('sibling')])])]))
  assert.equal(view.el.querySelectorAll('.project-bunch-edge').length, 1, 'branch prevents joining')
})
test('every rotation of 2 through 8 projects preserves the exact ordered member group and outer slot', () => {
  for (let n = 2; n <= 8; n++) for (let from = 0; from < n; from++) for (let to = 0; to < n; to++) {
    const tree = bunchTree([agent('left'), chain(n), agent('right')])
    const before = Array.from({ length: n }, (_, i) => `project-${i + 1}`)
    const id = before[from]!, rest = before.filter(k => k !== id)
    const slot = to === n - 1 ? { after: rest[rest.length - 1]! } : { before: rest[to]! }
    const rotation = projectBunchRotation(tree, before, id, slot)
    if (from === to) { assert.equal(rotation, null); continue }
    assert.ok(rotation)
    const next = apply(tree, rotation.steps), parents = treeParents(next)
    const order = [...rest.slice(0, to), id, ...rest.slice(to)]
    assert.deepEqual(next.roots.map(n => n.id), ['left', order[0], 'right'])
    order.forEach((k, i) => assert.equal(parents.get(k), i ? order[i - 1] : null))
    for (const member of ['worker-a', 'worker-b']) assert.equal(parents.get(member), order[order.length - 1])
    assert.equal(parents.size, n + 4)
    assert.deepEqual([...treeParents(withProjectBunchRotation(tree, rotation))].sort(), [...parents].sort())
    assert.equal(withProjectBunchRotation(next, rotation), next, 'confirmed read ends override')
    assert.equal(treeParents(tree).get('project-1'), null, 'source unchanged')
  }
})
test('a concurrent split or unloaded children refuses the rotation before any writes', () => {
  const ids = ['project-1', 'project-2']
  const split = bunchTree([project('project-1', [project('project-2'), agent('branch')])])
  assert.throws(() => projectBunchRotation(split, ids, ids[0]!, { after: ids[1] }), /changed or has unloaded/)
  const hidden = bunchTree([project('project-1', [{ ...project('project-2'), hidden_retired_children: 10 } as never])])
  assert.throws(() => projectBunchRotation(hidden, ids, ids[0]!, { after: ids[1] }), /changed or has unloaded/)
})
test('Display opt-out updates an already-mounted canvas and storage events restore bunching', async t => {
  const view = await canvas(t)
  assert.equal(view.el.querySelectorAll('.project-bunch-edge').length, 2)
  await inAct(() => setProjectBunchesOn(false))
  await advance(1000, 50)
  assert.equal(view.el.querySelectorAll('.project-bunch-edge').length, 0)
  assert.ok(Math.abs(at(view.el, 'project-1').x - at(view.el, 'project-3').x) < 2)
  await inAct(() => {
    localStorage.setItem('orgtree-project-bunches', '1')
    window.dispatchEvent(new W.StorageEvent('storage', { key: 'orgtree-project-bunches', newValue: '1' }))
  })
  assert.equal(view.el.querySelectorAll('.project-bunch-edge').length, 2)
})
