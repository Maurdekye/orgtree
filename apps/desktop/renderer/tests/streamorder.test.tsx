import './harness'
import { FakeServer, advance, flush, inAct, installFetch, mountView, realClock, useFakeClock } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { ingestStream, refreshConvo, resetConvos, useConvo } from '../src/convo'
import type { Convo } from '../src/convo'
import type { ChatMessage } from '../src/types'
import { Msg } from '../src/canvas/desk'

test('one native message keeps text/tool/text order and resolves amended tool chips', async t => {
  const row: ChatMessage = { role: 'assistant', text: 'FIRST\n\nSECOND',
    tools: [{ id: 'call', name: 'Bash', arg: 'MIDDLE', result: 'done' }],
    content_blocks: [{ kind: 'text', text: 'FIRST' }, { kind: 'tool', id: 'call' }, { kind: 'text', text: 'SECOND' }] }
  const view = await mountView(<Msg m={row} slug="org" nid="blocks" />, h => h)
  t.after(() => view.unmount())
  const text = view.el.textContent ?? ''
  assert.ok(text.indexOf('FIRST') < text.indexOf('MIDDLE') && text.indexOf('MIDDLE') < text.indexOf('SECOND'), text)
  assert.equal(view.el.querySelectorAll('.msgtext').length, 2)
})

test('stream commits replace partials before the following phase, across stale polls and row amendments', async t => {
  useFakeClock()
  const server = new FakeServer()
  server.busy = true
  const transport = installFetch(server)
  let snapshot: Convo | null = null
  function Probe() { snapshot = useConvo('org', 'order'); return null }
  const view = await mountView(<Probe />, h => h)
  t.after(async () => { await view.unmount(); resetConvos(); realClock() })
  await advance(6000)
  transport.holdAll = true
  await inAct(() => { void refreshConvo('org', 'order', { force: true }) })
  await flush()
  const emit = async (kind: string, text = '', rows: ChatMessage[] = [], draft_clear = false, thinking_clear = true) => {
    await inAct(() => ingestStream('org', { node: 'order', kind, text, t: Date.now(),
      convo_rows: rows, draft_clear, thinking_clear }))
    await advance(20)
  }
  await emit('delta', 'First reply')
  assert.equal(snapshot!.draft, 'First reply')
  const first: ChatMessage = { role: 'assistant', text: 'First reply', seq: 10, row_id: 'r10',
    convo_revision: 10, ts: '2026-10-11T07:00:00Z', assistant_id: 'first' }
  await emit('text', '', [first], true)
  await emit('thinking_start', '', [], true, false)
  await emit('thinking', 'One\nTwo\n\nThree', [], true, false)
  assert.equal(snapshot!.draft, '', 'earlier reply no longer occupies the tail below the thought')
  assert.deepEqual(snapshot!.chat!.messages.map(m => m.text), ['First reply'])
  assert.equal(snapshot!.thinking, 'One\nTwo\n\nThree')
  await inAct(() => transport.release())
  await flush(10)
  assert.equal(snapshot!.chat!.messages[0]?.text, 'First reply', 'older empty HTTP snapshot cannot lose the commit')
  const thought: ChatMessage = { role: 'assistant', text: '', thinking: 'One\nTwo\n\nThree',
    row_id: 'r11', seq: 11, convo_revision: 11, ts: first.ts, assistant_id: 'thought' }
  await emit('thought', '', [thought], true)
  assert.equal(snapshot!.thinking, '')
  const tool: ChatMessage = { role: 'assistant', text: '', row_id: 'r12', seq: 12,
    convo_revision: 12, ts: first.ts, assistant_id: 'tool', tools: [{ id: 't1', name: 'Bash', arg: 'order-tool' }] }
  await emit('tool', '', [tool], true)
  const amended = { ...tool, convo_revision: 13, tools: [{ ...tool.tools![0]!, result: 'done' }] }
  await emit('tool', '', [amended], true)
  // A cursor page captured before the thought/tool only returns the first
  // reply as new. The stream has already installed all three rows.
  const chat = server.chat.bind(server)
  server.chat = last => ({ ...chat(last), incremental: true })
  server.messages = [first]
  await inAct(() => { void refreshConvo('org', 'order', { force: true }) })
  await flush()
  await inAct(() => transport.releaseLast())
  await flush(10)
  assert.deepEqual(snapshot!.chat!.messages.map(m => m.row_id), ['r10', 'r11', 'r12'], 'overlapping cursor page must not move an earlier reply to the end')
  // Poll sees the original tool start, before its result. Do not regress it.
  server.messages = [first, thought, tool]
  await inAct(() => { void refreshConvo('org', 'order', { force: true }) })
  await flush()
  await inAct(() => transport.releaseLast())
  await flush(10)
  assert.equal(snapshot!.chat!.messages.find(m => m.row_id === 'r12')?.tools?.[0]?.result, 'done')
  await emit('delta', 'Second reply')
  assert.deepEqual(snapshot!.chat!.messages.map(m => m.row_id), ['r10', 'r11', 'r12'])
  assert.equal(snapshot!.draft, 'Second reply')
  const second = { ...first, text: 'Second reply', row_id: 'r13', seq: 13, convo_revision: 14, assistant_id: 'second' }
  await emit('text', '', [second], true)
  server.messages = [first, thought, amended, second]
  transport.holdAll = false
  await inAct(() => transport.release())
  await advance(6000)
  assert.equal(snapshot!.draft, '')
  assert.deepEqual(snapshot!.chat!.messages.map(m => m.row_id), ['r10', 'r11', 'r12', 'r13'], 'final transcript has exactly one of each row in sequence order')
})
