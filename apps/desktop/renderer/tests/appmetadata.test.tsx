import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import App from '../src/App'
import { DeskChat } from '../src/canvas/desk'
import { resetConvos } from '../src/convo'
import type { CanvasNode } from '../src/canvas/shared'

test('App fetch initializes live desk metadata and App disposal clears it', async () => {
  const org = 'app-metadata-fixture'
  const agent = { id: 'agent', title: 'Agent', generation: 1, state: 'live', tier: 'haiku',
    model_id: 'haiku', seat: 1, grant: 0, free: 0, parent: null, children: [],
    turns: [], lineage: [], audiences_held: [], documents: [], mail_pending: 0,
    mcp_tool_count: 2, last_turn_mcp_tool_count: null, mcp_tool_count_provider: 'claude',
    scope: { tools: { mcp: ['fixture'] }, add_dirs: [], permission_mode: 'default', org_visibility: 'team' },
  } as unknown as CanvasNode
  const tree = { slug: org, name: org, roots: [agent], tiers: { haiku: 1 }, dirs: [],
    max_top_grant: 1000, default_top_grant: 50, compact_at: 0, credit_requests: [],
    audience_requests: [], audiences: [], asks: [], asks_open: 0, watchdogs: [],
    audit: { live_nodes: 1, top_level_holds: 1, no_overdraft: true, problems: [] },
    user_inbox_count: 0, org_inbox: null, net: null, epoch: 1, rev: 1, sync_rev: 0,
    work_items_summary: { attention: 0, active: 0 },
  }
  const globals = globalThis as unknown as Record<string, unknown>
  const saved = { fetch: globals.fetch, socket: globals.WebSocket, history: globals.history,
    customEvent: globals.CustomEvent }
  let treeReads = 0
  const sockets: Socket[] = []
  class Socket {
    readyState = 1
    onmessage: ((event: { data: string }) => void) | null = null
    constructor() { sockets.push(this) }
    close() { this.readyState = 3 }
  }
  const json = (value: unknown) => new Response(JSON.stringify(value), {
    headers: { 'Content-Type': 'application/json' },
  })
  globals.fetch = async (input: unknown) => {
    const path = new URL(String(input), window.location.origin).pathname
    if (path === '/api/orgs') return json([{ slug: org, name: org, live: 1, seats: 1 }])
    if (path === `/api/orgs/${org}`) { treeReads++; return json(tree) }
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
  // A separate desk subscriber remains mounted while App is disposed. Its
  // values must come through App's fetch/socket lifecycle, never direct calls
  // to the metadata store from this fixture.
  const desk = <DeskChat key="desk" node={agent} map={new Map([[agent.id, agent]])}
    op={async () => ({})} slug={org} toast={() => {}} bare />
  const view = await mountView(<><App key="app" />{desk}</>, el => el)
  try {
    await inAct(async () => { await flush(30) })
    assert.ok(treeReads > 0, 'the real App fetched a tree')
    assert.ok(view.el.querySelector('.sq[data-copy-agent-name="agent"]'), 'App adopted that tree')
    const label = () => view.el.querySelector('.mcp-tool-count')?.getAttribute('aria-label')
    assert.equal(label(), '2 callable MCP tools')
    const active = sockets.filter(socket => socket.readyState === 1 && socket.onmessage)
    assert.equal(active.length, 1, 'the real App subscribed to the org socket')
    const before = treeReads
    await inAct(() => active[0].onmessage!({ data: JSON.stringify({ type: 'node_stream',
      node: agent.id, kind: 'mcp_tool_count', count: 9, provider: 'claude', rev: 1 }) }))
    assert.equal(label(), '9 callable MCP tools', 'live metadata crossed App into the desk')
    assert.equal(treeReads, before, 'a contiguous update did not fetch another tree')
    await view.render(<>{desk}</>)
    assert.equal(label(), '2 callable MCP tools', 'disposing App released its metadata overlay')
  } finally {
    await view.unmount(); resetConvos(); localStorage.clear()
    window.history.replaceState(null, '', '/')
    globals.fetch = saved.fetch; globals.WebSocket = saved.socket; globals.history = saved.history
    globals.CustomEvent = saved.customEvent
  }
})
