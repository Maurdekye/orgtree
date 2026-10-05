import './harness'
import { flush, inAct, mountView } from './harness'
import React from 'react'
import test from 'node:test'
import assert from 'node:assert/strict'
import { OrgRecordContext } from '../src/recordsession'
import { RecordFeed } from '../src/recordfeed'
import { publishAgentPanelEvent } from '../src/recordevents'
import { useRecordScratch } from '../src/recordscratch'

const feed = () => new RecordFeed({ snapshot: async () => { throw new Error('no baseline') },
  catchup: async () => { throw new Error('no catchup') }, project: r => r, publish: () => {}, error: e => { throw e } })
const reply = (content: string) => new Response(JSON.stringify({ path: '', content }), { status: 200 })
function Panel({ path = '' }: { path?: string }) {
  const r = useRecordScratch('org', 'agent', path)
  return <div ref={r.ref} onFocusCapture={r.onFocus}><button>focus</button><span>{r.data && 'content' in r.data ? r.data.content : 'loading'}</span></div>
}

test('scratch reads only on its agent turn/file event and surface focus, with no recurring timer', async t => {
  const f = feed(), old = globalThis.fetch
  let calls = 0
  globalThis.fetch = async () => reply(String(++calls))
  t.mock.timers.enable({ apis: ['setInterval'] })
  const v = await mountView(<OrgRecordContext.Provider value={{ slug: 'org', session: f }}><Panel /></OrgRecordContext.Provider>, el => el.textContent)
  try {
    await inAct(flush); assert.equal(calls, 1)
    await inAct(async () => { t.mock.timers.tick(60000); await flush() }); assert.equal(calls, 1)
    await inAct(async () => {
      publishAgentPanelEvent({ org: 'other', node: 'agent', type: 'node_event', event: 'turn_done' })
      publishAgentPanelEvent({ org: 'org', node: 'other', type: 'node_event', event: 'turn_done' })
      publishAgentPanelEvent({ org: 'org', node: 'agent', type: 'node_stream' })
      publishAgentPanelEvent({ org: 'org', node: 'agent', type: 'node_event', event: 'turn_started' })
      await flush()
    }); assert.equal(calls, 1)
    for (const event of ['turn_done', 'file_presented']) {
      await inAct(async () => { publishAgentPanelEvent({ org: 'org', node: 'agent', type: 'node_event', event }); await flush() })
    }
    assert.equal(calls, 3)
    await inAct(async () => { v.el.querySelector('button')!.focus(); await flush() })
    assert.equal(calls, 4)
    await inAct(async () => { window.dispatchEvent(new Event('focus')); await flush() })
    assert.equal(calls, 5)
  } finally { await v.unmount(); f.dispose(); globalThis.fetch = old; t.mock.timers.reset() }
})

test('a slow old path cannot replace a newer path; events during a read trigger one follow-up', async () => {
  const f = feed(), old = globalThis.fetch, waiting: ((r: Response) => void)[] = []
  globalThis.fetch = () => new Promise(resolve => waiting.push(resolve))
  const content = (path: string) => <OrgRecordContext.Provider value={{ slug: 'org', session: f }}><Panel path={path} /></OrgRecordContext.Provider>
  const v = await mountView(content('old'), el => el.textContent)
  try {
    assert.equal(waiting.length, 1)
    await v.render(content('new')); assert.equal(waiting.length, 2)
    await inAct(async () => { waiting[1](reply('new')); await flush() })
    assert.ok(v.el.textContent?.endsWith('new'))
    await inAct(async () => { waiting[0](reply('old')); await flush() })
    assert.ok(v.el.textContent?.endsWith('new'))
    await inAct(() => {
      for (let i = 0; i < 3; i++) publishAgentPanelEvent({ org: 'org', node: 'agent', type: 'node_event', event: 'turn_done' })
    }); assert.equal(waiting.length, 3)
    await inAct(async () => { waiting[2](reply('first')); await flush() }); assert.equal(waiting.length, 4)
    await inAct(async () => { waiting[3](reply('last')); await flush() }); assert.ok(v.el.textContent?.endsWith('last'))
  } finally { await v.unmount(); f.dispose(); globalThis.fetch = old }
})