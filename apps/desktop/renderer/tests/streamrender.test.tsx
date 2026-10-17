import './harness'
import { inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { useState } from 'react'
import { Msg } from '../src/canvas/desk'
import { TranscriptFlow } from '../src/canvas/transcriptflow'
import type { ChatMessage } from '../src/types'

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
