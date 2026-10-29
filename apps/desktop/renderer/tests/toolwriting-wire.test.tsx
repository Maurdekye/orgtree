import { FakeServer, flush, inAct, installFetch, mountView, realClock, useFakeClock } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { legacyAppBackend } from './appfeed-fixture'
import App from '../src/App'
import { DeskChat } from '../src/canvas/desk'
import { refreshConvo, resetConvos } from '../src/convo'
import type { CanvasNode } from '../src/canvas/shared'
import type { ChatMessage, ChatTransient, OpResult } from '../src/types'

// A finished tool call's live "writing" row must not stay drawn under its saved
// row (4.5.1, found by the apps Short dry run: saved + live copy of one call for
// 0.2-3 s). The engine's frame carries the saved row AND the new writing list in
// one message; these tests pin both halves of the renderer: App forwards that
// list, and a desk never draws a call twice.
const WRITTEN = '2026-10-29T08:00:00.000Z'
const writing = (id: string, order: number): ChatTransient => ({ event_id: `tool-writing-1-${id}`, role: 'assistant',
  kind: 'tool_writing', text: 'Bash', tool_id: id, started_at: WRITTEN, stream_order: order,
  tool: { id, name: 'Bash', arg: 'echo hi', preview_input: { command: 'echo hi' }, writing_started_at: WRITTEN } } as ChatTransient)
const saved = (id: string, seq: number): ChatMessage => ({ role: 'assistant', text: '', ts: WRITTEN, row_id: `r${seq}`,
  event_id: `e${seq}`, seq, convo_revision: 1, tools: [{ id, name: 'Bash', arg: 'echo hi', input: { command: 'echo hi' },
    writing_secs: 0.6, started_at: '2026-10-29T08:00:01.000Z' }] })
const chips = (el: HTMLElement) => el.querySelectorAll('.tchip').length
const writingChips = (el: HTMLElement) => el.querySelectorAll('.tchip .tool-writing-status').length

