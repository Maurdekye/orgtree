// remotetree.test.tsx: the tree of a remote organization whose name there is
// taken on this computer (docs/rust-engine/remote-org.md, "Names").
//
// The window of "acme-galaxy" asks its engine for that organization; the
// remote engine answers with the tree of "acme", the name it has there. The
// window keys its desks, drafts and layout by the name it asked by, and
// checks every answer against it, so the tree must carry that name: with the
// other one no desk ever opens ("Loading organization...").
//
// Run:  node tests/run.mjs remotetree
import test from 'node:test'
import assert from 'node:assert/strict'
import { treeHere } from '../src/remotehere'

test('a tree that already carries the name the window asked by is returned as it is', () => {
  const tree = { slug: 'acme', roots: [] }
  assert.equal(treeHere(tree, 'acme'), tree)
})

test('a tree under the name the organization has on its engine carries the name it has here', () => {
  const roots = [{ id: 'lead' }]
  const tree = { slug: 'acme', name: 'Acme', roots }
  const here = treeHere(tree, 'acme-galaxy')
  assert.deepEqual(here, { slug: 'acme-galaxy', name: 'Acme', roots })
  assert.equal(here.roots, roots, 'nothing else is copied or changed')
  assert.equal(tree.slug, 'acme', 'the answer itself is untouched')
  // an unchanged answer (the same object, as a 304 gives) stays one object, so nothing re-renders
  assert.equal(treeHere(tree, 'acme-galaxy'), here)
  // the same answer asked for by another name is not served from the first
  assert.equal(treeHere(tree, 'acme-nebula').slug, 'acme-nebula')
})
