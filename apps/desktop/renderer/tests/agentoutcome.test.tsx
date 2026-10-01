// agentoutcome.test.tsx — canonical agent references on a SELECTED tree:
// omission is not absence. Only the backend's explicit `missing` (in the
// snapshot or an exact reference answer) may call an agent absent.
//
// Run:  cd apps/desktop/renderer && node tests/run.mjs agentoutcome

// ⚠ THE HARNESS IMPORT COMES FIRST — see the import-order note in harness.ts.
import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { ForegroundViewContext, resolveRef, useRefRoutes } from '../src/canvas/reflinks'
import { actorFit, notAgentShaped, proseCandidates, useNodeFacts, useProseAgentIndex } from '../src/canvas/docket'
import type { NodeFacts } from '../src/canvas/docket'
import type { MentionIndex } from '../src/canvas/workrefs'
import type { RefRoutes } from '../src/canvas/reflinks'
import { FOREGROUND_TREE_FORMAT as format } from '../src/foregroundtree'
import type { TreePayload } from '../src/types'

const agent = (id: string) => ({ kind: 'agent' as const, org: 'org', id })
const nodeBox = (node: string) => ({ kind: 'mail' as const, org: 'org', box: 'node' as const, node, id: 'm1' })

function stubReferences(t: TestContext, found: string[], fail = false): string[][] {
  const asked: string[][] = []
  const had = (globalThis as { fetch?: typeof fetch }).fetch;
  (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (url: string) => {
    const query = new URL(String(url), 'http://x').searchParams.getAll('include')
    asked.push(query)
    if (fail) return { ok: false, status: 503, headers: new Headers(), json: async () => ({ detail: 'down' }) }
    const body = { format, kind: 'references', revision: 'r', catalog_revision: 'cat-' + t.name,
      org_rev: 1, sync_rev: 1,
      references: Object.fromEntries(query.filter(id => found.includes(id)).map(id => [id,
        { id, tier: 'astra', state: 'archived', generation: 1, axis: 'org', successor: null }])),
      missing: query.filter(id => !found.includes(id)) }
    return { ok: true, status: 200, headers: new Headers(), json: async () => body }
  }) as unknown as typeof fetch
  t.after(() => { (globalThis as { fetch?: typeof fetch }).fetch = had })
  return asked
}

async function mountWorld(t: TestContext, view: TreePayload['foreground']) {
  let routes: RefRoutes | null = null
  function Probe() {
    routes = useRefRoutes('org', new Map([['live', {}]]), { onFocusAgent: () => {}, onOpenMail: () => {}, view })
    return null
  }
  const v = await mountView(<Probe />, h => h)
  t.after(() => v.unmount())
  return () => routes!.world
}

test('a selected tree looks up omitted agents and never calls them absent on a guess', async (t) => {
  const asked = stubReferences(t, ['old'])
  const world = await mountWorld(t, { catalog_revision: 'cat-' + t.name,
    present: ['live', 'lineage-only'], missing: ['erased'] })
  assert.equal(resolveRef(agent('live'), world()).outcome, 'ready')
  assert.equal(resolveRef(agent('lineage-only'), world()).outcome, 'ready', 'an off-axis row is present')
  assert.equal(resolveRef(agent('erased'), world()).outcome, 'absent', 'explicit snapshot absence is final')
  assert.equal(resolveRef(agent('old'), world()).outcome, 'pending', 'omitted: looked up, not absent')
  assert.equal(resolveRef(nodeBox('never'), world()).outcome, 'pending')
  await inAct(async () => { await flush(4) })
  assert.deepEqual(asked.flat().sort(), ['never', 'old'], 'only omitted identities were asked for')
  assert.equal(resolveRef(agent('old'), world()).outcome, 'ready')
  assert.equal(resolveRef(nodeBox('never'), world()).outcome, 'absent', 'the exact answer said missing')
  assert.equal(asked.length, 1, 'one batched read')
})

