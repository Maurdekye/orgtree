// ringteams.test.ts — circular chart teams keep their dense pitch while the
// ring springs settle (user 2026-10-20 10:46Z, alpha.18: "the central 13 look
// correct, but the ones on the ends are set apart from the rest"). The springs
// pulled a team toward its superior by its two end cards only, so an end agent
// with no reports slid away from its siblings and nothing pulled it back.
// Run:  cd apps/desktop/renderer && node tests/run.mjs ringteams
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
const ids = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `${prefix}${i}`)
function chain(prefix: string, count: number, leaves: CanvasNode[]): CanvasNode {
  let next = leaves
  for (let i = count; i > 0; i--) next = [project(`${prefix}-${String(i).padStart(2, '0')}`, next)]
  return next[0]!
}
const find = (n: CanvasNode, id: string): CanvasNode | undefined =>
  n.id === id ? n : n.children.map(c => find(c, id)).find(Boolean)

/** The live org of 10:46Z: the stack8 run sits last under build-slot, after
 *  its 24 agents, with 15 agents under stack8-08. The review stacks stay under
 *  the coordinator, the 16 run split at stack16-11 by stack12-agent-b. */
function liveOrg(): CanvasNode {
  const stack = (n: number, xs = ['a', 'b', 'c']) => chain(`stack${n}`, n, xs.map(x => agent(`stack${n}-agent-${x}`)))
  const stack16 = stack(16)
  find(stack16, 'stack16-11')!.children.push(agent('stack12-agent-b'))
  return eye([agent('coordinator', [
    project('test-project', [project('listener-smoke', agents('worker-', 3))]),
    stack(3), stack(5), stack(12, ['a', 'c']), stack16,
    project('build-slot', [...agents('bs-', 24), chain('stack8', 8, agents('stack8-agent-', 15))]),
    project('empty-project'),
  ])])
}

const centre = (p: Pt) => ({ x: p.x + NODE_W / 2, y: p.y + NODE_H / 2 })
const chord = (t: Map<string, Pt>, a: string, b: string) => {
  const p = centre(t.get(a)!), q = centre(t.get(b)!)
  return Math.hypot(p.x - q.x, p.y - q.y)
}
/** Every pair of cards (bunch members included) keeps a separate hit area. */
function separated(t: Map<string, Pt>) {
  const cards = [...t.entries()].filter(([id]) => id !== USER).sort((a, b) => a[1].x - b[1].x)
  for (let i = 0; i < cards.length; i++)
    for (let j = i + 1; j < cards.length && cards[j]![1].x - cards[i]![1].x < NODE_W; j++)
      assert.ok(Math.abs(cards[j]![1].y - cards[i]![1].y) >= NODE_H, `${cards[i]![0]} overlaps ${cards[j]![0]}`)
}
/** Consecutive siblings sit exactly one dense pitch (190) apart. */
function dense(t: Map<string, Pt>, team: string[], label: string) {
  for (let i = 1; i < team.length; i++) {
    const c = chord(t, team[i - 1]!, team[i]!)
    assert.ok(Math.abs(c - 190) < 1e-6, `${label}: ${team[i - 1]} to ${team[i]} is ${c.toFixed(1)}, want the dense 190`)
  }
}

test('the agents under a bunch keep one dense pitch to the ends of their arc', () => {
  const t = layout(liveOrg(), new Map(), 'circular', true)
  dense(t, ids('stack8-agent-', 15), 'stack8-08 team')
  dense(t, ids('bs-', 24), 'build-slot agents')
  separated(t)
})

test('a team without reports stays one arc while its superior is pushed aside', () => {
  const lead = agent('lead', [agent('a', agents('a', 4)), agent('b', agents('b', 1)),
    agent('c', agents('c', 6)), agent('d', agents('d', 9))])
  const t = layout(eye([lead]), new Map(), 'circular')
  dense(t, ids('a', 4), "a's team")
  dense(t, ids('c', 6), "c's team")
  dense(t, ids('d', 9), "d's team")
  // Their colliding teams still push the superiors apart (user 2026-10-07).
  assert.ok(chord(t, 'c', 'd') > 2 * 190, `c and d sit ${chord(t, 'c', 'd').toFixed(0)} apart`)
  separated(t)
})

test('agents without reports stay together beside superiors whose teams collide', () => {
  const lead = agent('lead', [agent('a'), agent('b'), agent('c', agents('c', 1)), agent('d', agents('d', 1)),
    agent('e', agents('e', 9)), agent('f', agents('f', 9))])
  const t = layout(eye([lead]), new Map(), 'circular')
  dense(t, ['a', 'b'], 'leaf siblings')
  dense(t, ids('e', 9), "e's team")
  dense(t, ids('f', 9), "f's team")
  assert.ok(chord(t, 'e', 'f') > 2 * 190, `e and f sit ${chord(t, 'e', 'f').toFixed(0)} apart`)
  separated(t)
})
