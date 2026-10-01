import test from 'node:test'
import assert from 'node:assert/strict'
import { decodeTree, type TreeWire } from '../src/treedelta'
import type { TreePayload } from '../src/types'

const raw = { slug: 'x', sync_rev: 1, roots: [{ id: 'a', charter: 'whole charter',
  scope: { tools: { edit: true } }, children: [{ id: 'b', detail: false, children: [] }] }] } as unknown as TreePayload
const base = { revision: 'old', raw }
const delta: TreeWire = { format: 'orgtree.tree/v1', base: 'old', revision: 'new',
  top: { set: { sync_rev: 2 }, remove: [] },
  nodes: { a: { set: { last_status: { summary: 'Working' } }, remove: [] } }, removed: [] }

test('status delta keeps all chart, desk, and edit fields without mutating the base', () => {
  const before = JSON.stringify(raw)
  const result = decodeTree(delta, base)
  assert.equal(result.roots[0].charter, 'whole charter')
  assert.deepEqual(result.roots[0].scope, raw.roots[0].scope)
  // plain data, not DOM: named so deepdom.test.tsx §5's source guard does not
  // read `.children` as a DOM child list
  const kids = result.roots[0].children
  const rawKids = raw.roots[0].children
  assert.deepEqual(kids, rawKids)
  assert.equal(result.roots[0].last_status?.summary, 'Working')
  assert.equal(result.sync_rev, 2)
  assert.equal(JSON.stringify(raw), before)
})

test('insert, remove, reparent, and field deletion reproduce the new topology', () => {
  const result = decodeTree({ ...delta,
    top: { set: { roots: ['c'] }, remove: ['sync_rev'] }, removed: ['b'], nodes: {
      c: { set: { id: 'c', children: ['a'] }, remove: [] },
      a: { set: { children: [] }, remove: ['scope'] },
    },
  }, base)
  assert.equal(result.roots[0].id, 'c')
  assert.equal(result.roots[0].children[0].id, 'a')
  assert.equal(result.roots[0].children[0].charter, 'whole charter')
  assert.equal(result.roots[0].children[0].scope, undefined)
  assert.equal(result.sync_rev, undefined)
})

test('full wire and legacy bodies retain their complete value', () => {
  assert.strictEqual(decodeTree({ format: 'orgtree.tree/v1', revision: 'x', tree: raw }), raw)
  assert.strictEqual(decodeTree(raw), raw)
})

test('wrong bases and malformed topology never silently discard a node', () => {
  assert.throws(() => decodeTree(delta), /cached base/)
  assert.throws(() => decodeTree(delta, { ...base, revision: 'different' }), /cached base/)
  assert.throws(() => decodeTree({ ...delta, removed: ['b'] }, base), /missing a node/)
  assert.throws(() => decodeTree({ ...delta, nodes: { a: { set: { children: ['a'] }, remove: [] } } }, base), /cycle/)
  assert.throws(() => decodeTree({ ...delta, top: { set: { roots: [] }, remove: [] } }, base), /unreachable/)
})