test('the saved row and the shortened writing list arrive in one App frame: no live copy of the finished call stays', async () => {
  const org = 'writing-wire-fixture'
  const agent = { id: 'agent', title: 'Agent', generation: 1, state: 'live', tier: 'haiku',
    model_id: 'haiku', seat: 1, grant: 0, free: 0, parent: null, children: [],
    turns: [], lineage: [], audiences_held: [], documents: [], mail_pending: 0,
    scope: { tools: { mcp: [] }, add_dirs: [], permission_mode: 'default', org_visibility: 'team' },
  } as unknown as CanvasNode
  const tree = { slug: org, name: org, roots: [agent], tiers: { haiku: 1 }, dirs: [],
    max_top_grant: 1000, default_top_grant: 50, compact_at: 0, credit_requests: [],
    audience_requests: [], audiences: [], asks: [], asks_open: 0, watchdogs: [],
    audit: { live_nodes: 1, top_level_holds: 1, no_overdraft: true, problems: [] },
    user_inbox_count: 0, org_inbox: null, net: null, epoch: 1, rev: 1, sync_rev: 0,
    work_items_summary: { attention: 0, active: 0 },
  }
  const globals = globalThis as unknown as Record<string, unknown>
  const savedGlobals = { fetch: globals.fetch, socket: globals.WebSocket, history: globals.history,
    customEvent: globals.CustomEvent }
  const sockets: Socket[] = []
  class Socket {
    readyState = 1
    send(_message: string) {}
    onmessage: ((event: { data: string }) => void) | null = null
    constructor() { sockets.push(this) }
    close() { this.readyState = 3 }
  }
  const json = (value: unknown) => new Response(JSON.stringify(value), {
    headers: { 'Content-Type': 'application/json' },
  })
  // the poll that showed the call while it was being written; once the frame
  // lands no later answer is awaited (a debounced re-poll would hide the bug)
  let hold = false
  globals.fetch = legacyAppBackend((async (input: unknown) => {
    const path = new URL(String(input), window.location.origin).pathname
    if (path === '/api/orgs') return json([{ slug: org, name: org, live: 1, seats: 1 }])
    if (path === `/api/orgs/${org}`) return json(tree)
    if (path === '/api/providers') return json({ providers: [] })
    if (path.endsWith('/work-items')) return json({ items: [], counts: { attention: 0, active: 0, archived: 0, backlogged: 0 } })
    if (path.endsWith('/chat')) {
      if (hold) return new Promise<Response>(() => {})
      return json({ messages: [], live: [], pending_mail: [], busy: true, windowed: true, has_older: false,
        before: null, draft_epoch: 'fixture:0', transient: [writing('call-1', 1)] })
    }
    if (path.endsWith('/documents')) return json({ documents: [], total: 0 })
    if (path.endsWith('/inbox')) return json({ pending: [], delivered: [], sent: [] })
    return json({})
  }) as typeof fetch)
  globals.WebSocket = Socket
  globals.history = window.history
  globals.CustomEvent = window.CustomEvent
  localStorage.clear(); resetConvos()
  window.history.replaceState(null, '', `/o/${org}`)
  const desk = <DeskChat key="desk" node={agent} map={new Map([[agent.id, agent]])}
    op={async () => ({} as OpResult)} slug={org} toast={() => {}} bare />
  const view = await mountView(<><App key="app" />{desk}</>, el => el)
  try {
    await inAct(async () => { await flush(30) })
    const active = sockets.filter(socket => socket.readyState === 1 && socket.onmessage)
    assert.equal(active.length, 1, 'the real App subscribed to the org socket')
    assert.equal(writingChips(view.el), 1, 'the poll showed the call while it was being written')
    assert.equal(chips(view.el), 1)
    hold = true
    // the engine's frame for the admitted call: the saved row, and the live
    // writing list without it (actor.rs stream(): convo_rows + tool_writing)
    await inAct(() => active[0].onmessage!({ data: JSON.stringify({ type: 'node_stream', node: agent.id,
      kind: 'tool', id: 'call-1', text: '', convo_rows: [saved('call-1', 1)], tool_writing: [],
      draft_clear: true, thinking_clear: true }) }))
    assert.equal(chips(view.el), 1, 'one chip for the call')
    assert.equal(writingChips(view.el), 0, 'the live writing copy left with the frame that carried the saved row')
    // a still-writing second call stays live
    await inAct(() => active[0].onmessage!({ data: JSON.stringify({ type: 'node_stream', node: agent.id,
      kind: 'tool_writing', text: '', convo_rows: [], tool_writing: [writing('call-2', 2)],
      draft_clear: true, thinking_clear: true }) }))
    assert.equal(chips(view.el), 2)
    assert.equal(writingChips(view.el), 1, 'the call still being written keeps its live row')
  } finally {
    await view.unmount(); resetConvos(); localStorage.clear()
    window.history.replaceState(null, '', '/')
    globals.fetch = savedGlobals.fetch; globals.WebSocket = savedGlobals.socket; globals.history = savedGlobals.history
    globals.CustomEvent = savedGlobals.customEvent
  }
})

test('a desk never draws one call twice: a saved chip hides the live writing row with its id, and only that one', async t => {
  useFakeClock()
  const server = new FakeServer(); server.busy = true
  server.messages = [saved('one', 1)]
  const original = server.chat.bind(server)
  // a poll answered before the engine retired the writing row of the saved call
  server.chat = last => ({ ...original(last), transient: [writing('one', 1), writing('two', 2)] })
  installFetch(server)
  resetConvos()
  const node = { id: 'worker', state: 'live', tier: 'haiku', children: [], seat: 1, grant: 0, free: 0,
    scope: { tools: {}, add_dirs: [] }, model_id: 'haiku' } as CanvasNode
  const view = await mountView(<DeskChat node={node} map={new Map([[node.id, node]])}
    op={() => Promise.resolve({} as OpResult)} slug="org" toast={() => {}} bare />, el => el.textContent ?? '')
  t.after(async () => { await view.unmount(); resetConvos(); realClock() })
  await inAct(() => refreshConvo('org', 'worker', { force: true })); await flush()
  assert.equal(chips(view.el), 2, 'the saved call and the second call being written: one chip each')
  assert.equal(writingChips(view.el), 1, 'only the call with no saved row is drawn as writing')
})