test('a failed lookup stays pending rather than absent', async (t) => {
  stubReferences(t, [], true)
  const world = await mountWorld(t, { catalog_revision: 'c', present: [], missing: [] })
  assert.equal(resolveRef(agent('old'), world()).outcome, 'pending')
  await inAct(async () => { await flush(4) })
  assert.equal(resolveRef(agent('old'), world()).outcome, 'pending')
})

test('a complete legacy tree keeps its authoritative map judgement and asks nothing', async (t) => {
  const asked = stubReferences(t, ['old'])
  const world = await mountWorld(t, undefined)
  assert.equal(resolveRef(agent('old'), world()).outcome, 'absent')
  assert.equal(resolveRef(nodeBox('old'), world()).outcome, 'absent')
  await inAct(async () => { await flush(4) })
  assert.equal(asked.length, 0)
})

async function mountIndex(t: TestContext, view: TreePayload['foreground'], source: unknown, base: MentionIndex) {
  let index: MentionIndex | null = null
  function Probe() { index = useProseAgentIndex('org', source, base); return null }
  const v = await mountView(<ForegroundViewContext.Provider value={view}><Probe /></ForegroundViewContext.Provider>, h => h)
  t.after(() => v.unmount())
  return () => index!
}

test('bare names in prose resolve omitted agents in a bounded lookup; items keep the collision', async (t) => {
  const asked = stubReferences(t, ['old-agent', 'shared-name'])
  const base: MentionIndex = new Map([['shared-name', { kind: 'item', slug: 'shared-name' }],
    ['live', { kind: 'agent', id: 'live', tier: 'haiku' }]])
  const item = { objective: 'ask old-agent about shared-name, not missing-one', notes: ['live erased'] }
  const index = await mountIndex(t, { catalog_revision: 'cat-' + t.name, present: ['live'], missing: ['erased'] },
    item, base)
  await inAct(async () => { await flush(4) })
  const words = asked.flat()
  assert.ok(words.includes('old-agent') && words.includes('missing-one'))
  assert.ok(!words.includes('shared-name') && !words.includes('live') && !words.includes('erased'),
    'known items, known agents and explicit absences are not looked up')
  assert.deepEqual(index().get('old-agent'), { kind: 'agent', id: 'old-agent', tier: 'astra' })
  assert.equal(index().get('shared-name')?.kind, 'item', 'an item keeps winning a name collision')
  assert.equal(index().has('missing-one'), false)
})

test('a complete tree adds nothing and asks nothing; candidate scanning is bounded', async (t) => {
  const asked = stubReferences(t, ['old-agent'])
  const base: MentionIndex = new Map()
  const index = await mountIndex(t, undefined, { objective: 'old-agent' }, base)
  await inAct(async () => { await flush(4) })
  assert.equal(index(), base)
  assert.equal(asked.length, 0)
  const many = Array.from({ length: 1000 }, (_, n) => 'name' + n).join(' ')
  assert.equal(proseCandidates({ text: many }, () => false).length, 256)
  assert.equal(proseCandidates({ text: many }, () => false, 256, 50).length <= 10, true)
})

test('a tree older than the server catalog asks once and settles pending (review f3 regression)', async (t) => {
  const asked: string[][] = []
  const had = (globalThis as { fetch?: typeof fetch }).fetch;
  (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (url: string) => {
    const query = new URL(String(url), 'http://x').searchParams.getAll('include')
    asked.push(query)
    const body = { format, kind: 'references', revision: 'r', catalog_revision: 'server-' + t.name, org_rev: 2, sync_rev: 1,
      references: Object.fromEntries(query.map(id => [id,
        { id, tier: 'astra', state: 'archived', generation: 1, axis: 'org', successor: null }])), missing: [] }
    return { ok: true, status: 200, headers: new Headers(), json: async () => body }
  }) as unknown as typeof fetch
  let world: (() => ReturnType<typeof useRefRoutes>['world']) | null = null
  const view = { catalog_revision: 'tree-' + t.name, present: ['live'], missing: [] }
  function Probe() {
    const routes = useRefRoutes('org', new Map([['live', {}]]), { onFocusAgent: () => {}, view })
    world = () => routes.world
    resolveRef(agent('old'), routes.world)   // judged on every render, as prose does
    return null
  }
  const mounted = mountView(<Probe />, h => h)
  const settled = await Promise.race([mounted.then(() => true),
    new Promise<boolean>(resolve => setTimeout(() => resolve(false), 1000))])
  // an unsettled mount keeps its stub: restoring it would release the loop
  assert.equal(settled, true, 'the component settles while its tree lags the catalog')
  const v = await mounted
  t.after(async () => { await v.unmount(); (globalThis as { fetch?: typeof fetch }).fetch = had })
  await inAct(async () => { await flush(6) })
  assert.equal(asked.length, 1, 'one reference request, not a loop')
  assert.equal(resolveRef(agent('old'), world!()).outcome, 'pending', 'an answer about another catalog is not a verdict')
})

