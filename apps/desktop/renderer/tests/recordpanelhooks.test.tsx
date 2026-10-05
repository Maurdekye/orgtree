import './harness'
import { flush, inAct, mountView } from './harness'
import React from 'react'
import test from 'node:test'
import assert from 'node:assert/strict'
import { RecordFeed } from '../src/recordfeed'
import { OrgRecordContext } from '../src/recordsession'
import { RecordPanelSelection } from '../src/recordpanelselection'
import { useRecordInbox, useRecordMailbox, useRecordHistory } from '../src/recordpanelhooks'
import { usePolledStatus } from '../src/canvas/shared'

const initial = { org_uuid: 'org', incarnation: 'one', rev: 1 }
test('known capability suppresses legacy reads before the session is installed', async () => {
  const prior = globalThis.fetch
  let reads = 0
  globalThis.fetch = async () => { reads++; throw new Error('unexpected legacy read') }
  function Panel() {
    const inbox = useRecordInbox('org'), mail = useRecordMailbox('org','agent'), history = useRecordHistory('org','agent')
    return <span>{inbox.status.loading && mail.value === null && history.value === null ? 'loading' : 'ready'}</span>
  }
  const v = await mountView(<OrgRecordContext.Provider value={{ slug: 'org', session: null }}><Panel /></OrgRecordContext.Provider>, el => el.textContent)
  try {
    await inAct(flush)
    assert.equal(v.el.textContent,'loading')
    assert.equal(reads,0)
  } finally { await v.unmount(); globalThis.fetch = prior }
})

function feed() {
  return new RecordFeed({ snapshot: async () => { throw new Error('unexpected baseline') },
    catchup: async () => { throw new Error('unexpected catchup') }, project: r => r,
    publish: () => {}, error: e => { throw e } })
}

test('shared inbox waits for the record baseline without starting legacy HTTP or timers', async () => {
  const f = feed(), prior = globalThis.fetch
  let reads = 0
  globalThis.fetch = async () => { reads++; throw new Error('unexpected HTTP') }
  function Panel() { const b = useRecordInbox('org'); return <span>{b.status.loading ? 'loading' : b.value?.pending.length}</span> }
  const v = await mountView(<OrgRecordContext.Provider value={{ slug: 'org', session: f }}><Panel /></OrgRecordContext.Provider>, el => el.textContent)
  try {
    assert.equal(v.el.textContent, 'loading')
    await inAct(() => f.receive({ type: 'record_snapshot', cursor: initial, records: [] }))
    assert.equal(v.el.textContent, '0'); assert.equal(reads, 0)
    await inAct(() => f.receive({ type: 'record_changes', ...initial, from: 1, to: 2,
      upserts: [{ entity: 'user_inbox', id: '1', body: { id: 'mail' } }], tombstones: [] }))
    assert.equal(v.el.textContent, '1'); assert.equal(reads, 0)
  } finally { await v.unmount(); f.dispose(); globalThis.fetch = prior }
})

test('agent panels resolve one stable ID each and await an empty accepted socket subscription', async () => {
  const f = feed(), prior = globalThis.fetch
  f.receive({ type: 'record_snapshot', cursor: initial, records: [] })
  const token = f.socketOpened(() => {})
  const urls: string[] = []
  globalThis.fetch = async input => {
    urls.push(String(input)); assert.ok(String(input).includes('/records/selection?'))
    return new Response(JSON.stringify({ cursor: initial, names: { agent: '7' }, missing: [], matches: [] }), { status: 200 })
  }
  function Panel() {
    const mail = useRecordMailbox('org', 'agent'), history = useRecordHistory('org', 'agent')
    return <span>{mail.value ? 'mail' : 'wait'}:{history.value ? 'history' : 'wait'}</span>
  }
  const v = await mountView(<OrgRecordContext.Provider value={{ slug: 'org', session: f }}><Panel /></OrgRecordContext.Provider>, el => el.textContent)
  try {
    await inAct(flush)
    assert.equal(v.el.textContent, 'wait:wait')
    assert.equal(f.declarations().length, 2)
    await inAct(() => {
      for (const sub of f.declarations()) f.receiveSocket({ type: 'record_subscribed', ...initial, sub: sub.sub, records: [] }, token)
    })
    assert.equal(v.el.textContent, 'mail:history'); assert.equal(urls.length, 2)
    await inAct(() => f.receive({ type: 'record_changes', ...initial, from: 1, to: 2, upserts: [], tombstones: [] }))
    assert.equal(urls.length, 2, 'unrelated revisions do not refetch accepted names')
  } finally { await v.unmount(); f.dispose(); globalThis.fetch = prior }
})

