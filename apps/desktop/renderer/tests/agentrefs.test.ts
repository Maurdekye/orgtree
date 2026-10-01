import test from 'node:test'
import assert from 'node:assert/strict'
import { FOREGROUND_TREE_FORMAT as format, ForegroundTreeReader } from '../src/foregroundtree'
import type { ForegroundReferences } from '../src/foregroundtree'
import { AgentReferences } from '../src/agentrefs'
import { actorFit, itemActorIds } from '../src/canvas/docket'
import type { NodeFacts } from '../src/canvas/docket'
import type { TreePayload, WorkItem } from '../src/types'

const response = (body: unknown, status = 200): Response => ({
  status, ok: status >= 200 && status < 300, headers: new Headers(), json: async () => body,
} as Response)
const legacy = async () => ({ slug: 'org', roots: [] }) as unknown as TreePayload
const ref = (id: string, state = 'archived') => ({ id, tier: 'astra', state, generation: 2,
  axis: 'org' as const, successor: null })
const answer = (catalog: string, found: string[], missing: string[]): ForegroundReferences => ({
  format, kind: 'references', revision: 'r', catalog_revision: catalog, org_rev: 1, sync_rev: 1,
  references: Object.fromEntries(found.map(id => [id, ref(id)])), missing })
const settle = () => new Promise(resolve => setTimeout(resolve, 0))

test('references use the exact landed route and refuse an answer that does not match the request', async () => {
  const paths: string[] = []
  const replies = [response(answer('org:1', ['a/x'], ['b'])), response(answer('org:1', ['a/x'], []))]
  const reader = new ForegroundTreeReader(async path => { paths.push(path); return replies.shift()! }, legacy)
  const got = await reader.references('org', ['a/x', 'b', 'a/x'])
  assert.deepEqual(Object.keys(got.references), ['a/x'])
  assert.deepEqual(got.missing, ['b'])
  assert.equal(paths[0], '/api/orgs/org/foreground-tree/references?include=a%2Fx&include=b')
  await assert.rejects(reader.references('org', ['a/x', 'b']), /do not match/)
  await assert.rejects(reader.references('org', []), /1-128/)
  await assert.rejects(reader.references('org', Array.from({ length: 129 }, (_, n) => 'n' + n)), /1-128/)
})

test('cache batches at 128, answers only for its catalog, and never turns a failure into absence', async () => {
  const batches: string[][] = []
  let fail = false
  const refs = new AgentReferences(async (_org, ids) => {
    batches.push([...ids])
    if (fail) throw new Error('offline')
    return answer('org:1', ids.filter(id => id !== 'gone'), ids.filter(id => id === 'gone'))
  })
  let heard = 0
  refs.subscribe(() => { ++heard })
  const ids = Array.from({ length: 130 }, (_, n) => 'a' + n).concat('gone')
  refs.request('org', 'org:1', ids)
  refs.request('org', 'org:1', ids)   // in flight: no duplicate read
  await settle()
  assert.deepEqual(batches.map(b => b.length), [128, 3])
  assert.ok(heard >= 2)
  const found = refs.get('org', 'org:1', 'a0')
  assert.ok(found && 'ref' in found && found.ref?.state === 'archived')
  const gone = refs.get('org', 'org:1', 'gone')
  assert.ok(gone && 'ref' in gone && gone.ref === null)
  assert.equal(refs.get('org', 'org:2', 'a0'), undefined, 'another catalog is not answered')
  refs.request('org', 'org:1', ['a0'])
  await settle()
  assert.equal(batches.length, 2, 'answered IDs are not re-read for the same catalog')
  fail = true
  refs.request('org', 'org:2', ['x'])
  await settle()
  const failed = refs.get('org', 'org:2', 'x')
  assert.ok(failed && 'error' in failed)
})

test('an answer read from a newer catalog is not served to an older tree', async () => {
  const refs = new AgentReferences(async (_org, ids) => answer('org:2', [...ids], []))
  refs.request('org', 'org:1', ['a'])
  await settle()
  const older = refs.get('org', 'org:1', 'a')
  assert.ok(older && 'stale' in older && !('ref' in older), 'the older tree gets no answer, only a do-not-re-ask marker')
  assert.ok(refs.get('org', 'org:2', 'a'))
})

test('the cache stays bounded per org and across orgs', async () => {
  const refs = new AgentReferences(async (_org, ids) => answer('c', [...ids], []), 4)
  refs.request('org', 'c', ['a', 'b', 'c', 'd', 'e', 'f'])
  await settle()
  assert.equal(refs.get('org', 'c', 'a'), undefined)
  assert.ok(refs.get('org', 'c', 'f'))
  for (let n = 0; n < 9; ++n) refs.request('org' + n, 'c', ['x'])
  await settle()
  assert.equal(refs.get('org0', 'c', 'x'), undefined, 'oldest org evicted')
  assert.ok(refs.get('org8', 'c', 'x'))
})

test('an unresolved omitted agent is never reported gone', () => {
  const facts = new Map<string, NodeFacts>([
    ['pending', { tier: '', generation: 0, live: false, unresolved: true }],
    ['old', { tier: 'astra', generation: 2, live: false }]])
  const actor = (node: string) => ({ node, generation: 1 })
  assert.equal(actorFit(actor('pending'), facts).fit, 'unknown')
  assert.equal(actorFit(actor('old'), facts).fit, 'retired')
  assert.equal(actorFit(actor('never'), facts).fit, 'gone')
  const items = [{ owner: actor('o'), reviewer: actor('r'), last_updater: null, created_by: 'user' },
    { owner: actor('o'), reviewer: null, last_updater: actor('u'), created_by: actor('c') }] as unknown as WorkItem[]
  assert.deepEqual(itemActorIds(items), ['c', 'o', 'r', 'u'])
})

test('an answer for a newer catalog is remembered as asked: no re-request while the tree lags (review f3)', async () => {
  let reads = 0
  const refs = new AgentReferences(async (_org, ids) => { reads++; return answer('server-new', [...ids], []) })
  refs.request('org', 'tree-old', ['a'])
  await settle()
  const lagging = refs.get('org', 'tree-old', 'a')
  assert.ok(lagging && 'stale' in lagging, 'the lagging tree sees a stale marker, not nothing')
  for (let n = 0; n < 50; ++n) refs.request('org', 'tree-old', ['a'])
  await settle()
  assert.equal(reads, 1, 'the same id is not re-asked for the same lagging catalog')
  const caught = refs.get('org', 'server-new', 'a')
  assert.ok(caught && 'ref' in caught && caught.ref, 'once the tree reaches that catalog the answer serves it')
  refs.request('org', 'tree-newer-still', ['a'])
  await settle()
  assert.equal(reads, 2, 'a genuinely different catalog asks again')
})
