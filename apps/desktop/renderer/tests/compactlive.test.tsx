import { advance, mountView, realClock, useFakeClock } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { Msg } from '../src/canvas/desk'
import type { ChatMessage } from '../src/types'

// A provider compaction shows as a transcript row the engine opens when the
// harness reports its start (docket show-a-live-compacting-for-xs-event-while-
// an-age): it counts up from the engine's recorded start, then reads as the
// finished record with its duration. Rows without recorded stamps (older
// engines, a harness that reports only the end, an interrupted compaction)
// show their text only, never an invented time.
const text = (el: Element) => el.textContent?.replace(/\s+/g, ' ').trim() ?? ''
const row = (extra: Partial<ChatMessage>): ChatMessage =>
  ({ role: 'system', kind: 'compact', text: 'Compacting context', ...extra } as ChatMessage)
const desk = (m: ChatMessage) => <Msg m={m} slug="org" nid="worker" onMailLink={() => {}} onWorkLink={() => {}} />

test('a running compaction counts up from its recorded start', async t => {
  useFakeClock()
  const started = new Date(Date.now() - 12_000).toISOString()
  const view = await mountView(desk(row({ compact_state: 'running', compact_started_at: started })), text)
  t.after(async () => { await view.unmount(); realClock() })
  assert.equal(view.last(), 'compacting for 12s')
  await advance(3000)
  assert.equal(view.last(), 'compacting for 15s')
})

test('the finished record keeps its duration, from the recorded stamps only', async t => {
  const view = await mountView(desk(row({ text: 'Context compacted', compact_state: 'done',
    compact_started_at: '2026-10-15T18:00:00.000Z', compact_ended_at: '2026-10-15T18:00:41.000Z' })), text)
  t.after(() => view.unmount())
  assert.equal(view.last(), 'Context compacted · took 41s')
  await view.render(desk(row({ text: 'Context compacted' })))
  assert.equal(view.last(), 'Context compacted', 'an end with no recorded start has no duration')
})

test('an interrupted compaction shows its text and no time', async t => {
  const view = await mountView(desk(row({ text: 'Context compaction interrupted', compact_state: 'interrupted',
    compact_started_at: '2026-10-15T18:00:00.000Z' })), text)
  t.after(() => view.unmount())
  assert.equal(view.last(), 'Context compaction interrupted')
})
