// Which open reader a document goes to (canvas/readers.ts). USER 2026-10-20
// 19:03:28Z: "if a document is already viewable from one, then bring it to the
// front, otherwise open a new one"; 19:05:36Z: "if several ones could win,
// choose one arbitrarily in a consistent manner". The fixed order: a reader
// already showing it; its own agent/project reader; the team readers from its
// node upwards, nearest first; the global reader.
import test from 'node:test'
import assert from 'node:assert/strict'
import { pickReader, readerRank, registerReader } from '../src/canvas/readers'
import type { ReaderScope } from '../src/canvas/readers'

const org = 'order'
function open(scopes: [ReaderScope, string | null][]) {
  const offs = scopes.map(([scope, shown]) => registerReader({ org, scope, shown: () => shown, show: () => {} }))
  return () => { for (const off of offs) off() }
}
const name = (s: ReaderScope | undefined) => !s ? null : s.kind === 'global' ? 'global' : `${s.kind}:${s.id}`
// intern's document: intern, then report, then worker above it
const ANCESTRY = ['intern', 'report', 'worker']

test('the reader showing it wins, whatever its scope', () => {
  const off = open([[{ kind: 'global' }, 'd'], [{ kind: 'agent', id: 'intern' }, 'other']])
  try { assert.equal(name(pickReader(org, 'd', ANCESTRY)?.scope), 'global') } finally { off() }
})

test('then the document\'s own agent reader, then the nearest team, then the global', () => {
  let off = open([[{ kind: 'global' }, null], [{ kind: 'team', id: 'worker' }, null],
    [{ kind: 'team', id: 'report' }, null], [{ kind: 'agent', id: 'intern' }, null]])
  try { assert.equal(name(pickReader(org, 'd', ANCESTRY)?.scope), 'agent:intern') } finally { off() }
  off = open([[{ kind: 'global' }, null], [{ kind: 'team', id: 'worker' }, null], [{ kind: 'team', id: 'report' }, null]])
  try { assert.equal(name(pickReader(org, 'd', ANCESTRY)?.scope), 'team:report') } finally { off() }
  off = open([[{ kind: 'global' }, null], [{ kind: 'team', id: 'worker' }, null]])
  try { assert.equal(name(pickReader(org, 'd', ANCESTRY)?.scope), 'team:worker') } finally { off() }
  off = open([[{ kind: 'global' }, null], [{ kind: 'agent', id: 'report' }, null]])
  try { assert.equal(name(pickReader(org, 'd', ANCESTRY)?.scope), 'global', 'another agent\'s reader cannot show it') } finally { off() }
})

test('several showing it go by the same order; nothing that can show it is null', () => {
  let off = open([[{ kind: 'global' }, 'd'], [{ kind: 'team', id: 'worker' }, 'd'], [{ kind: 'team', id: 'report' }, 'd']])
  try { assert.equal(name(pickReader(org, 'd', ANCESTRY)?.scope), 'team:report') } finally { off() }
  off = open([[{ kind: 'agent', id: 'report' }, null], [{ kind: 'team', id: 'elsewhere' }, null]])
  try { assert.equal(pickReader(org, 'd', ANCESTRY), null) } finally { off() }
  off = open([[{ kind: 'agent', id: 'intern' }, null]])
  try { assert.equal(pickReader('another-org', 'd', ANCESTRY), null, 'another org\'s readers never answer') } finally { off() }
})

test('an unknown node: only a reader showing it, or the global one', () => {
  const off = open([[{ kind: 'agent', id: 'intern' }, null], [{ kind: 'global' }, null]])
  try { assert.equal(name(pickReader(org, 'd', [])?.scope), 'global') } finally { off() }
  assert.equal(readerRank({ kind: 'team', id: 'x' }, []), Infinity)
})