test('mail and history expose selection failures and recover on focus at the same revision', async () => {
  const f = feed(), prior = globalThis.fetch
  f.receive({ type: 'record_snapshot', cursor: initial, records: [] })
  const token = f.socketOpened(() => {})
  let reads = 0
  globalThis.fetch = async () => {
    if (++reads <= 2) throw new Error('selection offline')
    return new Response(JSON.stringify({ cursor: initial, names: { agent: '7' }, missing: [], matches: [] }), { status: 200 })
  }
  function Panel() {
    const mail = useRecordMailbox('org','agent'), history = useRecordHistory('org','agent')
    return <><div ref={mail.ref}>{mail.error ? 'mail failed' : mail.value ? 'mail ready' : 'mail loading'}</div>
      <div ref={history.ref}>{history.error ? 'history failed' : history.value ? 'history ready' : 'history loading'}</div></>
  }
  const v = await mountView(<OrgRecordContext.Provider value={{ slug: 'org', session: f }}><Panel /></OrgRecordContext.Provider>, el => el.textContent)
  try {
    await inAct(flush)
    assert.equal(v.el.textContent, 'mail failedhistory failed')
    assert.equal(reads, 2, 'no automatic request loop after rejection')
    await inAct(async () => { v.el.ownerDocument.defaultView!.dispatchEvent(new Event('focus')); await flush() })
    assert.equal(reads, 4)
    assert.equal(f.getSnapshot()?.cursor.rev, 1)
    await inAct(() => {
      for (const sub of f.declarations()) f.receiveSocket({ type: 'record_subscribed', ...initial, sub: sub.sub, records: [] }, token)
    })
    assert.equal(v.el.textContent, 'mail readyhistory ready')
    await inAct(async () => { v.el.ownerDocument.defaultView!.dispatchEvent(new Event('focus')); await flush() })
    assert.equal(reads, 4, 'accepted names stay resolved on later focus')
  } finally { await v.unmount(); f.dispose(); globalThis.fetch = prior }
})

test('a delayed name lookup cannot subscribe the replacement org or a disposed panel', async () => {
  const f = feed(), results: (string | null)[] = []
  f.receive({ type: 'record_snapshot', cursor: initial, records: [] })
  let answer!: (value: any) => void
  let reads = 0
  const s = new RecordPanelSelection(f, 'agent', () => { reads++; return new Promise(resolve => { answer = resolve }) }, id => results.push(id))
  f.receive({ type: 'record_snapshot', cursor: { ...initial, incarnation: 'two', rev: 0 }, records: [] })
  answer({ cursor: initial, names: { agent: '7' }, missing: [], matches: [] })
  await flush()
  assert.equal(results.includes('7'), false); assert.equal(reads, 2)
  s.dispose()
  answer({ cursor: { ...initial, incarnation: 'two', rev: 0 }, names: { agent: '8' }, missing: [], matches: [] })
  await flush(); assert.equal(results.includes('8'), false); f.dispose()
})

test('disabling legacy polling invalidates an in-flight answer and reenabling fetches anew', async () => {
  let answer!: (value: string) => void, calls = 0
  function Panel({ enabled }: { enabled: boolean }) {
    const p = usePolledStatus(() => { calls++; return new Promise<string>(resolve => { answer = resolve }) }, ['org'], 100000, 0, enabled)
    return <span>{p.value ?? 'empty'}</span>
  }
  const v = await mountView(<Panel enabled />, el => el.textContent)
  try {
    assert.equal(calls, 1)
    const old = answer
    await v.render(<Panel enabled={false} />)
    await inAct(async () => { old('stale'); await flush() })
    assert.equal(v.el.textContent, 'empty'); assert.equal(calls, 1)
    await v.render(<Panel enabled />); assert.equal(calls, 2)
    await inAct(async () => { answer('fresh'); await flush() })
    assert.equal(v.el.textContent, 'fresh')
  } finally { await v.unmount() }
})
test('a name answer ahead of the cursor requests catchup before publishing its ID', async () => {
  const f = feed(), results: (string | null)[] = []
  f.receive({ type: 'record_snapshot', cursor: initial, records: [] })
  let recover = 0
  const session = { getSnapshot: f.getSnapshot, listen: f.listen, subscribe: f.subscribe.bind(f),
    reconnect: async () => {
      recover++
      f.receive({ type: 'record_changes', ...initial, from: 1, to: 2, upserts: [], tombstones: [] })
    } }
  const s = new RecordPanelSelection(session, 'agent', async () => ({ cursor: { ...initial, rev: 2 }, names: { agent: '9' }, missing: [], matches: [] }), id => results.push(id))
  await flush()
  assert.equal(recover, 1); assert.equal(results.at(-1), '9')
  s.dispose(); f.dispose()
})
test('shared inbox carries feed failure and recovery instead of vouching for stale empty records', async () => {
  const f = feed()
  f.receive({ type: 'record_snapshot', cursor: initial, records: [] })
  function Panel() { const b = useRecordInbox('org'); return <span>{b.status.failed ? b.status.stale ? 'stale' : 'unavailable' : b.status.loading ? 'loading' : 'current'}</span> }
  const content = (failed: boolean) => <OrgRecordContext.Provider value={{ slug: 'org', session: f,
    status: { loading: false, failed, stale: failed, unavailable: false, error: failed ? 'offline' : null, at: 1 } }}><Panel /></OrgRecordContext.Provider>
  const v = await mountView(content(false), el => el.textContent)
  try {
    assert.equal(v.el.textContent, 'current')
    await v.render(content(true)); assert.equal(v.el.textContent, 'stale')
    await v.render(content(false)); assert.equal(v.el.textContent, 'current')
  } finally { await v.unmount(); f.dispose() }
})
