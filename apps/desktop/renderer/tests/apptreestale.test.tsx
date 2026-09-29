// apptreestale.test.tsx — a user's own settings save re-reads the org tree AT
// ONCE, not after the tree pacer's gap (docket
// v3-changing-an-agent-s-model-does-not-show-at-on: the user changed an agent's
// model and the Attention view did not show it at once).
//
// Every view draws the agent from App's tree, and the Attention view repaints
// the moment a new tree lands (tests/attnmodel_probe.py measures that in a real
// browser). What waited was the READ: the settings dialog saves scope and
// account through direct routes, not App's `op`, so the new values arrived only
// with the server's `changed` frame, paced like background traffic. jsdom
// reports the page as hidden, so that pacing is TREE_HIDDEN_GAP_MS (10 s) here,
// which the control below proves is in force before the save is tried.
//
//   §1 with nothing saved, no read happens inside the gap (the control)
//   §2 saveScope resolving asks App for an urgent read, which runs at once
//   §3 so does assignAccount
//
// Run:  cd apps/desktop/renderer && node tests/run.mjs apptreestale
import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import App from '../src/App'
import { assignAccount, saveScope } from '../src/api'
import { resetConvos } from '../src/convo'
import { FOREGROUND_TREE_FORMAT as format } from '../src/foregroundtree'

test('a user\'s scope or account save re-reads the tree at once, not after the pacer\'s gap', async () => {
  const org = 'app-tree-stale-fixture'
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
  let reads = 0
  class Socket {
    readyState = 1
    onmessage: ((event: { data: string }) => void) | null = null
    close() { this.readyState = 3 }
  }
  const json = (value: unknown) => new Response(JSON.stringify(value), {
    headers: { 'Content-Type': 'application/json' },
  })
  globals.fetch = async (input: unknown) => {
    const url = new URL(String(input), window.location.origin)
    const path = url.pathname
    if (path === '/api/orgs') return json([{ slug: org, name: org, live: 1, seats: 1 }])
    if (path === `/api/orgs/${org}/foreground-tree`) {
      reads++
      return json({ format, kind: 'snapshot', revision: 'r' + reads,
        catalog_revision: 'c1', org_rev: 1, sync_rev: 0, nodes: { agent }, roots: ['agent'],
        missing_requested: [], header })
    }
    if (path === `/api/orgs/${org}/nodes/agent/account`) return json({ account: 'a', label: 'a',
      billing_mode: 'subscription', standing: { state: 'ok' }, session_boundary: false })
    if (path === '/api/providers') return json({ providers: [] })
    if (path.endsWith('/work-items')) return json({ items: [], counts: { attention: 0, active: 0, archived: 0, backlogged: 0 } })
    if (path.endsWith('/chat')) return json({ messages: [], live: [], pending_mail: [],
      busy: false, windowed: true, has_older: false, before: null, draft_epoch: 'fixture:0' })
    if (path.endsWith('/documents')) return json({ documents: [], total: 0 })
    if (path.endsWith('/inbox')) return json({ pending: [], delivered: [], sent: [] })
    return json({ ok: true })
  }
  globals.WebSocket = Socket
  globals.history = window.history
  globals.CustomEvent = window.CustomEvent
  localStorage.clear(); resetConvos()
  window.history.replaceState(null, '', `/o/${org}`)
  const view = await mountView(<App />, el => el)
  const wait = (ms: number) => inAct(async () => {
    await new Promise(resolve => setTimeout(resolve, ms)); await flush(20)
  })
  try {
    await inAct(async () => { await flush(30) })
    await wait(400)
    assert.ok(reads > 0, 'App read the tree on mount')

    // §1 THE CONTROL: the gap is in force, so an ordinary request does not
    // read. Without it, §2 passing would say nothing about urgency.
    let before = reads
    await wait(300)
    assert.equal(reads, before, 'nothing reads inside the pacer gap on its own')

    // §2
    before = reads
    await inAct(async () => { await saveScope(org, 'agent', { effort: 'high' } as never) })
    await wait(300)
    assert.ok(reads > before, `a scope save re-read the tree at once (reads ${before} -> ${reads})`)

    // §3
    before = reads
    await inAct(async () => { await assignAccount(org, 'agent', 'a') })
    await wait(300)
    assert.ok(reads > before, `an account save re-read the tree at once (reads ${before} -> ${reads})`)
  } finally {
    await view.unmount(); resetConvos(); localStorage.clear()
    window.history.replaceState(null, '', '/')
    globals.fetch = saved.fetch; globals.WebSocket = saved.socket; globals.history = saved.history
    globals.CustomEvent = saved.customEvent
  }
})
