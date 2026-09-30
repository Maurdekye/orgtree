// bootgate.test.tsx — an org window asks for its tree before its side
// readouts (docket v3-opening-the-window-for-a-large-org-orgtree-is).
//
// Measured on a copy of the orgtree org: the window's first render fired
// /api/providers, four /api/*/usage/peek readouts and /api/host — six
// requests, the browser's per-origin connection limit — and the tree read
// queued behind them until /api/providers answered (1.4 s typical live, up to
// 25 s). bootgate.ts now holds those six until the first tree read settles.
//
//   §1 the gate alone: held until opened, then every call goes through
//   §2 the gate's cap opens it even if no tree read ever settles
//   §3 App: while the tree read is outstanding none of the six has been
//      requested; once it answers, all six are
//   §4 App: a failed tree read opens the gate too
//
// Run:  cd apps/desktop/renderer && node tests/run.mjs bootgate
import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import App from '../src/App'
import { afterBootGate, BOOT_DEFER_MAX_MS, openBootGate, resetBootGate } from '../src/bootgate'
import { resetConvos } from '../src/convo'
import { FOREGROUND_TREE_FORMAT as format } from '../src/foregroundtree'

const tick = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

test('§1 a held fetch waits for the gate, and later calls do not wait', async () => {
  resetBootGate()
  let calls = 0
  const held = afterBootGate(async () => ++calls)
  const first = held()
  await tick(20)
  assert.equal(calls, 0, 'nothing is fetched while the gate is closed')
  openBootGate()
  assert.equal(await first, 1)
  assert.equal(await held(), 2, 'an open gate passes calls straight through')
  resetBootGate()
})

test('§2 the cap opens the gate when no tree read settles', async () => {
  resetBootGate()
  let calls = 0
  const started = Date.now()
  await afterBootGate(async () => ++calls)()
  const waited = Date.now() - started
  assert.equal(calls, 1)
  assert.ok(waited >= BOOT_DEFER_MAX_MS - 50 && waited < BOOT_DEFER_MAX_MS + 1500,
    `released by the cap after ${waited} ms`)
  resetBootGate()
})

const SIDE = ['/api/providers', '/api/usage/peek', '/api/codex/usage/peek',
  '/api/antigravity/usage/peek', '/api/openrouter/usage/peek', '/api/host']

async function openWindow(treeAnswer: 'ok' | 'fail') {
  const org = 'boot-gate-fixture'
  const agent = { id: 'agent', title: 'Agent', generation: 1, state: 'live', tier: 'haiku',
    model_id: 'haiku', seat: 1, grant: 0, free: 0, parent: null, children: [],
    turns: [], audiences_held: [], documents: [], mail_pending: 0,
    scope: { tools: {}, add_dirs: [], permission_mode: 'default', org_visibility: 'team' },
    axis: 'org', hidden_retired_children: 0, lineage_loaded: false, lineage_count: 0,
    predecessor: null, successor: null }
  const header = { slug: org, name: org, tiers: { haiku: 1 }, dirs: [],
    max_top_grant: 1000, default_top_grant: 50, compact_at: 0, credit_requests: [],
    audience_requests: [], audiences: [], asks: [], asks_open: 0, watchdogs: [],
    audit: { live_nodes: 1, top_level_holds: 1, no_overdraft: true, problems: [] },
    user_inbox_count: 0, org_inbox: null, net: null, epoch: 1, rev: 1,
    work_items_summary: { attention: 0, active: 0 }, hidden_retired_roots: 0, retired_total: 0 }
  const globals = globalThis as unknown as Record<string, unknown>
  const saved = { fetch: globals.fetch, socket: globals.WebSocket, history: globals.history,
    customEvent: globals.CustomEvent }
  const asked: string[] = []
  let answerTree: (() => void) | null = null
  const treeHeld = new Promise<void>(resolve => { answerTree = resolve })
  class Socket {
    readyState = 1
    onmessage: ((event: { data: string }) => void) | null = null
    close() { this.readyState = 3 }
  }
  const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
    status, headers: { 'Content-Type': 'application/json' },
  })
  globals.fetch = async (input: unknown) => {
    const path = new URL(String(input), window.location.origin).pathname
    asked.push(path)
    if (path === '/api/orgs') return json([{ slug: org, name: org, live: 1, seats: 1 }])
    if (path === `/api/orgs/${org}/foreground-tree`) {
      await treeHeld
      if (treeAnswer === 'fail') return json({ detail: 'engine busy' }, 503)
      return json({ format, kind: 'snapshot', revision: 'r1',
        catalog_revision: 'c1', org_rev: 1, sync_rev: 0, nodes: { agent }, roots: ['agent'],
        missing_requested: [], header })
    }
    if (path === '/api/providers') return json({ providers: [] })
    if (path === '/api/host') return json({ build: null })
    if (path.endsWith('/usage/peek')) return json({ ok: false })
    return json({ ok: true })
  }
  globals.WebSocket = Socket
  globals.history = window.history
  globals.CustomEvent = window.CustomEvent
  localStorage.clear(); resetConvos(); resetBootGate()
  window.history.replaceState(null, '', `/o/${org}`)
  const view = await mountView(<App />, el => el)
  const wait = (ms: number) => inAct(async () => { await tick(ms); await flush(20) })
  const restore = async () => {
    await view.unmount(); resetConvos(); localStorage.clear(); resetBootGate()
    window.history.replaceState(null, '', '/')
    globals.fetch = saved.fetch; globals.WebSocket = saved.socket; globals.history = saved.history
    globals.CustomEvent = saved.customEvent
  }
  return { org, asked, wait, restore, answer: () => answerTree!() }
}

test('§3 the tree read goes out first; the side readouts follow its answer', async () => {
  const w = await openWindow('ok')
  try {
    await w.wait(300)
    assert.ok(w.asked.includes(`/api/orgs/${w.org}/foreground-tree`), 'the tree was read on mount')
    const early = SIDE.filter(p => w.asked.includes(p))
    assert.deepEqual(early, [], `requested while the tree read was outstanding: ${early.join(', ')}`)
    w.answer()
    await w.wait(300)
    const missing = SIDE.filter(p => !w.asked.includes(p))
    assert.deepEqual(missing, [], `never requested after the tree answered: ${missing.join(', ')}`)
  } finally { await w.restore() }
})

test('§4 a failed tree read releases the side readouts too', async () => {
  const w = await openWindow('fail')
  try {
    await w.wait(300)
    assert.deepEqual(SIDE.filter(p => w.asked.includes(p)), [])
    w.answer()
    await w.wait(300)
    const missing = SIDE.filter(p => !w.asked.includes(p))
    assert.deepEqual(missing, [], `never requested after the tree failed: ${missing.join(', ')}`)
  } finally { await w.restore() }
})
