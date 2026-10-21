import test from 'node:test'
import assert from 'node:assert/strict'
import { mountView } from './harness'
import { Msg } from '../src/canvas/desk'
import type { ChatMessage } from '../src/types'

test('Claude persisted block clocks survive a serialized reload and stay collapsed', async t => {
  const row: ChatMessage = JSON.parse(JSON.stringify({ role: 'assistant', text: '', thinking: 'First.Second.',
    content_blocks: [{ kind: 'thinking', start: 0, end: 6, think_secs: 125 },
      { kind: 'thinking', start: 6, end: 13, think_secs: 7 }] }))
  const v = await mountView(<Msg m={row} slug="synthetic" nid="agent" />, h => h)
  t.after(() => v.unmount())
  assert.deepEqual([...v.el.querySelectorAll('.thoughtline')].map(e => e.textContent?.trim()),
    ['thought for 2m 05s', 'thought for 7s'])
  assert.equal(v.el.querySelectorAll('.thoughtbody').length, 0)
})

test('single historical recorded time works; unrecorded blocks never borrow a row time', async t => {
  const v = await mountView(<>
    <div data-case="known"><Msg m={{ role: 'assistant', text: '', thinking_sealed: true, think_secs: 60,
      content_blocks: [{ kind: 'thinking', sealed: true }] }} slug="synthetic" nid="agent" /></div>
    <div data-case="unknown"><Msg m={{ role: 'assistant', text: '', think_secs: 125,
      content_blocks: [{ kind: 'thinking', sealed: true, think_secs: 7 },
        { kind: 'thinking', sealed: true }] }} slug="synthetic" nid="agent" /></div>
  </>, h => h)
  t.after(() => v.unmount())
  assert.equal(v.el.querySelector('[data-case="known"] .thoughtline')?.textContent?.trim(), 'thought for 1m 00s')
  assert.deepEqual([...v.el.querySelectorAll('[data-case="unknown"] .thoughtline')].map(e => e.textContent?.trim()),
    ['thought for 7s', 'thought for a moment'])
})

test('a measured zero is a time while absent timing stays unknown', async t => {
  const v = await mountView(<>
    <Msg m={{ role: 'assistant', text: '', thinking_sealed: true, think_secs: 0 }} slug="synthetic" nid="agent" />
    <Msg m={{ role: 'assistant', text: '', thinking_sealed: true }} slug="synthetic" nid="agent" />
  </>, h => h)
  t.after(() => v.unmount())
  assert.deepEqual([...v.el.querySelectorAll('.thoughtline')].map(e => e.textContent?.trim()),
    ['thought for 0s', 'thought for a moment'])
})
