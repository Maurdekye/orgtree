import test from 'node:test'
import assert from 'node:assert/strict'
import { nativeToolText, nativeToolJson } from '../native-tool-result.mjs'

const expected = { action: 'update', slug: 'example', previous_status: 'bogus' }
const body = { previous_status: 'open', status: 'in_progress' }
function fixture(id = 'change', primary = JSON.stringify(body), isError = false) {
  const content = [{ type: 'text', text: primary }, { type: 'text', text: 'execution time: 1.234ms' }]
  const call = { pid: 17, tool: 'orgtree_work', args: structuredClone(expected),
    is_error: isError, text: content.map(c => c.text).join('\n') }
  const request = { kind: 'send', pid: 17, line: { type: 'control_request', request_id: id,
    request: { subtype: 'mcp_message', server_name: 'orgtree', message: { id,
      method: 'tools/call', params: { name: 'orgtree_work', arguments: structuredClone(expected),
        _meta: { 'claudecode/toolUseId': id } } } } } }
  const response = { kind: 'recv', pid: 17, line: { type: 'control_response', response: {
    request_id: id, subtype: 'success', response: { mcp_response: { id, result: { content, isError } } } } } }
  return { content, call, request, response, log: [request, response], options: { toolUseId: id, args: expected } }
}
const decode = f => nativeToolJson(f.log, f.call, 'orgtree_work', f.options)

test('one exact tool-use identity selects among repeated calls and preserves real before-state', () => {
  const f = fixture(), other = fixture('other')
  f.log.unshift(...other.log)
  assert.throws(() => JSON.parse(f.call.text), SyntaxError)
  assert.deepEqual(decode(f), body)
  assert.notEqual(decode(f).previous_status, expected.previous_status)
})

test('script, logged call and original request arguments must all match', () => {
  for (const mutate of [f => { f.call.args.slug = 'other' },
    f => { f.request.line.request.message.params.arguments.slug = 'other' },
    f => { f.options = { ...f.options, args: { ...expected, action: 'get' } } },
    f => { f.request.line.request.message.params._meta['claudecode/toolUseId'] = 'other' },
    f => { f.call.tool = 'orgtree_other' }]) {
    const f = fixture(); mutate(f); assert.throws(() => decode(f))
  }
})

test('only the separate exact optional timing block may follow valid primary JSON', () => {
  const single = fixture(); single.content.pop(); single.call.text = single.content[0].text
  assert.deepEqual(decode(single), body)
  for (const tail of ['junk', 'execution time: 1ms', 'execution time: -1.000ms',
    'execution time: 1.000ms\n', 'execution time: 1.000ms\nextra']) {
    const f = fixture(); f.content[1].text = tail; f.call.text = f.content.map(c => c.text).join('\n')
    assert.throws(() => decode(f), /trailing block/)
  }
})

test('malformed primary stays a parse failure; missing fields are not invented', () => {
  for (const primary of ['{broken}', JSON.stringify(body) + '\nexecution time: 1.234ms', JSON.stringify(body) + '\n{}']) {
    assert.throws(() => decode(fixture('change', primary)), SyntaxError)
  }
  assert.deepEqual(decode(fixture('change', '{}')), {})
  assert.equal(decode(fixture('change', '{}')).previous_status, undefined)
})

test('plain expected refusal or non-status output retains its exact primary and error state', () => {
  for (const isError of [false, true]) {
    const f = fixture('change', 'Expected plain result', isError)
    assert.equal(nativeToolText(f.log, f.call, 'orgtree_work', f.options), 'Expected plain result')
    assert.throws(() => decode(f), SyntaxError)
    f.call.is_error = !isError; assert.throws(() => decode(f), /differs/)
  }
})

test('foreign, duplicate, wrong RPC and non-text response frames fail closed', () => {
  for (const mutate of [f => f.log.push(f.request), f => f.log.push(f.response),
    f => { f.response.line.response.response.mcp_response.id = 'wrong' },
    f => { f.response.line.response.request_id = 'wrong' },
    f => { f.request.line.request.server_name = 'wrong' },
    f => { f.response.pid = 18 }, f => { f.content[0].type = 'image' },
    f => f.content.push({ type: 'text', text: 'extra' }), f => { f.call.text += 'extra' }]) {
    const f = fixture(); mutate(f); assert.throws(() => decode(f))
  }
})
