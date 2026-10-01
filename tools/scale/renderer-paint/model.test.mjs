import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { feedReport, validateDescriptor, validateLoad, decodePixel, publicDescriptor } from './model.mjs'

const root = path.resolve('disposable-scale-root')
const descriptor = () => ({ schema: 'orgtree-scale-v1', agents: 10, org: 'test', token: 'secret',
  root, data_root: path.join(root, 'data'), origin: 'http://127.0.0.1:9001', engine_commit: 'abc',
  pg_url: 'postgresql://test:secret@127.0.0.1:5435/orgtree_scale_test', pg_database: 'orgtree_scale_test',
  serve: { state: 'ready', pid: 42, provenance: { commit: 'abc' } }, live_agents: ['a', 'b'],
  load: { running: true, label: 'load', rate: 1, stream_hz: 2, stream_nodes: ['a'], since: 1,
    markers: path.join(root, 'metrics/load/markers.jsonl') } })
const sample = () => ({ emitted: [1, 2, 3].map(m => ({ m, emit: 10 + m / 100, node: 'a' })),
  submits: [{ first_seq: 1, frames: 3, err: null }], receipts: [1, 2, 3].map(m => ({ m, at: 10100 })),
  paints: [1, 2, 3].map(m => ({ m, at: 10200 })), agent: 'a', from: 10000, until: 11000, clockErrorMs: 1 })

test('exact accounting detects an interior lost marker even when the maximum sequence arrives', () => {
  assert.equal(feedReport(sample()).targetMet, true)
  const x = sample();x.receipts = x.receipts.filter(r => r.m !== 2);x.paints = x.paints.filter(r => r.m !== 2)
  const r = feedReport(x);assert.equal(r.targetMet, false);assert.equal(r.counts['not-received'], 1)
})
test('delivery is not paint; late, failed, missing and empty evidence cannot pass', () => {
  for (const change of [x => x.paints.pop(), x => x.paints[0].at += 1500,
    x => x.submits[0].err = 'refused', x => x.submits = [], x => x.emitted = []]) {
    const x = sample();change(x);assert.equal(feedReport(x).targetMet, false)
  }
})
test('deadline includes clock uncertainty and rejects impossible event ordering', () => {
  const x = sample();x.paints[0].at = 11009;x.clockErrorMs = 2
  assert.equal(feedReport(x).targetMet, false)
  x.paints[0].at = 10050
  assert.equal(feedReport(x).counts['clock-invalid'], 1)
})
test('frame pixel must decode exact unique opaque proof ID', () => {
  assert.equal(decodePixel(Buffer.from([0xb7, 0, 1, 255])), 0xb70001)
  assert.equal(decodePixel(Buffer.from([0xb7, 0, 1, 0])), -1)
})
test('live root, non-loopback engine and non-disposable DB fail before attachment', () => {
  assert.equal(validateDescriptor(descriptor(), root, []).agents, 10)
  assert.throws(() => validateDescriptor(descriptor(), root, [path.join(root, 'data')]))
  for (const change of [d => d.origin = 'http://example.com:9001', d => d.pg_database = 'live',
    d => d.data_root = path.dirname(root), d => d.serve.state = 'starting']) {
    const d = descriptor();change(d);assert.throws(() => validateDescriptor(d, root, []))
  }
  assert.equal(JSON.stringify(publicDescriptor(descriptor())).includes('secret'), false)
})
test('load identity, active work, selected live agent and marker containment are mandatory', () => {
  assert.equal(validateLoad(descriptor(), 'load').rate, 1)
  for (const change of [d => d.load.running = false, d => d.load.rate = 0,
    d => d.load.stream_nodes = [], d => d.load.stream_nodes = ['unknown'],
    d => d.load.markers = path.join(root, 'outside.jsonl')]) {
    const d = descriptor();change(d);assert.throws(() => validateLoad(d, 'load'))
  }
})
