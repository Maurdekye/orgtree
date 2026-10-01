// nodeglow.test.tsx — an agent's canvas glow goes out on the click that
// answers its question (docket v3-agent-node-keeps-its-attention-glow-for-a-whi,
// user 2026-09-30 on alpha.8: "my node kept its orange glow for a while after
// I answered").
//
// The glow (`.sq.asking`, canvas/cards.tsx) followed `node.ask` in the tree
// only, and the tree says the ask is open until a paced tree read that began
// after the save. The answered CARD already left on the submit (asksubmitted.ts,
// point 31); the glow now reads the same store.
//
// Every tree read here keeps answering with the ask OPEN, so a pass cannot
// come from the server having caught up: nothing but the submit can put the
// glow out. The submit itself is HELD open, so it cannot come from the save
// having returned either.
//
// Run:  node apps/desktop/renderer/tests/run.mjs nodeglow

import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import App from '../src/App'
import { resetConvos } from '../src/convo'
import { resetPrimedAsks } from '../src/askprime'
import { resetSubmittedAsks, submitAsk } from '../src/asksubmitted'
import type { AskInfo, TreeNode, TreePayload } from '../src/types'

const ORG = 'nodeglow-fixture'
const askOf = (id: string): AskInfo => ({ id, node: 'agent', kind: 'batch', status: 'open',
  at: '2026-09-30T20:50:00Z', rev: 1, revs: { ask: 1 },
  tabs: [{ kind: 'question', question: 'Proceed?', options: [{ label: 'yes' }] }] } as AskInfo)

function agentNode(ask: AskInfo): TreeNode {
  return { id: 'agent', title: 'Agent', generation: 1, state: 'live', tier: 'haiku',
    model_id: 'haiku', seat: 1, grant: 0, free: 0, parent: null, children: [],
    turns: [], lineage: [], audiences_held: [], documents: [], mail_pending: 0,
    scope: { tools: {}, add_dirs: [], permission_mode: 'default', org_visibility: 'team' },
    ask,
  } as unknown as TreeNode
}
function treeOf(ask: AskInfo): TreePayload {
  return { slug: ORG, name: ORG, roots: [agentNode(ask)], tiers: { haiku: 1 }, dirs: [],
    max_top_grant: 1000, default_top_grant: 50, compact_at: 0, credit_requests: [],
    audience_requests: [], audiences: [], asks: [ask], asks_open: 1, watchdogs: [],
    audit: { live_nodes: 1, top_level_holds: 1, no_overdraft: true, problems: [] },
    user_inbox_count: 0, org_inbox: null, net: null, epoch: 1, rev: 1, sync_rev: 0,
    work_items_summary: { attention: 0, active: 0 },
  } as unknown as TreePayload
}

async function mountApp() {
  resetPrimedAsks(); resetSubmittedAsks()
  const globals = globalThis as unknown as Record<string, unknown>
  const saved = { fetch: globals.fetch, socket: globals.WebSocket, history: globals.history,
    customEvent: globals.CustomEvent }
  const sockets: Socket[] = []
  class Socket {
    readyState = 1
    onmessage: ((event: { data: string }) => void) | null = null
    constructor() { sockets.push(this) }
    close() { this.readyState = 3 }
  }
  const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
    status, headers: { 'Content-Type': 'application/json' },
  })
  // what the engine says the agent is asking: the tree NEVER reports it answered
  const state = { ask: askOf('q1') }
  globals.fetch = async (input: unknown) => {
    const path = new URL(String(input), window.location.origin).pathname
    if (path === '/api/orgs') return json([{ slug: ORG, name: ORG, live: 1, seats: 1 }])
    if (path === `/api/orgs/${ORG}`) return json(treeOf(state.ask))
    if (path === `/api/orgs/${ORG}/nodes/agent/detail`) return json(agentNode(state.ask))
    if (path === '/api/desktop/notifications') return json({ notices: [], total: 0, truncated: false })
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
  window.history.replaceState(null, '', `/o/${ORG}`)
  const view = await mountView(<App />, el => el)
  await inAct(async () => { await flush(30) })
  assert.ok(view.el.querySelector('.sq[data-copy-agent-name="agent"]'), 'fixture: the agent is on the canvas')
  const socket = sockets.find(s => s.readyState === 1 && s.onmessage)!
  return {
    state,
    glowing: () => !!view.el.querySelector('.sq.asking[data-copy-agent-name="agent"]'),
    // one live bump and the reads it starts (coalesced 120 ms, livebus.ts)
    changed: () => inAct(async () => {
      socket.onmessage!({ data: JSON.stringify({ type: 'changed', org: ORG, rev: 2 }) })
      await new Promise(r => setTimeout(r, 200))
      await flush(30)
    }),
    done: async () => {
      await view.unmount(); resetConvos(); resetPrimedAsks(); resetSubmittedAsks(); localStorage.clear()
      window.history.replaceState(null, '', '/')
      globals.fetch = saved.fetch; globals.WebSocket = saved.socket; globals.history = saved.history
      globals.CustomEvent = saved.customEvent
    },
  }
}

function held() {
  let resolve!: () => void
  let reject!: (e: Error) => void
  const promise = new Promise<void>((a, b) => { resolve = a; reject = b })
  promise.catch(() => {})
  return { promise, resolve, reject }
}

test('answering the only open question puts the node glow out on the click, before any save or tree read', async () => {
  const app = await mountApp()
  try {
    assert.equal(app.glowing(), true, 'fixture: an open question glows')
    const save = held()
    await inAct(async () => {
      void submitAsk({ slug: ORG, nid: 'agent', askId: 'q1', sections: null }, () => save.promise)
        .catch(() => {})
      await flush(5)
    })
    assert.equal(app.glowing(), false, 'the glow is out while the save is still in flight')
    await inAct(async () => { save.resolve(); await flush(5) })
    // a tree read that still (for now) calls the ask open does not relight it
    await app.changed()
    assert.equal(app.glowing(), false, 'a lagging tree read does not bring the glow back')
  } finally { await app.done() }
})

test('a refused answer lights the glow again', async () => {
  const app = await mountApp()
  try {
    const save = held()
    await inAct(async () => {
      void submitAsk({ slug: ORG, nid: 'agent', askId: 'q1', sections: null }, () => save.promise)
        .catch(() => {})
      await flush(5)
    })
    assert.equal(app.glowing(), false)
    await inAct(async () => { save.reject(new Error('engine busy')); await flush(5) })
    assert.equal(app.glowing(), true, 'the question is still open, so the node still needs the user')
  } finally { await app.done() }
})

test('a NEW question from the same agent glows even though the last one was just answered', async () => {
  const app = await mountApp()
  try {
    await inAct(async () => {
      await submitAsk({ slug: ORG, nid: 'agent', askId: 'q1', sections: null }, () => Promise.resolve())
      await flush(5)
    })
    assert.equal(app.glowing(), false)
    app.state.ask = askOf('q2')
    await app.changed()
    assert.equal(app.glowing(), true, 'another open reason keeps the glow: only the answered ask is hidden')
  } finally { await app.done() }
})
