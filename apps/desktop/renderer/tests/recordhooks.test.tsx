import './harness'
import { inAct, mountView } from './harness'
import React from 'react'
import test from 'node:test'
import assert from 'node:assert/strict'
import { RecordFeed } from '../src/recordfeed'
import type { SubscriptionMessage, SubscriptionInput } from '../src/recordfeed'
import { OrgRecordContext, useOrgRecords, useOrgRecordSubscription } from '../src/recordsession'

test('panels share the org controller, observe runtime at the same cursor, and release sets on change/unmount', async () => {
  const messages: SubscriptionMessage[] = []
  const feed = new RecordFeed({ snapshot: async () => { throw new Error('unexpected panel baseline') },
    catchup: async () => { throw new Error('unexpected panel HTTP') }, project: r => r,
    publish: () => {}, error: e => { throw e } })
  const cursor = { org_uuid: 'org', incarnation: 'first', rev: 1 }
  feed.receive({ type: 'record_snapshot', cursor, records: [{ entity: 'agent', id: '1', body: 'base' }] })
  const token = feed.socketOpened(m => messages.push(m))
  function Panel({ slug, input }: { slug: string; input: SubscriptionInput | null }) {
    const view = useOrgRecords(slug)
    useOrgRecordSubscription(slug, input)
    return <span>{view ? `${view.cursor.rev}:${view.records.get('agent')?.size}:${view.runtime.get('1')?.busy ?? ''}` : 'none'}</span>
  }
  const context = { slug: 'org', session: feed }
  const view = (input: SubscriptionInput, second = true) => <OrgRecordContext.Provider value={context}>
    <Panel slug="org" input={input} />
    {second && <Panel slug="org" input={{ agents: ['2'] }} />}
    <Panel slug="other" input={{ agents: ['9'] }} />
  </OrgRecordContext.Provider>
  const mounted = await mountView(view({ agents: ['2'] }), el => el.textContent)
  try {
    assert.equal(feed.declarations().length, 2, 'unrelated org cannot subscribe to this controller')
    const first = feed.declarations().map(s => s.sub)
    await inAct(() => {
      for (const sub of first) feed.receiveSocket({ type: 'record_subscribed', ...cursor, sub,
        records: [{ entity: 'agent', id: '2', body: 'subscribed', set: `sub:${sub}` }] }, token)
      feed.receiveSocket({ type: 'agent_runtime', ...cursor, epoch: 'host', seq: 1, full: true,
        agents: { '1': { epoch: 'host', seq: 1, busy: true } } }, token)
    })
    assert.equal(mounted.el.textContent, '1:2:true1:2:truenone')
    await mounted.render(view({ agents: ['3'] }))
    assert.equal(feed.declarations().length, 2)
    assert.equal(feed.records.get('agent')?.has('2'), true, 'the unchanged panel still holds this record')
    assert.ok(messages.some(m => m.type === 'unsubscribe' && m.sub === first[0]))
    const after = feed.declarations().map(s => s.sub)
    await mounted.render(view({ agents: ['3'] }))
    assert.deepEqual(feed.declarations().map(s => s.sub), after, 'equivalent input does not churn generations')
    await mounted.render(view({ agents: ['3'] }, false))
    assert.equal(feed.records.get('agent')?.has('2'), false, 'the last subscriber releases its record')
    assert.equal(feed.declarations().length, 1)
  } finally { await mounted.unmount(); feed.dispose() }
  assert.equal(feed.declarations().length, 0)
})

test('one failing external observer cannot prevent other panels seeing an atomic publication', () => {
  const errors: Error[] = [], revisions: number[] = []
  const feed = new RecordFeed({ snapshot: async () => { throw new Error('no reads') },
    catchup: async () => { throw new Error('no reads') }, project: r => r,
    publish: () => {}, error: e => errors.push(e) })
  feed.listen(() => { throw new Error('panel failed') })
  const stop = feed.listen(() => revisions.push(feed.getSnapshot()!.cursor.rev))
  const cursor = { org_uuid: 'org', incarnation: 'first', rev: 1 }
  feed.receive({ type: 'record_snapshot', cursor, records: [] })
  assert.deepEqual(revisions, [1]); assert.equal(errors.length, 1)
  const stable = feed.getSnapshot()
  assert.equal(feed.getSnapshot(), stable)
  stop(); feed.dispose()
})

test('empty subscribed panels become ready only after the final accepted answer and reset on reconnect', async () => {
  const feed = new RecordFeed({ snapshot: async () => { throw new Error('no baseline') },
    catchup: async () => { throw new Error('no catchup') }, project: r => r,
    publish: () => {}, error: e => { throw e } })
  const cursor = { org_uuid: 'org', incarnation: 'first', rev: 1 }
  feed.receive({ type: 'record_snapshot', cursor, records: [] })
  let token = feed.socketOpened(() => {})
  function Panel() {
    const ready = useOrgRecordSubscription('org', { windows: [{ kind: 'agent_mail', agent: '1' }] })
    return <span>{ready ? 'empty' : 'loading'}</span>
  }
  const mounted = await mountView(<OrgRecordContext.Provider value={{ slug: 'org', session: feed }}><Panel /></OrgRecordContext.Provider>, el => el.textContent)
  try {
    const first = feed.declarations()[0].sub
    assert.equal(mounted.el.textContent, 'loading')
    await inAct(() => feed.receiveSocket({ type: 'record_subscribed', ...cursor, sub: first, records: [], page: 0, final: false }, token))
    assert.equal(mounted.el.textContent, 'loading')
    await inAct(() => feed.receiveSocket({ type: 'record_subscribed', ...cursor, sub: first, records: [], page: 1, final: true }, token))
    assert.equal(mounted.el.textContent, 'empty')
    await inAct(() => { token = feed.socketOpened(() => {}) })
    assert.equal(mounted.el.textContent, 'loading')
    await inAct(() => feed.receiveSocket({ type: 'record_subscribed', ...cursor, sub: first, records: [] }, token))
    assert.equal(mounted.el.textContent, 'loading')
    const current = feed.declarations()[0].sub
    await inAct(() => feed.receiveSocket({ type: 'record_subscribed', ...cursor, sub: current, records: [] }, token))
    assert.equal(mounted.el.textContent, 'empty')
  } finally { await mounted.unmount(); feed.dispose() }
})
