// Every docket open/close is logged from any path, not only during attract runs (coordinator follow-up 2026-11-06 m34e26cd39c88).
import test from 'node:test'
import assert from 'node:assert/strict'
import { docketChanged, markDocketPath, resetDocketLog, setDocketLogSink } from '../src/attract/docketlog'

test('DL1 two opens of different kinds log two lines with the right kind, path and instance count; a close counts down', () => {
  const got: Record<string, unknown>[] = []
  setDocketLogSink(r => { got.push(r) }); resetDocketLog()
  try {
    markDocketPath('attract'); docketChanged('org', 'open')
    markDocketPath('user'); docketChanged('agent', 'open')
    docketChanged('agent', 'close')            // no mark: other
    markDocketPath('attract'); docketChanged('org', 'close')
    assert.deepEqual(got, [
      { ev: 'docket', kind: 'org', action: 'open', path: 'attract', count: 1 },
      { ev: 'docket', kind: 'agent', action: 'open', path: 'user', count: 2 },
      { ev: 'docket', kind: 'agent', action: 'close', path: 'other', count: 1 },
      { ev: 'docket', kind: 'org', action: 'close', path: 'attract', count: 0 },
    ])
  } finally { setDocketLogSink(null); resetDocketLog() }
})

test('DL2 a mark serves one change only, and the log is enums and numbers (no text field)', () => {
  const got: Record<string, unknown>[] = []
  setDocketLogSink(r => { got.push(r) }); resetDocketLog()
  try {
    markDocketPath('link'); docketChanged('team', 'open'); docketChanged('team', 'close')
    assert.equal(got[0]!.path, 'link'); assert.equal(got[1]!.path, 'other')
    assert.deepEqual(Object.keys(got[0]!).sort(), ['action', 'count', 'ev', 'kind', 'path'])
  } finally { setDocketLogSink(null); resetDocketLog() }
})
