import test from 'node:test'
import assert from 'node:assert/strict'
import { nativeSelfCallJson } from '../proofs/next-turn-query.mjs'

const primary = JSON.stringify({ compaction: { occupancy: 71000 }, label: 'a } in a string' }, null, 2)
function fixture(tail = 'execution time: 0.432ms') {
  const content = [{ type: 'text', text: primary }]
  if (tail !== null) content.push({ type: 'text', text: tail })
  const call = { kind: 'tool_result', tool: 'orgtree_next_turn', pid: 17,
    is_error: false, text: content.map(c => c.text).join('\n') }
  const request = { kind: 'send', pid: 17, line: { type: 'control_request', request_id: 'fake_21',
    request: { subtype: 'mcp_message', server_name: 'orgtree', message: { id: 20,
      method: 'tools/call', params: { name: 'orgtree_next_turn', arguments: {} } } } } }
  const response = { kind: 'recv', pid: 17, line: { type: 'control_response', response: {
    request_id: 'fake_21', subtype: 'success', response: { mcp_response: {
      id: 20, result: { content } } } } } }
  return { call, request, response, content, log: [request, response, call] }
}

test('original joined-text parse reproduces timing failure; correlated primary JSON succeeds', () => {
  const f = fixture()
  assert.throws(() => JSON.parse(f.call.text), SyntaxError)
  assert.deepEqual(nativeSelfCallJson(f.log, f.call), JSON.parse(primary))
})

test('legacy single primary block remains valid', () => {
  const f = fixture(null)
  assert.equal(nativeSelfCallJson(f.log, f.call).compaction.occupancy, 71000)
})

test('invalid trailing blocks are rejected, never stripped', () => {
  for (const tail of ['arbitrary suffix', 'execution time: 1ms', 'execution time: -1.000ms',
    'execution time: 1.000ms\nextra', 'execution time: 1.000ms\n']) {
    const f = fixture(tail)
    assert.throws(() => nativeSelfCallJson(f.log, f.call), /trailing block/)
  }
  const f = fixture()
  f.content.push({ type: 'text', text: 'extra' })
  assert.throws(() => nativeSelfCallJson(f.log, f.call), /text blocks/)
})

test('malformed primary JSON and suffixes inside primary are rejected', () => {
  for (const bad of ['{broken}', primary + '\nexecution time: 0.432ms', primary + '\n{}']) {
    const f = fixture()
    f.content[0].text = bad
    f.call.text = f.content.map(c => c.text).join('\n')
    assert.throws(() => nativeSelfCallJson(f.log, f.call), SyntaxError)
  }
})

test('request and response correlation rejects missing, duplicate or foreign records', () => {
  for (const mutate of [
    f => { f.call.pid = undefined },
    f => { f.request.line.request.server_name = 'foreign' },
    f => { f.log.push(f.request) },
    f => { f.response.pid = 18 },
    f => { f.response.line.response.request_id = 'other' },
    f => { f.log.push(f.response) },
    f => { f.response.line.response.response.mcp_response.id = 99 },
  ]) {
    const f = fixture(); mutate(f)
    assert.throws(() => nativeSelfCallJson(f.log, f.call))
  }
})

test('response errors, non-text content and joined-log mismatches are rejected', () => {
  for (const mutate of [
    f => { f.response.line.response.subtype = 'error' },
    f => { f.response.line.response.response.mcp_response.error = { message: 'refused' } },
    f => { f.content[0].type = 'image' },
    f => { f.content[0].text = null },
    f => { f.response.line.response.response.mcp_response.result.isError = true },
    f => { f.call.text += 'extra' },
  ]) {
    const f = fixture(); mutate(f)
    assert.throws(() => nativeSelfCallJson(f.log, f.call))
  }
})
