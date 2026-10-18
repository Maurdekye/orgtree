import { mountView, inAct, flush } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { CurrentOrg } from '../src/popout'
import { BulkCompactConfirm, cheapCompactAgents, planBulkCompact } from '../src/canvas/bulkcompact'
import { agentMenuEntries } from '../src/canvas/agentmenu'
import type { CanvasNode, OpFn } from '../src/canvas/shared'

const noop = () => {}
const agent = (id: string, extra: Partial<CanvasNode> = {}): CanvasNode => ({
  id, state: 'live', tier: 'sonnet', children: [], session_id: 'session-' + id,
  occupancy: 40000, context_window: 200000, ...extra,
} as CanvasNode)
const response = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } })
let actionType = 'cheap'
const oldFetch = globalThis.fetch
test.beforeEach(() => { actionType = 'cheap'; globalThis.fetch = (async () => response({ supported: true, reason: null })) as typeof fetch })
test.afterEach(() => { globalThis.fetch = oldFetch })
const modal = (targets: CanvasNode[], op: OpFn, said: string[][] = [], close = noop) =>
  <CurrentOrg.Provider value="bulk-org"><BulkCompactConfirm title="Compact subtree?" scope="subtree of lead"
    targets={targets} op={op} toast={lines => { if (lines) said.push(lines) }} close={close} /></CurrentOrg.Provider>
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]')!
const go = () => [...dialog().querySelectorAll<HTMLButtonElement>('button')]
  .find(b => b.textContent?.startsWith(actionType === 'cheap' ? 'cheap-compact ' : 'compact '))!
const ready = async (value: string) => {
  actionType = value
  await inAct(async () => { await flush(4) })
  assert.ok(go(), `the ${value} action is offered`)
}

test('shared agent and project bulk entries use plain Compact wording', () => {
  const handlers = { onInbox: noop, onSettings: noop, onRetireAsk: noop }
  const lead = agent('lead', { children: [agent('kid')] })
  const entries = agentMenuEntries(lead, handlers).filter(e => e !== 'sep')
  const compact = entries.find(e => e.label === 'Compact\u2026')!
  assert.deepEqual(compact.children?.map(e => e.label), ['Compact subtree\u2026', 'Compact all subordinates\u2026'])
  const project = agentMenuEntries(agent('project', { kind: 'project', children: [agent('kid')] }), handlers)
    .filter(e => e !== 'sep')
  assert.equal(project.some(e => e.label === 'Compact all agents under it\u2026'), true)
})

test('both action previews name agents/skips; opening only reads Normal support and never compacts', async () => {
  const ops: unknown[] = [], gets: string[] = []
  globalThis.fetch = (async url => { gets.push(String(url)); return response({ supported: true }) }) as typeof fetch
  const view = await mountView(modal([agent('one'), agent('busy', { busy: true })], async b => { ops.push(b); return {} as never }), el => el)
  try {
    assert.match(dialog().textContent ?? '', /one/)
    assert.match(dialog().textContent ?? '', /busy.*mid-turn/)
    await ready('cheap')
    assert.equal(dialog().querySelector('input[type="radio"]') === null, true)
    assert.equal(go().disabled, false)
    assert.equal(dialog().querySelectorAll('[data-compact-preview]').length, 2)
    assert.deepEqual(ops, []); assert.equal(gets.length, 1)
  } finally { await view.unmount() }
})

test('Cancel sends no compaction request', async () => {
  let closes = 0
  const ops: unknown[] = []
  const view = await mountView(modal([agent('one')], async b => { ops.push(b); return {} as never }, [], () => { closes++ }), el => el)
  try {
    const cancel = [...dialog().querySelectorAll('button')].find(b => b.textContent === 'cancel')!
    await inAct(() => cancel.click())
    assert.equal(closes, 1); assert.deepEqual(ops, [])
  } finally { await view.unmount() }
})

test('confirming Cheap directly preserves sequential if_idle operations and busy skips', async () => {
  const ops: unknown[] = []
  const view = await mountView(modal([agent('one'), agent('busy', { busy: true }), agent('two')], async b => { ops.push(b); return {} as never }), el => el)
  try {
    assert.deepEqual(ops, [])
    await inAct(async () => { go().click(); await flush(4) })
    assert.deepEqual(ops, [{ op: 'cheap_compact', node: 'one', if_idle: true }, { op: 'cheap_compact', node: 'two', if_idle: true }])
  } finally { await view.unmount() }
})

