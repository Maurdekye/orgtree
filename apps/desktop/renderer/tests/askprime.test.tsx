// askprime.test.tsx — a new question's card arrives with its notification
// (user feedback point 34, 2026-09-29), not after the next paced tree read.
//
// §1-§3 and §5 pin askprime's rule for the tree on screen (§5: an agent the
// selected v3 tree does not hold, which the inbox and Attention list from
// `tree.asks`). §6-§7: every page of the attention projection is read, and a
// failed detail read is retried. §4 runs the real App: the
// full tree read after the first one is HELD (the slow, paced read of a busy
// org), a `changed` frame arrives, and the question must be on the agent's
// canvas card (`.sq.asking`) from the same live update, while that read is
// still in flight. A stale read that started before the question then lands,
// and it must not take the card away.
//
// Run:  node apps/desktop/renderer/tests/run.mjs askprime

import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import App from '../src/App'
import { resetConvos } from '../src/convo'
import { applyPrimedAsks, patchNodeAsk, primeAsk, resetPrimedAsks } from '../src/askprime'
import { openAsks } from '../src/canvas/openasks'
import type { AskInfo, TreeNode, TreePayload } from '../src/types'

const ORG = 'askprime-fixture'
const ask: AskInfo = { id: 'q1', node: 'agent', kind: 'batch', status: 'open',
  at: '2026-09-29T22:00:00Z', rev: 1, revs: { ask: 1 },
  tabs: [{ kind: 'question', question: 'Proceed?', options: [{ label: 'yes' }] }] } as AskInfo

function agentNode(withAsk: AskInfo | null): TreeNode {
  return { id: 'agent', title: 'Agent', generation: 1, state: 'live', tier: 'haiku',
    model_id: 'haiku', seat: 1, grant: 0, free: 0, parent: null, children: [],
    turns: [], lineage: [], audiences_held: [], documents: [], mail_pending: 0,
    scope: { tools: {}, add_dirs: [], permission_mode: 'default', org_visibility: 'team' },
    ...(withAsk ? { ask: withAsk } : {}),
  } as unknown as TreeNode
}
function treeOf(withAsk: AskInfo | null): TreePayload {
  return { slug: ORG, name: ORG, roots: [agentNode(withAsk)], tiers: { haiku: 1 }, dirs: [],
    max_top_grant: 1000, default_top_grant: 50, compact_at: 0, credit_requests: [],
    audience_requests: [], audiences: [], asks: [], asks_open: withAsk ? 1 : 0, watchdogs: [],
    audit: { live_nodes: 1, top_level_holds: 1, no_overdraft: true, problems: [] },
    user_inbox_count: 0, org_inbox: null, net: null, epoch: 1, rev: 1, sync_rev: 0,
    work_items_summary: { attention: 0, active: 0 },
  } as unknown as TreePayload
}

test('§1 patchNodeAsk puts the ask on the node, and is a no-op for the same ask', () => {
  const t = treeOf(null)
  const p = patchNodeAsk(t, 'agent', ask)
  assert.notEqual(p, t)
  assert.equal(p.roots[0]!.ask?.id, 'q1')
  assert.equal(patchNodeAsk(p, 'agent', { ...ask }), p, 'same record and revision: same object')
  const off = patchNodeAsk(t, 'nobody', ask)
  assert.equal(off.roots, t.roots, 'an absent node leaves the nodes alone')
  assert.deepEqual(off.asks?.map(a => a.id), ['q1'], '...and the ask joins the header rows (see section 5)')
})

test('§2 a tree read that started BEFORE the prime gets the ask re-applied', () => {
  resetPrimedAsks()
  primeAsk(ORG, 'agent', ask, 2000)
  const out = applyPrimedAsks(ORG, treeOf(null), 1000)
  assert.equal(out.roots[0]!.ask?.id, 'q1')
  // and again for the next old read: the prime is kept until a newer read
  assert.equal(applyPrimedAsks(ORG, treeOf(null), 1500).roots[0]!.ask?.id, 'q1')
})

test('§3 a tree read that started AFTER the prime is the truth, and the prime is dropped', () => {
  resetPrimedAsks()
  primeAsk(ORG, 'agent', ask, 2000)
  const fresh = treeOf(null)   // answered or withdrawn since
  assert.equal(applyPrimedAsks(ORG, fresh, 3000), fresh)
  assert.equal(applyPrimedAsks(ORG, treeOf(null), 1000).roots[0]!.ask, undefined,
    'dropped for good, even for a later stale read')
})

interface AppRig {
  el: HTMLElement
  card: () => Element | null
  changed: () => Promise<void>
  held: (() => void)[]
  counts: { treeReads: number; details: number }
  state: { asked: boolean }
  done: () => Promise<void>
}

/** The real App against a fake engine: the first tree read answers at once,
 *  every later one is HELD (the slow, paced read of a busy org) and answers
 *  with the tree as it was when the read STARTED. `noticePages` splits the
 *  attention projection into pages; `detailFails` fails that many detail
 *  reads first. */
