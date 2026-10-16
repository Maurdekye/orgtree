import { flush } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { startEpic, type Kind } from '../src/epic/director'
import type { UsageLimit } from '../src/types'
import './epicmode-fakes'

const window = (group: string, percent: number | null, kind = 'session'): UsageLimit =>
  ({ kind, group, percent, label: null, model: null, severity: null, resets_at: null, is_active: null })
const reading = (limits: UsageLimit[], extra = {}) =>
  ({ available: true, provider: 'google', limits, age: 0, ...extra })
let epochs = 0

/** Exercise the director through the real cache-only app feed. No provider calls. */
async function feed(initial: Record<string, unknown>) {
  const global = globalThis as unknown as { fetch: typeof fetch; WebSocket: unknown }
  const before = { fetch: global.fetch, WebSocket: global.WebSocket }
  const sockets: Socket[] = []
  class Socket {
    onmessage: ((e: { data: string }) => void) | null = null
    onclose: (() => void) | null = null
    onerror: (() => void) | null = null
    constructor() { sockets.push(this) }
    close() { this.onclose?.() }
    frame(value: unknown) { this.onmessage?.({ data: JSON.stringify(value) }) }
  }
  const epoch = `epic-usage-regression-${++epochs}`
  let seq = 1
  const values = (input: Record<string, unknown>) => Object.fromEntries(
    Object.entries(input).map(([key, value]) => [key, { epoch, seq, value }]))
  const copy = { type: 'app_snapshot', epoch, seq,
    registry: { type: 'registry_snapshot', epoch, cursor: { app_uuid: 'a', incarnation: 'i', rev: 1 }, records: [] },
    summaries: {}, notices: {}, runtime: { values: values(initial), orgs: {} } }
  global.WebSocket = Socket
  global.fetch = (async () => new Response(JSON.stringify(copy), { status: 200,
    headers: { 'Content-Type': 'application/json' } })) as typeof fetch
  const show = startEpic({ audio: null, greet: 'none' })
  const effects: Kind[] = []
  const cue = show.cue.bind(show)
  show.cue = (kind, ev) => { effects.push(kind); cue(kind, ev) }
  await flush(10)
  assert.equal(sockets.length, 1)
  sockets[0]!.frame(copy)
  await flush(5)
  return {
    effects, show,
    async push(input: Record<string, unknown>) {
      seq++
      sockets[0]!.frame({ type: 'app_runtime', epoch, seq, values: values(input) })
      await flush(3)
    },
    async stop() {
      seq++
      sockets[0]!.frame({ type: 'app_runtime', epoch, seq, values: values(Object.fromEntries(
        ['usage_peek', 'codex_usage_peek', 'antigravity_usage_peek', 'muse_usage_peek',
          'openrouter_usage_peek', 'openrouter_keys_usage', 'usage', 'codex_usage',
          'antigravity_usage', 'muse_usage'].map(key => [key, null]))) })
      await flush(3)
      show.stop()
      Object.assign(global, before)
    },
  }
}

test('same-kind Google windows keep separate baselines through repeats, reorder and real crossings', async () => {
  const gemini = window('gemini-5h', 0), claude = window('claude-gpt-5h', 100)
  const weekly = [window('gemini-weekly', 82, 'weekly_scoped'), window('claude-gpt-weekly', 50, 'weekly_scoped')]
  const both = (rows: UsageLimit[]) => ({ antigravity_usage_peek: reading(rows) })
  const f = await feed(both([gemini, claude, ...weekly]))
  try {
    assert.equal(f.show.staged, 0, 'first readings only establish each window baseline')
    for (let i = 0; i < 3; i++) {
      await f.push(both([gemini, claude, ...weekly]))
      await f.push(both([...weekly].reverse().concat([claude, gemini])))
    }
    assert.deepEqual(f.effects, [], 'unchanged windows never play max/reset effects')
    await f.push(both([{ ...gemini, percent: 90 }, claude, ...weekly]))
    await f.push(both([{ ...gemini, percent: 90 }, claude, ...weekly]))
    await f.push(both([{ ...gemini, percent: 100 }, claude, ...weekly]))
    await f.push(both([{ ...gemini, percent: 100 }, claude, ...weekly]))
    await f.push(both([{ ...gemini, percent: 0 }, claude, ...weekly]))
    await f.push(both([gemini, claude, ...weekly]))
    assert.deepEqual(f.effects, ['usageWarn', 'usageMax', 'usageReset'])
  } finally { await f.stop() }
})

