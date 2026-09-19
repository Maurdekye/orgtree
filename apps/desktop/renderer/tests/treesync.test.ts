// The base+patch convergence bookkeeping (treesync.ts): gap detection,
// replay selection, pruning, reset, and the old-server degradations —
// the reorder/gap controls the 2026-09-19 approval requires as tests.

import test from 'node:test'
import assert from 'node:assert/strict'
import { isPatchFrame, newSync, onBase, onFrame, resetSync } from '../src/treesync'
import type { SyncFrame } from '../src/treesync'

const patch = (rev: number, kind = 'cache_forecast'): SyncFrame =>
  ({ type: 'node_stream', kind, rev })
const changed = (rev: number): SyncFrame => ({ type: 'changed', rev })

test('contiguous frames report no gap; a skipped rev reports one', () => {
  const s = newSync()
  assert.equal(onFrame(s, changed(1)).gap, false)   // first frame: no baseline
  assert.equal(onFrame(s, patch(2)).gap, false)
  assert.equal(onFrame(s, patch(3)).gap, false)
  assert.equal(onFrame(s, changed(7)).gap, true)    // 4-6 missed
  assert.equal(onFrame(s, patch(8)).gap, false)     // recovered baseline
})

test('rev-less frames (sparks, older server) take no part in ordering', () => {
  const s = newSync()
  onFrame(s, changed(1))
  assert.equal(onFrame(s, { type: 'mail' }).gap, false)
  assert.equal(onFrame(s, changed(2)).gap, false)   // spark did not disturb
  assert.equal(s.buffer.length, 0)
})

test('only patch frames are buffered; state frames advance the rev only', () => {
  const s = newSync()
  onFrame(s, changed(1))
  onFrame(s, patch(2))
  onFrame(s, { type: 'node_stream', kind: 'text', rev: 3 })
  onFrame(s, { type: 'node_event', rev: 4 })
  onFrame(s, patch(5, 'mcp_tool_count'))
  assert.deepEqual(s.buffer.map((f) => f.rev), [2, 5])
  assert.equal(s.lastFrameRev, 5)
})

test('onBase returns only frames NEWER than the payload, in rev order, and prunes', () => {
  const s = newSync()
  for (const r of [1, 2, 3, 4, 5]) onFrame(s, patch(r))
  const replay = onBase(s, 3)
  assert.deepEqual(replay.map((f) => f.rev), [4, 5])
  assert.deepEqual(s.buffer.map((f) => f.rev), [4, 5])   // 1-3 pruned
  assert.equal(s.baseRev, 3)
})

test('a payload newer than every buffered frame replays nothing', () => {
  const s = newSync()
  onFrame(s, patch(1))
  onFrame(s, patch(2))
  assert.deepEqual(onBase(s, 2), [])
  assert.deepEqual(s.buffer, [])
})

test('a REORDERED fetch (older body after newer patches) converges by replay', () => {
  const s = newSync()
  onFrame(s, patch(10))
  onFrame(s, patch(11))
  // the fetch that lands now was BUILT before both patches (sync_rev 9)
  const replay = onBase(s, 9)
  assert.deepEqual(replay.map((f) => f.rev), [10, 11])
})

test('a payload without sync_rev (older server) replays nothing and adopts the newest known rev', () => {
  const s = newSync()
  onFrame(s, patch(4))
  assert.deepEqual(onBase(s, undefined), [])
  assert.equal(s.baseRev, 4)
})

test('the buffer is bounded: overflow drops oldest first', () => {
  const s = newSync()
  for (let r = 1; r <= 200; r += 1) onFrame(s, patch(r))
  assert.equal(s.buffer.length, 128)
  assert.equal(s.buffer[0]!.rev, 73)                 // oldest 72 dropped
  // a base older than the drop horizon replays only what survived — the
  // full payload itself carries everything the dropped frames did
  assert.equal(onBase(s, 0).length, 128)
})

test('resetSync starts a connection over', () => {
  const s = newSync()
  onFrame(s, patch(5))
  onBase(s, 3)
  resetSync(s)
  assert.deepEqual(s, newSync())
  assert.equal(onFrame(s, changed(99)).gap, false)   // fresh baseline
})

test('isPatchFrame recognizes exactly the in-place patch kinds', () => {
  assert.equal(isPatchFrame(patch(1, 'cache_forecast')), true)
  assert.equal(isPatchFrame(patch(1, 'mcp_tool_count')), true)
  assert.equal(isPatchFrame(patch(1, 'mcp_readiness')), true)
  assert.equal(isPatchFrame({ type: 'node_stream', kind: 'text', rev: 1 }), false)
  assert.equal(isPatchFrame({ type: 'changed', rev: 1 }), false)
})
