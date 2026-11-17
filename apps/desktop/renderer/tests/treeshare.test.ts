import './testguard.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { shareTree, sameValue } from '../src/treeshare'
import type { TreeNode, TreePayload } from '../src/types'

// Desk-load hang (4.6.1-alpha.3, the user's machine): every feed frame projected a whole new tree,
// so no memo keyed on a node or the tree ever hit and every frame re-rendered the canvas and each
// open desk. TS1-TS4: the tree on screen keeps every object a frame did not change.

const node = (id: string, parent: string | null, extra: Partial<TreeNode> = {}, children: TreeNode[] = []) =>
  ({ id, name: id, parent, state: 'live', status: 'idle', tier: 'haiku', ui_order: 0, children, ...extra }) as unknown as TreeNode
const org = (): TreePayload => ({
  slug: 'lag', name: 'Lag', net: { hubs: [{ id: 'h', address: 'x', last_ok: '2026-11-17T10:00:00Z' }] },
  roots: [node('boss', null, {}, [
    node('lead0', 'boss', {}, [node('w00', 'lead0'), node('w01', 'lead0')]),
    node('lead1', 'boss', {}, [node('w10', 'lead1'), node('w11', 'lead1')])])],
} as unknown as TreePayload)
const find = (t: TreePayload, id: string): TreeNode => {
  const walk = (n: TreeNode): TreeNode | undefined => n.id === id ? n : n.children.map(walk).find(Boolean)
  return t.roots.map(walk).find(Boolean)!
}

test('TS1 a frame equal by value hands back the tree on screen itself', () => {
  const a = org(), b = org()
  assert.equal(shareTree(a, b), a)
  assert.equal(shareTree(null, b), b, 'nothing on screen: the new tree as it is')
})

test('TS2 one agent changed: that agent and its ancestors renew, every other node keeps its object', () => {
  const a = org(), b = org()
  ;(find(b, 'w01') as unknown as { status: string }).status = 'working'
  const s = shareTree(a, b)
  assert.notEqual(s, a)
  for (const id of ['boss', 'lead0', 'w01']) assert.notEqual(find(s, id), find(a, id), id + ' renewed')
  assert.equal((find(s, 'w01') as unknown as { status: string }).status, 'working')
  for (const id of ['lead1', 'w10', 'w11', 'w00']) assert.equal(find(s, id), find(a, id), id + ' kept')
  assert.equal(s.net, a.net, 'the unchanged net record is kept too')
  assert.ok(sameValue(s, b), 'the result equals the new frame by value')
})

test('TS3 only a top-level field changed (net hub heartbeat): roots keep their objects', () => {
  const a = org(), b = org()
  ;(b as unknown as { net: { hubs: { last_ok: string }[] } }).net.hubs[0].last_ok = '2026-11-17T10:00:05Z'
  const s = shareTree(a, b)
  assert.notEqual(s, a); assert.equal(s.roots, a.roots); assert.notEqual(s.net, a.net)
})

test('TS4 a moved, added or removed node: values follow the new frame, untouched subtrees are kept', () => {
  const a = org(), b = org()
  const lead1 = b.roots[0].children[1]
  const moved = lead1.children.shift()!                       // w10 moves under lead0
  b.roots[0].children[0].children.push({ ...moved, parent: 'lead0' } as TreeNode)
  lead1.children.push(node('w12', 'lead1'))                    // a hire
  b.roots[0].children[0].children.splice(1, 1)                // w01 leaves
  const s = shareTree(a, b)
  assert.ok(sameValue(s, b))
  assert.deepEqual(find(s, 'lead0').children.map(n => n.id), ['w00', 'w10'])
  assert.equal(find(s, 'w00'), find(a, 'w00'))
  assert.equal(find(s, 'w11'), find(a, 'w11'))
  assert.equal(find(s, 'w01' as string), undefined)
})

test('TS5 the feed publish and the desk use it: the tree is shared before setTree, sourceIds is memoized', () => {
  const app = fs.readFileSync('src/App.tsx', 'utf8')
  assert.match(app, /const visible = shareTree\(/)
  const desk = fs.readFileSync('src/canvas/desk.tsx', 'utf8')
  assert.match(desk, /const sourceIds = useMemo\(/)
})
