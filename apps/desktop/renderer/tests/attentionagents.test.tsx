// attentionagents.test.tsx — the Attention view's agents list and its default
// selection.
//
// The ticket says the dynamic agent area opens on "the agent at the top of the
// list: the leftmost top-level agent in the organization", and the coordinator
// ruled on 2026-09-21 that the visual order must come from the HOST's layout
// rather than from the tree array — because "leftmost" is a claim about what
// the user can see, and the two agree only until somebody rearranges the
// canvas. This suite pins that: the same organization, laid out two different
// ways, opens on two different agents, and each time on the one the canvas
// draws furthest left.
//
// Run:  node apps/desktop/renderer/tests/run.mjs attentionagents

import './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import type { CanvasNode, Pt } from '../src/canvas/shared'
import { USER } from '../src/canvas/shared'
import { agentRows, defaultAgent } from '../src/attention/AgentDeskPanel'

const node = (id: string, parent: string | null, o: Partial<CanvasNode> = {}): CanvasNode => ({
  id, parent, tier: 'opus', state: 'live', children: [], ...o,
} as CanvasNode)

/** a three-agent organization: two top-level reports, one of them with a
 *  child. Built in DOCUMENT order `alpha, beta, gamma` so a test that lays it
 *  out differently is really testing the layout and not the insertion order. */
const org = (): Map<string, CanvasNode> => new Map([
  node(USER, null, { tier: null, state: 'user' }),
  node('alpha', USER),
  node('beta', USER),
  node('gamma', 'alpha'),
].map((n) => [n.id, n] as [string, CanvasNode]))

const at = (places: Record<string, Pt>) =>
  (id: string): Pt | undefined => places[id]

const ids = (rows: ReturnType<typeof agentRows>) => rows.map((r) => r.node.id)

test('§1 the list is by hierarchy — each superior followed by its subtree', () => {
  const rows = agentRows(org(), at({
    alpha: { x: 0, y: 0 }, beta: { x: 100, y: 0 }, gamma: { x: 0, y: 100 },
  }))
  assert.deepEqual(ids(rows), ['alpha', 'gamma', 'beta'])
  assert.deepEqual(rows.map((r) => r.depth), [0, 1, 0], 'depth carries the indent')
})

test('§2 the default selection is the LEFTMOST top-level agent, by the host layout', () => {
  const map = org()
  // beta is drawn to the LEFT of alpha, even though alpha comes first in the tree
  const betaLeft = at({ alpha: { x: 200, y: 0 }, beta: { x: 0, y: 0 }, gamma: { x: 200, y: 100 } })
  assert.equal(defaultAgent(map, betaLeft), 'beta',
    'the agent the canvas draws furthest left is the one the view opens on')
  assert.deepEqual(ids(agentRows(map, betaLeft)), ['beta', 'alpha', 'gamma'])

  // rearrange the canvas and the answer follows it
  const alphaLeft = at({ alpha: { x: 0, y: 0 }, beta: { x: 200, y: 0 }, gamma: { x: 0, y: 100 } })
  assert.equal(defaultAgent(map, alphaLeft), 'alpha')
})

test('§2.1 a CHILD drawn further left is still not top-level', () => {
  const map = org()
  // gamma sits far to the left of both roots — and is a report of alpha
  const posOf = at({ alpha: { x: 100, y: 0 }, beta: { x: 200, y: 0 }, gamma: { x: -500, y: 100 } })
  assert.equal(defaultAgent(map, posOf), 'alpha',
    '"leftmost TOP-LEVEL" is a claim about the eye\'s own reports')
})

test('§3 with no layout yet, the tree\'s own order stands in', () => {
  const map = org()
  assert.deepEqual(ids(agentRows(map)), ['alpha', 'gamma', 'beta'])
  assert.equal(defaultAgent(map), 'alpha')
  // a host that answers for SOME agents and not others must not reorder on
  // half an answer either
  const partial = (id: string) => (id === 'beta' ? { x: 0, y: 0 } : undefined)
  assert.deepEqual(ids(agentRows(map, partial)), ['alpha', 'gamma', 'beta'])
})

test('§4 the eye, a draft and a bearer are not agents in this list', () => {
  const map = org()
  map.set('__draft__', node('__draft__', USER, { state: 'draft' }))
  map.set('bearer', node('bearer', USER, { isBearerOf: 'alpha' }))
  assert.deepEqual(ids(agentRows(map)), ['alpha', 'gamma', 'beta'])
})

test('§5 archived agents are hidden until asked for', () => {
  const map = org()
  map.set('delta', node('delta', USER, { state: 'archived' }))
  assert.deepEqual(ids(agentRows(map)), ['alpha', 'gamma', 'beta'])
  assert.deepEqual(ids(agentRows(map, undefined, { archived: true })),
    ['alpha', 'gamma', 'beta', 'delta'])
})

test('§6 the filter narrows, and keeps a matching agent\'s ancestors as ghosts', () => {
  const map = org()
  // `gamma` matches; `alpha` does not — but dropping alpha would leave gamma
  // indented under a gap, which is the Agents List's own resolution
  assert.deepEqual(ids(agentRows(map, undefined, { query: 'gamma' })), ['alpha', 'gamma'])
  assert.deepEqual(ids(agentRows(map, undefined, { query: 'zzz' })), [])
  assert.deepEqual(ids(agentRows(map, undefined, { query: '  BETA ' })), ['beta'],
    'the query is trimmed and case-insensitive')
})

test('§7 an organization whose only top-level agent retired still opens a desk', () => {
  const map = new Map<string, CanvasNode>([
    [USER, node(USER, null, { tier: null, state: 'user' })],
    ['old', node('old', USER, { state: 'archived' })],
    ['live-child', node('live-child', 'old')],
  ])
  // the retired root is hidden, so there is no top-level row at all — the view
  // opens on the first agent the list actually shows rather than on nothing
  assert.deepEqual(ids(agentRows(map)), ['old', 'live-child'])
  assert.equal(defaultAgent(map), 'old',
    'the ghost ancestor is the top of the list, so it is what the list points at')
})

test('§7.1 an organization with no agents at all selects nothing', () => {
  const map = new Map<string, CanvasNode>([
    [USER, node(USER, null, { tier: null, state: 'user' })],
  ])
  assert.deepEqual(ids(agentRows(map)), [])
  assert.equal(defaultAgent(map), null, 'and nothing is invented to fill the pane')
})

test('§8 an agent whose superior is missing from the map hangs off the eye', () => {
  const map = new Map<string, CanvasNode>([
    [USER, node(USER, null, { tier: null, state: 'user' })],
    ['orphan', node('orphan', 'a-superior-that-is-gone')],
  ])
  assert.deepEqual(ids(agentRows(map)), ['orphan'])
  assert.deepEqual(agentRows(map).map((r) => r.depth), [0],
    'it is listed rather than silently dropped out of the organization')
})