async function mountApp(o: { noticePages?: number; detailFails?: number } = {}): Promise<AppRig> {
  resetPrimedAsks()
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
  const counts = { treeReads: 0, details: 0 }
  const state = { asked: false }
  const held: (() => void)[] = []
  let fails = o.detailFails ?? 0
  const pages = o.noticePages ?? 1
  globals.fetch = async (input: unknown) => {
    const url = new URL(String(input), window.location.origin)
    const path = url.pathname
    if (path === '/api/orgs') return json([{ slug: ORG, name: ORG, live: 1, seats: 1 }])
    if (path === `/api/orgs/${ORG}`) {
      counts.treeReads++
      const body = treeOf(state.asked ? ask : null)
      if (counts.treeReads === 1) return json(body)
      return new Promise<Response>(resolve => held.push(() => resolve(json(body))))
    }
    if (path === '/api/desktop/notifications') {
      // the question sits on the LAST page; earlier pages carry other rows
      const offset = Number(url.searchParams.get('offset') ?? 0)
      const last = offset >= pages - 1
      const notices = last && state.asked ? [{ id: 'n-q1', org: ORG, kind: 'question',
        title: 'Question from agent', body: 'Proceed?', agent: 'agent', source_id: 'q1' }]
        : last ? [] : [{ id: `n-mail-${offset}`, org: ORG, kind: 'urgent-mail', title: 'mail',
          body: 'x', agent: 'agent', source_id: `m${offset}` }]
      return json({ notices, total: pages, truncated: !last, next_offset: last ? null : offset + 1 })
    }
    if (path === `/api/orgs/${ORG}/nodes/agent/detail`) {
      counts.details++
      if (fails > 0) { fails--; return json({ detail: 'engine busy' }, 503) }
      return json(agentNode(state.asked ? ask : null))
    }
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
    el: view.el, held, counts, state,
    card: () => view.el.querySelector('.sq.asking[data-copy-agent-name="agent"]'),
    changed: () => inAct(async () => {
      socket.onmessage!({ data: JSON.stringify({ type: 'changed', org: ORG, rev: 2 }) })
      // the live bump is coalesced 120 ms (livebus.ts)
      await new Promise(r => setTimeout(r, 200))
      await flush(30)
    }),
    done: async () => {
      for (const f of held.splice(0)) f()
      await view.unmount(); resetConvos(); resetPrimedAsks(); localStorage.clear()
      window.history.replaceState(null, '', '/')
      globals.fetch = saved.fetch; globals.WebSocket = saved.socket; globals.history = saved.history
      globals.CustomEvent = saved.customEvent
    },
  }
}

test('§4 App: the question card comes with the live update while the tree read is still in flight',
  async () => {
    const app = await mountApp()
    try {
      assert.equal(app.card(), null, 'fixture: no question yet')
      // a busy org: some other save starts a tree read, which is slow. It
      // began BEFORE the question existed, so its answer will not carry it.
      const before = app.counts.treeReads
      await app.changed()
      assert.ok(app.counts.treeReads > before && app.held.length > 0, 'fixture: a slow tree read is in flight')
      const inFlight = app.held.length
      // the agent asks: the org saves, and the engine sends one `changed`
      app.state.asked = true
      await app.changed()
      assert.equal(app.held.length, inFlight, 'no newer tree read has started (the pacer waits)')
      assert.ok(app.card(), 'the question card is on screen before any tree read carries it')
      assert.ok(app.counts.details > 0, 'the primer read the asking node')
      // the old read now lands without the question: the card must stay
      await inAct(async () => { for (const f of app.held.splice(0, inFlight)) f(); await flush(30) })
      assert.ok(app.card(), 'a read that started before the question does not take the card away')
    } finally { await app.done() }
  })

test('§5 an agent outside the selected tree: the ask joins tree.asks, where openAsks lists it', () => {
  resetPrimedAsks()
  // the v3 tree is a selected read: the asking agent is not in `roots`
  const selected = { ...treeOf(null), roots: [] } as unknown as TreePayload
  const primed = patchNodeAsk(selected, 'agent', ask)
  assert.deepEqual(openAsks(primed, primed.roots).map(a => a.id), ['q1'],
    'the inbox and Attention list it (canvas/openasks.ts)')
  assert.equal(patchNodeAsk(primed, 'agent', { ...ask }), primed, 'the same ask again: same object')
  // and a stale read that predates the prime gets it re-applied there too
  primeAsk(ORG, 'agent', ask, 2000)
  const again = applyPrimedAsks(ORG, selected, 1000)
  assert.deepEqual(openAsks(again, again.roots).map(a => a.id), ['q1'])
})

test('§6 a question on a later page of the attention projection is primed too', async () => {
  const app = await mountApp({ noticePages: 3 })
  try {
    await app.changed()                       // a slow read in flight
    app.state.asked = true
    await app.changed()
    assert.ok(app.card(), 'read to the last page, where the question is')
  } finally { await app.done() }
})

test('§7 a failed detail read is retried on the next live update', async () => {
  const app = await mountApp({ detailFails: 1 })
  try {
    await app.changed()                       // a slow read in flight
    app.state.asked = true
    await app.changed()
    assert.equal(app.card(), null, 'fixture: the first detail read failed')
    assert.equal(app.counts.details, 1)
    await app.changed()
    assert.equal(app.counts.details, 2, 'the question was not marked handled: read again')
    assert.ok(app.card(), 'and now it is on screen')
  } finally { await app.done() }
})