async function mountFacts(t: TestContext, catalog: string) {
  let facts: Map<string, NodeFacts> | null = null
  const tree = { slug: 'org', roots: [{ id: 'live', state: 'live', tier: 'haiku', generation: 0, children: [] }],
    foreground: { catalog_revision: catalog, present: ['live'], missing: [] } } as unknown as TreePayload
  const ids = ['live', 'old']
  function Probe() { facts = useNodeFacts('org', tree, ids); return null }
  const v = await mountView(<Probe />, h => h)
  t.after(() => v.unmount())
  await inAct(async () => { await flush(6) })
  return () => facts!
}

test('a failed or stale owner lookup stays unconfirmed in docket facts, never gone (review f7)', async (t) => {
  stubReferences(t, [], true)   // 503: the lookup fails
  const failed = await mountFacts(t, 'failed-' + t.name)
  assert.equal(failed().get('old')?.unresolved, true)
  assert.equal(actorFit({ node: 'old', generation: 0 }, failed()).fit, 'unknown', 'a failed lookup is not a gone actor')
})

test('an owner answered only for another catalog stays unconfirmed, never gone (review f7)', async (t) => {
  stubReferences(t, [])   // the server answers for its own catalog, not the tree's
  const lagging = await mountFacts(t, 'lagging-' + t.name)
  assert.equal(lagging().get('old')?.unresolved, true)
  assert.equal(actorFit({ node: 'old', generation: 0 }, lagging()).fit, 'unknown', 'a stale answer is not a gone actor')
})

test('prose lookup skips numbers, timestamp pieces and UUIDs, but keeps real names (including digits)', async (t) => {
  const text = 'At 2026-09-27T22:08:24.124Z the docket lock review window 08 went to worker-7 and coord-0; '
    + 'n1-review-astra saw retired-0019 and agent2, session 1e1b0558-3cc0-4480-acef-fcb43934e6ba, sha 26f8ed8'
  const got = proseCandidates({ objective: text }, () => false)
  for (const noise of ['2026-09-27T22', '08', '24', '124Z', '1e1b0558-3cc0-4480-acef-fcb43934e6ba']) {
    assert.ok(!got.includes(noise), `${noise} is not looked up`)
    assert.equal(notAgentShaped(noise), true)
  }
  for (const name of ['worker-7', 'coord-0', 'n1-review-astra', 'retired-0019', 'agent2', 'docket', '26f8ed8']) {
    assert.ok(got.includes(name), `${name} is still a candidate`)
  }
  const asked = stubReferences(t, ['worker-7', 'retired-0019'])
  const index = await mountIndex(t, { catalog_revision: 'cat-' + t.name, present: [], missing: [] },
    { objective: text }, new Map())
  await inAct(async () => { await flush(4) })
  const words = asked.flat()
  assert.ok(!words.some(w => notAgentShaped(w)), 'no number, timestamp or UUID reached the lookup')
  assert.deepEqual(index().get('worker-7'), { kind: 'agent', id: 'worker-7', tier: 'astra' }, 'a real name still resolves')
  assert.equal(index().get('retired-0019')?.kind, 'agent')
})
