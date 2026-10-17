import { mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { ToolTimes } from '../src/canvas/toolclock'
import { Msg } from '../src/canvas/desk'
import type { ChatMessage, ToolChip } from '../src/types'

const text = (el: Element) => el.textContent?.replace(/\s+/g, ' ').trim() ?? ''
const tool: ToolChip = { id: 'call', name: 'Bash', result: 'complete output',
  started_at: '2026-10-17T13:00:00Z', ended_at: '2026-10-17T13:00:01Z' }

test('tool output tokens retain the tilde while running and after completion', async t => {
  const view = await mountView(<ToolTimes tool={{ name: 'Bash', output_tokens: 1234, output_tokens_estimated: true }} />, text)
  t.after(() => view.unmount())
  assert.match(view.last(), /~1\.2k/)
  assert.ok(view.el.querySelector('.tool-output-tokens svg'))
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
  assert.ok(view.el.querySelector('.thinking-tokens svg'))
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
