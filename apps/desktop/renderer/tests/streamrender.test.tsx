import './harness'
import { inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { useState } from 'react'
import { Msg } from '../src/canvas/desk'
import { TranscriptFlow } from '../src/canvas/transcriptflow'
import type { ChatMessage } from '../src/types'
import { uniqueFileCards } from '../src/assistantMessages'
import { replyWire } from '../src/eventReply'

test('live tail updates reuse settled segmented message projections', async t => {
  const messages: ChatMessage[] = [{ role: 'user', text: 'Question',
    segments: [{ kind: 'text', text: 'Question' }] }]
  const seen: ChatMessage[] = []
  let update!: () => void
  function Probe() {
    const [tail, setTail] = useState('first')
    update = () => setTail('second')
    return <TranscriptFlow messages={messages} now={[]} later={[]} live={<div>{tail}</div>}
      hasLive divider={null} onToggle={() => {}} renderPending={() => null}
      renderMessage={({ message }) => { seen.push(message); return <div>{message.text}</div> }} />
  }
  const view = await mountView(<Probe />, h => h)
  t.after(() => view.unmount())
  const before = seen.at(-1)
  await inAct(update)
  assert.equal(seen.at(-1) === before, true, 'unchanged projection must retain identity while live tail changes')
  assert.ok(view.el.textContent?.includes('second'))
})

test('settled prose ignores reply callbacks it cannot use but still updates changed content', async t => {
  let reads = 0, update!: () => void, change!: () => void
  const row: ChatMessage = { role: 'assistant', get text() { reads++; return 'Settled answer' } }
  function Probe() {
    const [, tick] = useState(0)
    const [message, setMessage] = useState(row)
    update = () => tick(n => n + 1)
    change = () => setMessage({ role: 'assistant', text: 'Revised answer' })
    return <Msg m={message} slug="org" nid="agent" replyAvailable={() => true} onLocateReply={() => {}} />
  }
  const view = await mountView(<Probe />, h => h)
  t.after(() => view.unmount())
  const before = reads
  await inAct(update)
  assert.equal(reads, before, 'unused reply closures must not rerender settled prose')
  await inAct(change)
  assert.ok(view.el.textContent?.includes('Revised answer'))
})

test('file-card deduplication preserves unchanged rows and never mutates duplicates', () => {
  const file = { delivery_id: 'delivery', name: 'result.txt', path: 'outbox/result.txt' }
  const first: ChatMessage = { role: 'assistant', text: 'first', tools: [{ name: 'send_file', file }] }
  const duplicate: ChatMessage = { role: 'assistant', text: 'second', tools: [{ name: 'send_file', file }] }
  const prose: ChatMessage = { role: 'user', text: 'unchanged' }
  const result = uniqueFileCards([first, duplicate, prose])
  assert.equal(result[0] === first, true)
  assert.equal(result[2] === prose, true)
  assert.equal(result[1] === duplicate, false)
  assert.equal(result[1]?.tools?.[0]?.file, undefined)
  assert.equal(duplicate.tools?.[0]?.file === file, true)
})

test('settled mail replies refresh availability and use the latest locate handler', async t => {
  let update!: () => void, located = -1
  const wire = replyWire({ org: 'org', agent: 'agent', generation: 0, eventId: 'original', quote: 'quoted' })
  const row: ChatMessage = { role: 'user', text: 'reply', segments: [{ kind: 'mail', rows: [{
    id: 'mail', from: 'peer', kind: 'message', at: '2026-10-17T12:00:00Z', body: 'reply', reply_to: wire,
  }] }] }
  function Probe() {
    const [revision, setRevision] = useState(0)
    update = () => setRevision(n => n + 1)
    return <Msg m={row} slug="org" nid="agent" replyAvailable={() => revision > 0}
      onLocateReply={() => { located = revision }} />
  }
  const view = await mountView(<Probe />, h => h)
  t.after(() => view.unmount())
  assert.equal(view.el.querySelector<HTMLButtonElement>('.reply-preview-jump')?.disabled, true)
  await inAct(update)
  const jump = view.el.querySelector<HTMLButtonElement>('.reply-preview-jump')
  assert.equal(jump?.disabled, false)
  await inAct(() => jump!.click())
  assert.equal(located, 1)
})
