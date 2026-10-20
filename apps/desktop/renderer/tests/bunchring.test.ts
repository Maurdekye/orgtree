// bunchring.test.ts — project bunches in the circular chart keep circular
// mode's arc-based placement (user 2026-10-20 09:08Z, alpha.16): splitting a
// stack moved a bunch onto the agents' ring, which then spread every card on
// that ring to the bunch's pitch and around the whole circle.
// Run:  cd apps/desktop/renderer && node tests/run.mjs bunchring
import './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { layout, NODE_H, NODE_W, USER } from '../src/canvas/shared'
import type { CanvasNode, Pt } from '../src/canvas/shared'

const agent = (id: string, children: CanvasNode[] = []): CanvasNode =>
  ({ id, title: id, tier: 't', kind: 'agent', state: 'live', children } as unknown as CanvasNode)
const project = (id: string, children: CanvasNode[] = []): CanvasNode =>
  ({ ...agent(id, children), kind: 'project', tier: null } as unknown as CanvasNode)
const eye = (kids: CanvasNode[]): CanvasNode =>
  ({ id: USER, title: 'you', tier: null, state: 'user', children: kids } as unknown as CanvasNode)
const agents = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => agent(`${prefix}${i}`))
function chain(prefix: string, count: number, leaves: CanvasNode[]): CanvasNode {
  let next = leaves
  for (let i = count; i > 0; i--) next = [project(`${prefix}-${String(i).padStart(2, '0')}`, next)]
  return next[0]!
}
const find = (n: CanvasNode, id: string): CanvasNode | undefined =>
  n.id === id ? n : n.children.map(c => find(c, id)).find(Boolean)

/** The live review org of 09:08Z: stacks of 3/5/8/12/16 projects, three agents
 *  under each bottom project, a two-project column, build-slot's agents. The
 *  split moves stack12-agent-b under stack16-11, cutting the 16 run in two. */
function reviewOrg(split: boolean): CanvasNode {
  const stack = (n: number) => chain(`stack${n}`, n, ['a', 'b', 'c'].map(x => agent(`stack${n}-agent-${x}`)))
  const coordinator = agent('coordinator', [
    project('test-project', [project('listener-smoke', agents('worker-', 3))]),
    stack(3), stack(5), stack(8), stack(12), stack(16),
    project('build-slot', agents('bs-', 25)),
    project('empty-project'),
  ])
  const root = eye([coordinator])
  if (split) {
    const bottom12 = find(root, 'stack12-12')!, moved = bottom12.children.splice(1, 1)[0]!
    find(root, 'stack16-11')!.children.push(moved)
  }
  return root
}

const centre = (p: Pt) => ({ x: p.x + NODE_W / 2, y: p.y + NODE_H / 2 })
const chord = (t: Map<string, Pt>, a: string, b: string) => {
  const p = centre(t.get(a)!), q = centre(t.get(b)!)
  return Math.hypot(p.x - q.x, p.y - q.y)
}
const radius = (t: Map<string, Pt>, id: string) => {
  const c = centre(t.get(USER)!), p = centre(t.get(id)!)
  return Math.hypot(p.x - c.x, p.y - c.y)
}
/** Every pair of cards (bunch members included) keeps a separate hit area. */
function separated(t: Map<string, Pt>) {
  const cards = [...t.entries()].filter(([id]) => id !== USER).sort((a, b) => a[1].x - b[1].x)
  for (let i = 0; i < cards.length; i++)
    for (let j = i + 1; j < cards.length && cards[j]![1].x - cards[i]![1].x < NODE_W; j++)
      assert.ok(Math.abs(cards[j]![1].y - cards[i]![1].y) >= NODE_H, `${cards[i]![0]} overlaps ${cards[j]![0]}`)
}
/** Consecutive siblings sit exactly one dense pitch (190) apart, as in plain circular mode. */
function dense(t: Map<string, Pt>, ids: string[], label: string) {
  for (let i = 1; i < ids.length; i++) {
    const c = chord(t, ids[i - 1]!, ids[i]!)
    assert.ok(Math.abs(c - 190) < 1e-6, `${label}: ${ids[i - 1]} to ${ids[i]} is ${c.toFixed(1)}, want the dense 190`)
  }
}
const buildSlot = Array.from({ length: 25 }, (_, i) => `bs-${i}`)

test('a split stack keeps the outer agent ring at the dense arc pitch', () => {
  const t = layout(reviewOrg(true), new Map(), 'circular', true)
  dense(t, buildSlot, 'build-slot')
  dense(t, ['stack3-agent-a', 'stack3-agent-b', 'stack3-agent-c'], 'stack3')
  separated(t)
})

test('splitting a stack does not respread the ring the split moved a bunch onto', () => {
  const whole = layout(reviewOrg(false), new Map(), 'circular', true)
  const split = layout(reviewOrg(true), new Map(), 'circular', true)
  dense(whole, buildSlot, 'build-slot before the split')
  dense(split, buildSlot, 'build-slot after the split')
  const before = radius(whole, 'bs-0'), after = radius(split, 'bs-0')
  assert.ok(after < before * 1.2, `the agent ring grew from ${before.toFixed(0)} to ${after.toFixed(0)}`)
  for (const id of ['stack3-agent-a', 'worker-0', 'stack12-agent-b'])
    assert.ok(Math.abs(radius(split, id) - after) < 1e-6, `${id} stays on the agent ring`)
})

test('a whole bunch on a busy agent ring widens only its own slot', () => {
  const lead = agent('lead', [...agents('left-', 12), chain('run', 5, [agent('member')]), ...agents('right-', 12)])
  const t = layout(eye([agent('top', [lead])]), new Map(), 'circular', true)
  const left = Array.from({ length: 12 }, (_, i) => `left-${i}`), right = Array.from({ length: 12 }, (_, i) => `right-${i}`)
  dense(t, left, 'agents before the bunch')
  dense(t, right, 'agents after the bunch')
  assert.ok(chord(t, 'left-11', 'right-0') > 190 + 200, 'the bunch keeps a wide slot between its neighbours')
  assert.ok(chord(t, 'right-11', 'left-0') > 2 * 190, 'the team stays an open arc, not a closed ring')
  separated(t)
})

test('a ring too full for an arc closes at the dense pitch around the bunch', () => {
  const lead = agent('lead', [...agents('k-', 60), chain('run', 7, [agent('member')]), ...agents('m-', 60)])
  const t = layout(eye([lead]), new Map(), 'circular', true)
  const ring = [...Array.from({ length: 60 }, (_, i) => `k-${i}`), ...Array.from({ length: 60 }, (_, i) => `m-${i}`)]
  dense(t, ring.slice(0, 60), 'first team')
  dense(t, ring.slice(60), 'second team')
  // Closed: the last agent meets the first one pitch away across the seam.
  assert.ok(Math.abs(chord(t, 'm-59', 'k-0') - 190) < 1e-6, 'the two ends meet at one dense pitch')
  separated(t)
})
