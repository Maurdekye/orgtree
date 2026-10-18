import { advance, FakeServer, flush, inAct, installFetch, mountView, realClock, useFakeClock } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { ToolTimes } from '../src/canvas/toolclock'
import { Msg } from '../src/canvas/desk'
import type { ChatMessage, ToolChip } from '../src/types'
import { LiveTokenContext } from '../src/canvas/tokencount'
import { contextReading } from '../src/tokenmetrics'
import { ingestStream, resetConvos, useConvo } from '../src/convo'
import type { Convo } from '../src/convo'
import { RecordOverlay } from '../src/recordoverlay'

const text = (el: Element) => el.textContent?.replace(/\s+/g, ' ').trim() ?? ''
const tool: ToolChip = { id: 'call', name: 'Bash', result: 'complete output',
  started_at: '2026-10-17T13:00:00Z', ended_at: '2026-10-17T13:00:01Z' }

test('tool output tokens retain the tilde while running and after completion', async t => {
  const view = await mountView(<ToolTimes tool={{ name: 'Bash', output_tokens: 1234, output_tokens_estimated: true }} />, text)
  t.after(() => view.unmount())
  assert.match(view.last(), /~1\.2k/)
  const glyph = view.el.querySelector('.tool-output-tokens .token-glyph')
  assert.equal(glyph?.textContent, 'T')
  assert.equal(glyph?.getAttribute('aria-hidden'), 'true')
  assert.equal(!!view.el.querySelector('.tool-output-tokens svg'), false)
  await view.render(<ToolTimes tool={{ ...tool, output_tokens: 1234, output_tokens_estimated: true }} />)
  assert.match(view.last(), /~1\.2k/)
  assert.match(view.last(), /1\.0s/)
  assert.match(view.el.querySelector('.tool-output-tokens')?.getAttribute('title') ?? '', /estimat/i)
})

test('an attributed receipt replaces an estimate, including a real zero', async t => {
  const view = await mountView(<ToolTimes tool={{ ...tool, output_tokens: 123, output_tokens_estimated: true }} />, text)
  t.after(() => view.unmount())
  await view.render(<ToolTimes tool={{ ...tool, output_tokens: 130, output_tokens_estimated: false }} />)
  assert.match(view.last(), /130/)
  assert.doesNotMatch(view.last(), /~/)
  await view.render(<ToolTimes tool={{ ...tool, output_tokens: 0, output_tokens_estimated: false }} />)
  assert.equal(view.el.querySelector('.tool-output-tokens')?.getAttribute('aria-label'), '0 output tokens')
})

test('historical missing and invalid counts show no invented token slot', async t => {
  const view = await mountView(<ToolTimes tool={tool} />, text)
  t.after(() => view.unmount())
  for (const output_tokens of [undefined, null, -1, NaN, Infinity]) {
    await view.render(<ToolTimes tool={{ ...tool, output_tokens } as ToolChip} />)
    assert.equal(!!view.el.querySelector('.tool-output-tokens'), false)
  }
})

test('finished thoughts show provider counts and icon only when attributed', async t => {
  const row = { role: 'assistant', text: '', thinking: 'synthetic reasoning', thinking_tokens: 321 } as ChatMessage
  const view = await mountView(<Msg m={row} slug="synthetic" nid="worker" />, text)
  t.after(() => view.unmount())
  assert.equal(view.el.querySelector('.thinking-tokens')?.getAttribute('aria-label'), '321 thinking tokens')
  assert.equal(view.el.querySelector('.thinking-tokens .token-glyph')?.textContent, 'T')
  assert.equal(!!view.el.querySelector('.thinking-tokens svg'), false)
  await view.render(<Msg m={{ ...row, thinking_tokens: undefined }} slug="synthetic" nid="worker" />)
  assert.equal(!!view.el.querySelector('.thinking-tokens'), false)
})

test('ordered native thoughts display one attributed response count once', async t => {
  const row = { role: 'assistant', text: '', thinking: 'synthetic', thinking_tokens: 9,
    content_blocks: [{ kind: 'thinking', start: 0, end: 9 }] } as ChatMessage
  const view = await mountView(<Msg m={row} slug="synthetic" nid="worker" />, text)
  t.after(() => view.unmount())
  assert.equal(view.el.querySelectorAll('.thinking-tokens').length, 1)
  assert.match(view.last(), /9/)
})

test('live output frames update the shared chip without retiring prose or fetching chat', async t => {
  useFakeClock()
  const server = new FakeServer()
  server.busy = true
  installFetch(server)
  let snapshot: Convo | undefined
  function Probe() {
    const convo = useConvo('synthetic', 'counts')
    snapshot = convo
    return <LiveTokenContext.Provider value={convo.toolTokens ?? {}}><ToolTimes tool={{ id: 'call', name: 'Bash' }} /></LiveTokenContext.Provider>
  }
  const view = await mountView(<Probe />, text)
  t.after(async () => { await view.unmount(); resetConvos(); realClock() })
  await flush()
  await inAct(() => ingestStream('synthetic', { node: 'counts', kind: 'delta', text: 'keep this prose', t: Date.now() }))
  await advance(20)
  const reads = server.requests.length
  await inAct(() => ingestStream('synthetic', { node: 'counts', kind: 'tool_tokens', text: '', t: Date.now(),
    tool_tokens: [{ id: 'call', output_tokens: 42, output_tokens_estimated: true }] }))
  assert.match(view.last(), /~42/)
  assert.equal(snapshot!.draft, 'keep this prose')
  await advance(250)
  assert.equal(server.requests.length, reads)
  await view.render(<ToolTimes tool={{ ...tool, output_tokens: 80, output_tokens_estimated: false }} />)
  assert.match(view.last(), /80/)
  assert.doesNotMatch(view.last(), /~/)
})

test('current measured occupancy overrides stale chat, including an explicit zero', () => {
  const node = { busy: true, context_live: true, occupancy: 71, occupancy_est: false, context_window: 1000 }
  const chat = { occupancy: 40, occupancy_estimated: true }
  assert.deepEqual(contextReading(node, chat), { used: 71, estimated: false, window: 1000 })
  assert.equal(contextReading({ ...node, occupancy: 0 }, chat).used, 0)
  assert.equal(contextReading({ ...node, busy: false }, chat).used, 40)
})

test('runtime occupancy patches affect only the named agent and keep provider numbers', () => {
  const identity = { org_uuid: 'synthetic', incarnation: 'boot' }
  const original = new RecordOverlay(identity).receive({ ...identity, type: 'agent_runtime', epoch: 'host', seq: 1, full: true,
    agents: { one: { epoch: 'host', seq: 1, busy: true }, two: { epoch: 'host', seq: 1, busy: false } } }, true)
  const next = original.receive({ ...identity, type: 'agent_runtime', epoch: 'host', seq: 2, full: false,
    agents: { one: { epoch: 'host', seq: 2, busy: true, occupancy: 71, occupancy_est: false, context_window: 1000, context_live: true } } })
  assert.equal(next.values.get('one')!.occupancy, 71)
  assert.equal(next.values.get('one')!.occupancy_est, false)
  assert.equal(next.values.get('two'), original.values.get('two'))
})
