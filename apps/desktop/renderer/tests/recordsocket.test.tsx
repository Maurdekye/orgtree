import './harness'
import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import App from '../src/App'
import { resetConvos } from '../src/convo'
import { FOREGROUND_TREE_FORMAT as format } from '../src/foregroundtree'

for (const enabled of [false, true]) test(`org record feed flag ${enabled}: socket, projection and polling`, async () => {
  const org = `record-socket-${enabled}`
  const agent = { id: 'agent', title: 'Agent', generation: 1, state: 'live', tier: 'haiku',
    model_id: 'haiku', seat: 1, grant: 0, free: 0, children: [], turns: [],
    audiences_held: [], documents: [], mail_pending: 0, ui_order: 0,
    scope: { tools: {}, add_dirs: [], permission_mode: 'default', org_visibility: 'team' },
    axis: 'org', hidden_retired_children: 0, lineage_loaded: false, lineage_count: 0,
    predecessor: null, successor: null }
  const header = { slug: org, name: org, tiers: { haiku: 1 }, dirs: [],
    max_top_grant: 1000, default_top_grant: 50, compact_at: 0, credit_requests: [],
    audience_requests: [], audiences: [], asks: [], asks_open: 0, watchdogs: [],
    audit: { live_nodes: 1, top_level_holds: 1, no_overdraft: true, problems: [] },
    user_inbox_count: 0, org_inbox: null, net: null, epoch: 1, rev: 1,
    capabilities: { record_changes_v1: enabled },
    work_items_summary: { attention: 0, active: 0 }, hidden_retired_roots: 0, retired_total: 0 }
  const globals = globalThis as unknown as Record<string, unknown>
  const saved = { fetch: globals.fetch, socket: globals.WebSocket, history: globals.history,
    customEvent: globals.CustomEvent, setInterval: globals.setInterval, clearInterval: globals.clearInterval }
  const intervals = new Map<unknown, number>()
  const realSet = globalThis.setInterval, realClear = globalThis.clearInterval
  globals.setInterval = ((fn: () => void, ms: number) => {
    const handle = realSet(fn, ms); intervals.set(handle, ms); return handle
  })
  globals.clearInterval = ((handle: ReturnType<typeof setInterval>) => {
    intervals.delete(handle); realClear(handle)
  })
  const sockets: Socket[] = []
  class Socket {
    readyState = 1
    onmessage: ((event: { data: string }) => void) | null = null
    onopen: (() => void) | null = null
    onclose: (() => void) | null = null
    constructor(readonly url: string) { sockets.push(this) }
    close() { this.readyState = 3; this.onclose?.() }
    send() {}
    frame(value: unknown) { this.onmessage?.({ data: JSON.stringify(value) }) }
  }
  const reads: string[] = []
  const json = (value: unknown) => new Response(JSON.stringify(value), {
    headers: { 'Content-Type': 'application/json' },
  })
  const change = (from: number, to: number, name: string) => ({ type: 'record_changes',
    org_uuid: 'identity', incarnation: 'first', from, to,
    upserts: [{ entity: 'org', id: 'org', body: { ...header, name } }], tombstones: [] })
  globals.fetch = async (input: unknown) => {
    const url = new URL(String(input), window.location.origin)
    const path = url.pathname; reads.push(url.pathname + url.search)
    if (path === '/api/orgs') return json([{ slug: org, name: org, live: 1, seats: 1 }])
    if (path === `/api/orgs/${org}/foreground-tree`) return json({ format, kind: 'snapshot',
      revision: 'initial', catalog_revision: 'catalog', org_rev: 1, sync_rev: 0,
      nodes: { agent }, roots: ['agent'], missing_requested: [], header })
    if (path === `/api/orgs/${org}/records`) return json({ type: 'record_snapshot',
      cursor: { org_uuid: 'identity', incarnation: 'first', rev: 1 }, records: [
        { entity: 'org', id: 'org', body: { ...header, name: 'Baseline' } },
        { entity: 'agent', id: '123', body: { ...agent, parent_id: null, sibling_order: 0 } },
      ] })
    if (path === `/api/orgs/${org}/changes`) {
      assert.equal(url.searchParams.get('org_uuid'), 'identity')
      assert.equal(url.searchParams.get('incarnation'), 'first')
      return json(change(Number(url.searchParams.get('after')), 5, 'Recovered'))
    }
    if (path === '/api/providers') return json({ providers: [] })
    if (path.endsWith('/work-items')) return json({ items: [], counts: { attention: 0, active: 0, archived: 0, backlogged: 0 } })
    if (path.endsWith('/chat')) return json({ messages: [], live: [], pending_mail: [],
      busy: false, windowed: true, has_older: false, before: null, draft_epoch: 'fixture:0' })
    if (path.endsWith('/documents')) return json({ documents: [], total: 0 })
    if (path.endsWith('/inbox')) return json({ pending: [], delivered: [], sent: [] })
    return json({ ok: true })
  }
  globals.WebSocket = Socket; globals.history = window.history; globals.CustomEvent = window.CustomEvent
  localStorage.clear(); resetConvos()
  window.history.replaceState(null, '', `/o/${org}`)
  const view = await mountView(<App />, el => el)
  try {
    await inAct(async () => { await flush(40) })
    assert.equal(sockets.length, 1, 'capability transition keeps the existing socket')
    assert.match(sockets[0].url, new RegExp(`/api/orgs/${org}/ws`))
    assert.equal([...intervals.values()].includes(6000), !enabled, 'only the legacy path has a tree polling timer')
    assert.equal(reads.some(p => p.endsWith('/records')), enabled)
    if (enabled) {
      assert.match(document.title, /Baseline/)
      const before = reads.filter(p => p.includes('/foreground-tree')).length
      await inAct(async () => { sockets[0].frame(change(1, 2, 'Live')); await flush(20) })
      assert.match(document.title, /Live/)
      await inAct(async () => { sockets[0].frame(change(3, 4, 'Gap')); await flush(20) })
      assert.match(document.title, /Recovered/)
      assert.ok(reads.some(p => p.includes('/changes?after=2')))
      await inAct(async () => { sockets[0].frame(change(1, 2, 'Old')); sockets[0].frame({ type: 'changed', rev: 99 }); await flush(20) })
      assert.match(document.title, /Recovered/)
      assert.equal(reads.filter(p => p.includes('/foreground-tree')).length, before,
        'live state and legacy changed echoes cause no tree refetch')
      await inAct(async () => { sockets[0].onopen?.(); await flush(20) })
      assert.ok(reads.some(p => p.includes('/changes?after=5')), 'every reconnect catches up without a later commit')
    }
  } finally {
    await view.unmount(); resetConvos(); localStorage.clear()
    window.history.replaceState(null, '', '/')
    Object.assign(globals, { fetch: saved.fetch, WebSocket: saved.socket, history: saved.history,
      CustomEvent: saved.customEvent, setInterval: saved.setInterval, clearInterval: saved.clearInterval })
  }
})