test('unavailable, stale and missing windows leave the last valid baseline intact', async () => {
  const row = window('gemini-5h', 80)
  const val = (limits: UsageLimit[], extra = {}) => ({ antigravity_usage_peek: reading(limits, extra) })
  const f = await feed(val([row]))
  try {
    await f.push(val([{ ...row, percent: 100 }], { available: false }))
    await f.push(val([{ ...row, percent: 100 }], { age: 900 }))
    await f.push(val([{ ...row, percent: null }]))
    await f.push(val([]))
    await f.push({ antigravity_usage_peek: null })
    assert.deepEqual(f.effects, [], 'unknown readings trigger nothing')
    await f.push(val([{ ...row, percent: 100 }]))
    assert.deepEqual(f.effects, ['usageMax'], 'returning valid reading crosses the retained baseline')
    await f.push(val([{ ...row, percent: 0 }], { available: false }))
    await f.push(val([{ ...row, percent: 100 }]))
    assert.deepEqual(f.effects, ['usageMax'], 'an outage never fabricates a reset or a later max')
  } finally { await f.stop() }
})

test('account identity separates host sign-ins and OpenRouter keys sharing a window', async () => {
  const row = window('credits', 0, 'usage')
  const account = (id: string, percent: number) => reading([{ ...row, percent }],
    { account: id, provider: 'openrouter', observed_at: new Date().toISOString() })
  const f = await feed({
    antigravity_usage: reading([window('5h', 0)], { account: 'google-a', email: 'a@example.invalid' }),
    antigravity_usage_peek: reading([window('5h', 0)]),
    openrouter_keys_usage: { a: account('a', 0), b: account('b', 100) },
    openrouter_usage_peek: reading([row, { ...row, percent: 100 }], { provider: 'openrouter' }),
  })
  try {
    assert.equal(f.show.staged, 0)
    await f.push({ openrouter_keys_usage: { b: account('b', 100), a: account('a', 0) } })
    assert.deepEqual(f.effects, [])
    await f.push({ antigravity_usage: reading([window('5h', 100)], { account: 'google-b', email: 'b@example.invalid' }) })
    await f.push({ antigravity_usage_peek: reading([window('5h', 100)]) })
    assert.deepEqual(f.effects, [], 'a different login establishes its own baseline')
    await f.push({ antigravity_usage: reading([window('5h', 0)], { account: 'google-a', email: 'a@example.invalid' }),
      antigravity_usage_peek: reading([window('5h', 0)]) })
    await f.push({ antigravity_usage: reading([window('5h', 100)], { account: 'google-a', email: 'a@example.invalid' }) })
    assert.deepEqual(f.effects, [], 'a raw update waits for its matching peek')
    await f.push({ antigravity_usage_peek: reading([window('5h', 100)]) })
    assert.deepEqual(f.effects, ['usageMax'], 'a real host-account crossing plays once')
    await f.push({ openrouter_keys_usage: { a: account('a', 100), b: account('b', 100) } })
    await f.push({ openrouter_keys_usage: { a: account('a', 100), b: account('b', 100) } })
    assert.deepEqual(f.effects, ['usageMax', 'usageMax'], 'only accounts whose windows crossed play effects')
  } finally { await f.stop() }
})

test('expired peek projections and stale named-account observations never replace valid baselines', async () => {
  const row = window('window', 80)
  const f = await feed({ muse_usage: reading([row], { account: 'muse-a' }), muse_usage_peek: reading([row]),
    openrouter_keys_usage: { a: reading([row], { account: 'a', provider: 'openrouter' }) } })
  try {
    await f.push({ muse_usage: reading([{ ...row, percent: 100 }], { account: 'muse-a' }),
      muse_usage_peek: reading([{ ...row, percent: null }]) })
    await f.push({ openrouter_keys_usage: { a: reading([{ ...row, percent: 100 }],
      { account: 'a', provider: 'openrouter', observed_at: new Date(Date.now() - 901_000).toISOString() }) } })
    assert.deepEqual(f.effects, [])
    await f.push({ muse_usage_peek: reading([{ ...row, percent: 100 }]) })
    await f.push({ openrouter_keys_usage: { a: reading([{ ...row, percent: 100 }],
      { account: 'a', provider: 'openrouter', observed_at: new Date().toISOString() }) } })
    assert.deepEqual(f.effects, ['usageMax', 'usageMax'])
  } finally { await f.stop() }
})
