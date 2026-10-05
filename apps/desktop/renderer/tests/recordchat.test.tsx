import { advance, flush, inAct, mountView, realClock, useFakeClock } from './harness'
import React, { useEffect } from 'react'
import test from 'node:test'
import assert from 'node:assert/strict'
import { OrgRecordContext } from '../src/recordsession'
import { RecordFeed } from '../src/recordfeed'
import { publishAgentPanelEvent } from '../src/recordevents'
import { refreshConvo, resetConvos, useConvo } from '../src/convo'

const feed = () => new RecordFeed({ snapshot: async () => { throw new Error('no baseline') },
  catchup: async () => { throw new Error('no catchup') }, project: r => r, publish: () => {}, error: e => { throw e } })
function Panel({ node }: { node: string }) {
  const c = useConvo('org', node)
  useEffect(() => { if (!c.loaded) void refreshConvo('org', node) }, [node, c.loaded])
  return <div>{c.chat?.messages.map(r => r.text).join('|')}</div>
}
const data = (ranks: number[], extra = {}) => ({ busy: false, queued: 0, responding: false,
  conversation_id: 'session', order_epoch: 1, assistant_scope: 'scope', before: 'older', has_older: true,
  messages: ranks.map(n => ({ row_id: String(n), event_id: String(n), seq: n, role: 'user', text: String(n) })),
  after: String(ranks.at(-1)), ...extra })
const reply = (body: unknown) => new Response(JSON.stringify(body), { status: 200 })

test('record chat has no heartbeat; only its agent events and focus fetch after the held cursor', async () => {
  useFakeClock()
  const old = globalThis.fetch, f = feed(), urls: string[] = []
  let next = data([1, 2])
  globalThis.fetch = async url => { urls.push(String(url)); return reply(next) }
  const v = await mountView(<OrgRecordContext.Provider value={{ slug: 'org', session: f }}><Panel node="incremental" /></OrgRecordContext.Provider>, el => el.textContent)
  try {
    await inAct(flush); assert.equal(urls.length, 1)
    await advance(60000); assert.equal(urls.length, 1)
    await inAct(async () => {
      publishAgentPanelEvent({ org: 'other', node: 'incremental', type: 'node_stream' })
      publishAgentPanelEvent({ org: 'org', node: 'other', type: 'node_event' })
      await flush()
    }); assert.equal(urls.length, 1)
    next = data([3], { incremental: true })
    await inAct(async () => { publishAgentPanelEvent({ org: 'org', node: 'incremental', type: 'node_stream' }); await flush() })
    assert.match(urls.at(-1)!, /after=2/); assert.equal(v.el.textContent, '1|2|3')
    next = data([], { incremental: true, after: '3' })
    await inAct(async () => { publishAgentPanelEvent({ org: 'org', node: 'incremental', type: 'node_event', event: 'turn_done' }); await flush() })
    assert.match(urls.at(-1)!, /after=3/); assert.equal(v.el.textContent, '1|2|3')
    next = data([], { incremental: true, after: '3', message_updates: [{ row_id: '3', event_id: '3', seq: 3, role: 'user', text: 'updated' }] })
    await inAct(async () => { window.dispatchEvent(new Event('focus')); await flush() })
    assert.equal(urls.length, 4)
    assert.equal(v.el.textContent, '1|2|updated')
  } finally { await v.unmount(); resetConvos(); f.dispose(); globalThis.fetch = old; realClock() }
})

test('record chat cursor replacement discards old rows and a burst keeps the viewport bounded', async () => {
  useFakeClock()
  const old = globalThis.fetch, f = feed()
  let next = data([1, 2])
  globalThis.fetch = async () => reply(next)
  const v = await mountView(<OrgRecordContext.Provider value={{ slug: 'org', session: f }}><Panel node="replacement" /></OrgRecordContext.Provider>, el => el.textContent)
  try {
    await inAct(flush)
    next = data(Array.from({ length: 20 }, (_, i) => i + 3), { incremental: true })
    await inAct(async () => { publishAgentPanelEvent({ org: 'org', node: 'replacement', type: 'node_stream' }); await flush() })
    assert.equal(v.el.textContent, '15|16|17|18|19|20|21|22')
    next = data([100], { after_reset: true, conversation_id: 'new-session' })
    await inAct(async () => { window.dispatchEvent(new Event('focus')); await flush() })
    assert.equal(v.el.textContent, '100')
  } finally { await v.unmount(); resetConvos(); f.dispose(); globalThis.fetch = old; realClock() }
})

test('events arriving during an incremental read cause one follow-up after that read settles', async () => {
  useFakeClock()
  const old = globalThis.fetch, f = feed(), waiting: ((r: Response) => void)[] = [], urls: string[] = []
  globalThis.fetch = url => { urls.push(String(url)); return new Promise(resolve => waiting.push(resolve)) }
  const v = await mountView(<OrgRecordContext.Provider value={{ slug: 'org', session: f }}><Panel node="coalesced" /></OrgRecordContext.Provider>, el => el.textContent)
  try {
    await inAct(async () => { waiting[0](reply(data([1]))); await flush() })
    await inAct(() => {
      for (let i = 0; i < 5; i++) publishAgentPanelEvent({ org: 'org', node: 'coalesced', type: 'node_stream' })
    }); assert.equal(waiting.length, 2)
    await inAct(async () => { waiting[1](reply(data([2], { incremental: true }))); await flush() })
    assert.equal(waiting.length, 3); assert.match(urls[2], /after=2/)
    await inAct(async () => { waiting[2](reply(data([3], { incremental: true }))); await flush() })
    assert.equal(v.el.textContent, '1|2|3'); assert.equal(waiting.length, 3)
  } finally { await v.unmount(); resetConvos(); f.dispose(); globalThis.fetch = old; realClock() }
})