test('Normal preview skips unsupported, sessionless, busy and unreadable seats; refusal is not completion or cheap fallback', async () => {
  const ops: unknown[] = [], posts: string[] = [], said: string[][] = []
  globalThis.fetch = (async (url, init) => {
    const id = decodeURIComponent(String(url).split('/nodes/')[1]!.split('/')[0]!)
    if (init?.method === 'POST') { posts.push(id); return response(id === 'one' ? { started: true } : { started: false, reason: 'turn started before admission' }) }
    if (id === 'unreadable') throw new Error('capability read unavailable')
    return response(id === 'unsupported' ? { supported: false, reason: 'Codex cannot normal compact' } : { supported: true })
  }) as typeof fetch
  const targets = [agent('one'), agent('two'), agent('unsupported'), agent('sessionless', { session_id: null }), agent('unreadable'), agent('busy', { busy: true })]
  const view = await mountView(modal(targets, async b => { ops.push(b); return {} as never }, said), el => el)
  try {
    await ready('normal')
    const text = dialog().textContent ?? ''
    assert.match(text, /2 agents/)
    for (const word of ['one', 'two', 'unsupported', 'Codex', 'sessionless', 'session', 'unreadable', 'capability read unavailable', 'busy', 'mid-turn']) assert.ok(text.includes(word), word)
    assert.deepEqual(posts, []); assert.deepEqual(ops, [])
    await inAct(async () => { go().click(); await flush(5) })
    assert.deepEqual(posts, ['one', 'two']); assert.deepEqual(ops, [])
    const summary = said.flat().join('\n')
    assert.match(summary, /Started normal compaction.*one/)
    assert.match(summary, /Refused.*two.*turn started before admission/)
    assert.doesNotMatch(summary, /Completed normal|Normal-compacted/)
  } finally { await view.unmount() }
})

test('Normal cannot confirm while capability is pending; Cheap remains available', async () => {
  let release!: (v: Response) => void
  const gate = new Promise<Response>(resolve => { release = resolve })
  const posts: string[] = []
  globalThis.fetch = (async (url, init) => { if (init?.method === 'POST') posts.push(String(url)); return gate }) as typeof fetch
  const view = await mountView(modal([agent('one')], async () => ({} as never)), el => el)
  try {
    await ready('normal')
    assert.equal(go().disabled, true)
    assert.match(dialog().textContent ?? '', /checking/i)
    await ready('cheap'); assert.equal(go().disabled, false)
    assert.deepEqual(posts, [])
  } finally { release(response({ supported: true })); await inAct(async () => { await flush(2) }); await view.unmount() }
})

test('all-unsupported Normal action cannot execute, and Cheap requires its own button click', async () => {
  let ops = 0
  globalThis.fetch = (async () => response({ supported: false, reason: 'Unsupported harness' })) as typeof fetch
  const view = await mountView(modal([agent('one')], async () => { ops++; return {} as never }), el => el)
  try {
    await ready('normal'); assert.equal(go().disabled, true)
    await inAct(() => go().click()); assert.equal(ops, 0)
    await ready('cheap'); assert.equal(go().disabled, false)
    await inAct(async () => { go().click(); await flush(4) }); assert.equal(ops, 1)
  } finally { await view.unmount() }
})

test('a running Cheap batch prevents overlapping Normal execution', async () => {
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const first = cheapCompactAgents('first', planBulkCompact([agent('first')]), async () => { await gate; return {} as never }, noop)
  let posts = 0
  globalThis.fetch = (async (_url, init) => { if (init?.method === 'POST') posts++; return response({ supported: true, started: true }) }) as typeof fetch
  const said: string[][] = []
  const view = await mountView(modal([agent('one')], async () => ({} as never), said), el => el)
  try {
    await ready('normal'); await inAct(async () => { go().click(); await flush(3) })
    assert.equal(posts, 0); assert.match(said.flat().join(' '), /already running/)
  } finally { release(); await first; await view.unmount() }
})


test('Normal waits for each admission and continues after a transport failure', async () => {
  let release!: (v: Response) => void
  const first = new Promise<Response>(resolve => { release = resolve })
  const posts: string[] = [], said: string[][] = []
  globalThis.fetch = (async (url, init) => {
    const id = String(url).split('/nodes/')[1]!.split('/')[0]!
    if (init?.method !== 'POST') return response({ supported: true })
    posts.push(id)
    if (id === 'one') return first
    if (id === 'two') throw new Error('network down')
    return response({ started: true })
  }) as typeof fetch
  const view = await mountView(modal([agent('one'), agent('two'), agent('three')], async () => { throw new Error('Cheap fallback must never run') }, said), el => el)
  try {
    await ready('normal')
    await inAct(async () => { go().click(); await flush(2) })
    assert.deepEqual(posts, ['one'], 'next admission waits for the first response')
    await inAct(async () => { release(response({ started: true })); await flush(5) })
    assert.deepEqual(posts, ['one', 'two', 'three'])
    const summary = said.flat().join(' ')
    assert.match(summary, /Started normal compaction.*one, three/)
    assert.match(summary, /Could not request normal compaction.*two.*network down/)
  } finally {
    release(response({ started: true })); await inAct(async () => { await flush(2) }); await view.unmount()
  }
})
