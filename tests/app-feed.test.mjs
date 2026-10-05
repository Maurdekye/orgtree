import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { build } from 'esbuild'

const temp = mkdtempSync(path.join(tmpdir(), 'orgtree-app-feed-'))
const file = path.join(temp, 'feed.cjs')
await build({ entryPoints: ['packages/contracts/app-feed.ts'], outfile: file,
  bundle: true, platform: 'node', format: 'cjs' })
const { AppFeedState } = createRequire(import.meta.url)(file)
test.after(() => rmSync(temp, { recursive: true, force: true }))

const org = { org_id: 1, slug: 'one', org_uuid: 'org', state: 'active' }
const registry = (rev, rows = [org], epoch = 'host') => ({ type: 'registry_snapshot', epoch,
  cursor: { app_uuid: 'app', incarnation: 'app-inc', rev },
  records: rows.map(body => ({ entity: 'registry_org', id: String(body.org_id), body })) })
const summary = (seq, incarnation = 'old', rev = 99, body = { name: incarnation }) => ({
  type: 'org_summary', org_id: 1, org_uuid: 'org', incarnation, rev, epoch: 'host', seq, body })
const notice = (seq, incarnation = 'old', rev = 99, notices = [{ id: incarnation }]) => ({
  type: 'org_notices', org_id: 1, org_uuid: 'org', incarnation, rev, epoch: 'host', seq, notices })
const full = (seq, { reg = registry(10), summaries = {}, notices = {}, values = {}, orgs = {},
  epoch = 'host' } = {}) => ({ type: 'app_snapshot', epoch, seq, registry: reg,
  summaries, notices, runtime: { values, orgs } })
const connected = () => { const state = new AppFeedState(); state.apply(full(1), true); return state }

test('registry snapshots 10/11/12 and 10/12 converge after create-delete and change-back', () => {
  for (const middle of [[org, { ...org, org_id: 2 }], [{ ...org, slug: 'renamed' }]]) {
    const every = connected(), coalesced = connected()
    every.apply(registry(11, middle)); every.apply(registry(12))
    coalesced.apply(registry(12))
    assert.deepEqual(every.registry, coalesced.registry)
    every.apply(registry(11, middle)); every.apply(registry(10, []))
    assert.deepEqual(every.registry, registry(12))
  }
})

test('HTTP registry copy is revision ordered independently from copy sequence', () => {
  const state = connected()
  state.apply(registry(12, []))
  state.apply(full(20, { reg: registry(11) }))
  assert.deepEqual(state.registry.records, [])
})

test('lower-revision replacement wins in both UUID orders, including equal bodies', () => {
  for (const incarnation of ['a', 'zz']) {
    const state = connected()
    const old = summary(4, 'm', 99, { name: 'same' })
    const next = summary(8, incarnation, 1, { name: 'same' })
    state.apply(old); state.apply(notice(5, 'm'))
    const delayed = full(6, { summaries: { 1: old }, notices: { 1: notice(5, 'm') } })
    state.apply(summary(7, 'm', 99, null)); state.apply(next); state.apply(notice(9, incarnation, 1))
    state.apply(delayed); state.apply(old); state.apply(notice(5, 'm'))
    assert.equal(state.summaries.get('1').value.incarnation, incarnation)
    assert.equal(state.notices.get('1').value.incarnation, incarnation)
    assert.deepEqual(state.allNotices(), [{ id: incarnation }])
  }
})

test('full copy removes old entries but preserves later entries and removal tombstones', () => {
  const state = connected()
  state.apply(summary(3)); state.apply(notice(4))
  state.apply(full(5))
  state.apply(summary(3)); state.apply(notice(4))
  assert.equal(state.summaries.get('1').value, null)
  assert.equal(state.notices.get('1').value, null)
  state.apply(summary(8)); state.apply(notice(9, 'old', 99, null))
  state.apply(full(7, { notices: { 1: notice(4) } }))
  assert.equal(state.summaries.get('1').value.seq, 8)
  assert.equal(state.notices.get('1').value, null)
})

test('full copy floor rejects old entries the client never saw, for all four maps', () => {
  const state = connected()
  state.apply(full(10))
  state.apply(summary(5)); state.apply(notice(6))
  state.apply({ type: 'app_runtime', epoch: 'host', seq: 7,
    values: { providers: { epoch: 'host', seq: 7, value: ['old'] } },
    orgs: { 1: { epoch: 'host', seq: 7, working: 3 } } })
  assert.equal(state.summaries.size, 0); assert.equal(state.notices.size, 0)
  assert.equal(state.values.size, 0); assert.equal(state.working.size, 0)
})

test('each runtime value is independently ordered against delayed full copies', () => {
  const state = connected()
  state.apply({ type: 'app_runtime', epoch: 'host', seq: 10,
    values: { providers: { epoch: 'host', seq: 9, value: ['new'] } },
    orgs: { 1: { epoch: 'host', seq: 10, working: 2 } } })
  state.apply(full(5, { values: { providers: { epoch: 'host', seq: 3, value: ['old'] },
    accounts: { epoch: 'host', seq: 4, value: ['account'] } } }))
  assert.deepEqual(state.value('providers'), ['new'])
  assert.deepEqual(state.value('accounts'), ['account'])
  assert.equal(state.working.get('1').value.working, 2)
})

test('only first socket copy can establish a new epoch; HTTP and old frames cannot', () => {
  const state = connected()
  state.apply(summary(100))
  const restart = full(1, { epoch: 'new', reg: { ...registry(0, []), epoch: 'new',
    cursor: { app_uuid: 'new-app', incarnation: 'new-inc', rev: 0 } } })
  state.apply(restart)
  assert.equal(state.epoch, 'host')
  state.apply(restart, true)
  assert.equal(state.epoch, 'new'); assert.equal(state.summaries.size, 0)
  state.apply(summary(200)); state.apply(full(300))
  assert.equal(state.summaries.size, 0); assert.equal(state.registry.cursor.app_uuid, 'new-app')
})

test('an app identity change in one epoch clears state and requests reconnect', () => {
  const state = connected()
  state.apply(summary(3))
  const replaced = registry(0)
  replaced.cursor.incarnation = 'replacement'
  assert.equal(state.apply(replaced), false)
  assert.equal(state.epoch, null); assert.equal(state.registry, null)
  assert.equal(state.summaries.size, 0)
})

test('only matching active registry identities expose summaries and notices', () => {
  const state = connected()
  state.apply(summary(3)); state.apply(notice(4))
  assert.deepEqual(state.summary(org), { name: 'old' })
  assert.equal(state.summary({ ...org, org_uuid: 'other' }), null)
  state.apply(registry(11, [{ ...org, state: 'unavailable' }]))
  assert.equal(state.summary({ ...org, state: 'unavailable' }), null)
  assert.deepEqual(state.allNotices(), [])
})
