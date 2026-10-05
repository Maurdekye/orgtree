import './harness'
import { inAct, mountView } from './harness'
import React from 'react'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { RecordFeed } from '../src/recordfeed'
import { RecordOverlay } from '../src/recordoverlay'
import { projectTree } from '../src/recordprojection'
import { OrgRecordContext, useOrgRecords } from '../src/recordsession'
import type { AgentRuntime } from '../src/recordoverlay'
const identity = { org_uuid: 'hub-test', incarnation: 'original' }
const frame = (seq: number, full = false, connected = true, epoch = 'host'): AgentRuntime => ({
  type: 'agent_runtime', ...identity, epoch, seq, full, agents: {},
  net: { epoch, seq, hubs: [{ id: 'h', address: 'url', connected, queued: 999, secret: 'private' }] },
})

test('hub values obey sequence, copy removal, epoch and identity fences', () => {
  let state = new RecordOverlay(identity).receive(frame(4, true, false), true)
  state = state.receive(frame(9))
  state = state.receive(frame(5, true, false))
  assert.equal((state.net!.hubs as any[])[0].connected, true)
  const absent = { ...frame(6, true), net: undefined }
  state = state.receive(absent)
  assert.equal(state.net!.seq, 9)
  state = state.receive({ ...absent, seq: 10 })
  assert.equal(state.net, null)
  assert.equal(state.receive(frame(8)).net, null)
  state = state.receive(frame(1, true, false, 'new-host'), true)
  assert.equal(state.net!.seq, 1)
  assert.equal(state.receive(frame(100)), state)
  assert.equal(state.receive({ ...frame(50), incarnation: 'other' }, true), state)
})

test('hub runtime cannot override revisioned counts or disclose extra fields', () => {
  const state = new RecordOverlay(identity).receive(frame(1, true), true)
  const live = (state.net!.hubs as any[])[0]
  assert.equal(live.queued, undefined); assert.equal(live.secret, undefined)
  const records = new Map([['org', new Map([['org', { net: { slug: 'public', hubs: [
    { id: 'h', address: 'url', queued: 2, stuck: 1, enabled: true },
    { id: 'other', address: 'url', queued: 3 },
  ] } }]])]])
  const value = projectTree(records, { netRuntime: state.net })
  assert.equal(value.net!.hubs[0]!.queued, 2)
  assert.equal(value.net!.hubs[0]!.stuck, 1)
  assert.equal(value.net!.hubs[0]!.connected, true)
  assert.equal(value.net!.hubs[1]!.connected, undefined)
  const changed = new Map([['org', new Map([['org', { net: { slug: 'public', hubs: [
    { id: 'h', address: 'repointed', queued: 4 },
  ] } }]])]])
  assert.equal(projectTree(changed, { netRuntime: state.net }).net!.hubs[0]!.connected, undefined)
})

test('malformed hub value leaves previously published overlay untouched', () => {
  const state = new RecordOverlay(identity).receive(frame(1, true), true)
  assert.throws(() => state.receive({ ...frame(5), net: { ...frame(5).net!, seq: 6 } }), /hub runtime/)
  assert.throws(() => state.receive({ ...frame(5), net: { ...frame(5).net!, hubs: [{ id: 'h' }] } }), /hub identity/)
  assert.equal(state.net!.seq, 1)
})

test('actual Python host frames update the mounted shared projection without reads', {
  skip: !process.env.ORGTREE_RECORD_NET_FIXTURE,
}, async () => {
  const packet = JSON.parse(readFileSync(process.env.ORGTREE_RECORD_NET_FIXTURE!, 'utf8'))
  const errors: Error[] = []
  const feed = new RecordFeed({
    snapshot: async () => { throw new Error('unexpected snapshot') },
    catchup: async () => { throw new Error('unexpected catchup') },
    project: projectTree, publish: () => {}, error: error => errors.push(error),
  })
  const token = feed.socketOpened(() => {})
  feed.receiveSocket(packet.initial, token)
  feed.receive({ type: 'record_snapshot', cursor: packet.cursor, records: [
    { entity: 'org', id: 'org', body: { net: packet.body } },
  ] })
  function View() {
    const value = useOrgRecords('hub-org')
    return <pre>{JSON.stringify(value ? projectTree(value.records, value).net : null)}</pre>
  }
  const view = await mountView(<OrgRecordContext.Provider value={{ slug: 'hub-org', session: feed }}><View /></OrgRecordContext.Provider>, el => el)
  await inAct(() => { feed.receiveSocket(packet.live, token) })
  assert.deepEqual(JSON.parse(view.el.textContent!), packet.expected)
  await inAct(() => { feed.receiveSocket(packet.initial, token) })
  assert.deepEqual(JSON.parse(view.el.textContent!), packet.expected, 'delayed full copy did not rewind live hubs')
  assert.deepEqual(errors, [])
  await view.unmount(); feed.dispose()
})
