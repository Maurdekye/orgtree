// appforeground.test.tsx — the real App reads the SELECTED tree: the
// foreground endpoint with what mounted surfaces registered, never the
// whole-history legacy tree, and it asks again when a selection changes.
//
// Run:  cd apps/desktop/renderer && node tests/run.mjs appforeground
import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import App from '../src/App'
import { resetConvos } from '../src/convo'
import { treeSelections } from '../src/treeselection'
import { FOREGROUND_TREE_FORMAT as format } from '../src/foregroundtree'

test('App reads the selected foreground tree and re-reads it when a mounted selection changes', async () => {
  const org = 'app-foreground-fixture'
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
  let legacyReads = 0
  const selections: string[][] = []
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
      const include = url.searchParams.getAll('include')
      selections.push(include)
      return json({ format, kind: 'snapshot', revision: 'r' + selections.length,
        catalog_revision: 'c1', org_rev: 1, sync_rev: 0, nodes: { agent }, roots: ['agent'],
        missing_requested: include.filter(id => id !== 'agent'), header })
    }
    if (path === `/api/orgs/${org}`) { legacyReads++; return json({ ...header, roots: [] }) }
    if (path === '/api/providers') return json({ providers: [] })
    if (path.endsWith('/work-items')) return json({ items: [], counts: { attention: 0, active: 0, archived: 0, backlogged: 0 } })
    if (path.endsWith('/chat')) return json({ messages: [], live: [], pending_mail: [],
      busy: false, windowed: true, has_older: false, before: null, draft_epoch: 'fixture:0' })
    if (path.endsWith('/documents')) return json({ documents: [], total: 0 })
    if (path.endsWith('/inbox')) return json({ pending: [], delivered: [], sent: [] })
    return json({})
  }
  globals.WebSocket = Socket
  globals.history = window.history
  globals.CustomEvent = window.CustomEvent
  localStorage.clear(); resetConvos()
  window.history.replaceState(null, '', `/o/${org}`)
  const view = await mountView(<App />, el => el)
  const owner = {}
  try {
    await inAct(async () => { await flush(30) })
    assert.ok(selections.length > 0, 'the real App asked for the selected tree')
    assert.equal(legacyReads, 0, 'and never read the whole-history legacy tree')
    assert.ok(view.el.querySelector('.sq[data-copy-agent-name="agent"]'), 'App adopted the selected tree')
    const before = selections.length
    await inAct(async () => {
      treeSelections.set(org, owner, { include: ['wanted-retiree'] })
      await new Promise(resolve => setTimeout(resolve, 250))
      await flush(20)
    })
    assert.ok(selections.slice(before).some(ids => ids.includes('wanted-retiree')),
      'a mounted selection change was read with its identity included')
    assert.equal(legacyReads, 0)
  } finally {
    treeSelections.release(org, owner)
    await view.unmount(); resetConvos(); localStorage.clear()
    window.history.replaceState(null, '', '/')
    globals.fetch = saved.fetch; globals.WebSocket = saved.socket; globals.history = saved.history
    globals.CustomEvent = saved.customEvent
  }
})
