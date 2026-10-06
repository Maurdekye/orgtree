import './harness'
import { advance, flush, inAct, mountView, realClock, useFakeClock } from './harness'
import test from 'node:test'
import { legacyAppBackend } from './appfeed-fixture'
import assert from 'node:assert/strict'
import App from '../src/App'
import { resetConvos } from '../src/convo'
import { FOREGROUND_TREE_FORMAT as format } from '../src/foregroundtree'
import { markReadNow, resetLocalReads, unconfirmedReads } from '../src/mailread'
import { applyPrimedAsks, primeAsk, resetPrimedAsks } from '../src/askprime'
import { bumpLive } from '../src/livebus'
import { treeSelections } from '../src/treeselection'
import { clearNodeMetadata, useNodeMetadata } from '../src/nodemetadata'
import type { AskInfo, TreePayload } from '../src/types'

for (const enabled of [false, true]) test(`org record feed flag ${enabled}: socket, projection and polling`, async () => {
  useFakeClock()
  const org = `record-socket-${enabled}`
  const agent = { id: 'agent', title: 'Agent', generation: 1, state: 'live', tier: 'haiku',
    model_id: 'haiku', seat: 1, grant: 0, free: 0, parent: null, children: [], turns: [],
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
  const sent: { type: string; agents?: string[]; windows?: unknown[]; sub: number }[] = []
  class Socket {
    readyState = 1
    onmessage: ((event: { data: string }) => void) | null = null
    onopen: (() => void) | null = null
    onclose: (() => void) | null = null
    constructor(readonly url: string) { sockets.push(this) }
    close() { this.readyState = 3; this.onclose?.() }
    send(text: string) { if (text.startsWith('{')) sent.push(JSON.parse(text)) }
    frame(value: unknown) { this.onmessage?.({ data: JSON.stringify(value) }) }
  }
  const reads: string[] = []
  let releaseForeground: (() => void) | null = null
  let replacement = false
  let holdChanges = false
  const delayed: { answer: unknown; resolve: (r: Response) => void }[] = []
  const json = (value: unknown) => new Response(JSON.stringify(value), {
    headers: { 'Content-Type': 'application/json' },
  })
  const change = (from: number, to: number, name: string) => ({ type: 'record_changes',
    org_uuid: 'identity', incarnation: 'first', from, to,
    upserts: [{ entity: 'org', id: 'org', body: { ...header, name } }], tombstones: [] })
  const runtime = (seq: number, count: number, epoch = 'host', incarnation = 'first') => ({
    type: 'agent_runtime', org_uuid: 'identity', incarnation, epoch, seq, full: true,
    agents: { '123': { epoch, seq, mcp_tool_count: count } },
  })
  globals.fetch = legacyAppBackend((async (input: unknown) => {
    const url = new URL(String(input), window.location.origin)
    const path = url.pathname; reads.push(url.pathname + url.search)
    if (path === '/api/orgs') return json([{ slug: org, name: org, live: 1, seats: 1 }])
    if (path === `/api/orgs/${org}/foreground-tree`) {
      if (enabled) await new Promise<void>(resolve => { releaseForeground = resolve })
      return json({ format, kind: 'snapshot',
        revision: 'initial', catalog_revision: 'catalog', org_rev: 1, sync_rev: 0,
        nodes: { agent }, roots: ['agent'], missing_requested: [], header })
    }
    if (path === `/api/orgs/${org}/records`) return json({ type: 'record_snapshot',
      cursor: { org_uuid: 'identity', incarnation: replacement ? 'replacement' : 'first', rev: replacement ? 0 : 1 },
      runtime: runtime(2, 2, 'host', replacement ? 'replacement' : 'first'), records: [
        { entity: 'org', id: 'org', body: { ...header, name: 'Baseline' } },
        { entity: 'agent', id: '123', body: { ...agent, parent_id: null, sibling_order: 0 } },
      ] })
    if (path === `/api/orgs/${org}/records/selection`) {
      const args = JSON.parse(url.searchParams.get('args')!)
      return json({ cursor: { org_uuid: 'identity', incarnation: replacement ? 'replacement' : 'first',
        rev: replacement ? 0 : reads.some(p => p.includes('/changes')) ? 5 : 1 },
        names: Object.fromEntries((args.names ?? []).filter((name: string) => name === 'agent' || /^pin-\d+$/.test(name))
          .map((name: string) => [name, name === 'agent' ? '123' : String(2000 + Number(name.slice(4)))])),
        missing: (args.names ?? []).filter((name: string) => name !== 'agent' && !/^pin-\d+$/.test(name)), matches: [] })
    }
    if (path === `/api/orgs/${org}/changes`) {
      assert.equal(url.searchParams.get('org_uuid'), 'identity')
      assert.equal(url.searchParams.get('incarnation'), 'first')
      const after = Number(url.searchParams.get('after'))
      const answer = change(after, Math.max(after, 5), 'Recovered')
      if (holdChanges) return new Promise<Response>(resolve => { delayed.push({ answer, resolve }) })
      return json(answer)
    }
    if (path === '/api/providers') return json({ providers: [] })
    if (path.endsWith('/work-items')) return json({ items: [], counts: { attention: 0, active: 0, archived: 0, backlogged: 0 } })
    if (path.endsWith('/chat')) return json({ messages: [], live: [], pending_mail: [],
      busy: false, windowed: true, has_older: false, before: null, draft_epoch: 'fixture:0' })
    if (path.endsWith('/documents')) return json({ documents: [], total: 0 })
    if (path.endsWith('/inbox')) return json({ pending: [], delivered: [], sent: [] })
    return json({ ok: true })
  }) as typeof fetch)
  globals.WebSocket = Socket; globals.history = window.history; globals.CustomEvent = window.CustomEvent
  localStorage.clear(); resetConvos(); resetLocalReads(); resetPrimedAsks()
  window.history.replaceState(null, '', `/o/${org}`)
  const view = await mountView(<App />, el => el)
  function Metadata() {
    const node = useNodeMetadata(org, agent)
    return <span>{String((node as typeof node & { mcp_tool_count?: number }).mcp_tool_count ?? '')}</span>
  }
  const metadata = await mountView(<Metadata />, el => el)
  try {
    if (enabled) {
      assert.equal(reads.some(p => p.endsWith('/records')), false, 'capability has not arrived yet')
      await inAct(async () => {
        sockets[0].frame(runtime(8, 8))
        releaseForeground!()
        await flush(40)
      })
      assert.equal(metadata.el.textContent, '8', 'first runtime survives capability detection and delayed HTTP copy')
    }
    await inAct(async () => { await flush(40) })
    assert.equal(sockets.length, 1, 'capability transition keeps the existing socket')
    assert.match(sockets[0].url, new RegExp(`/api/orgs/${org}/ws`))
    assert.equal([...intervals.values()].includes(6000), !enabled, 'only the legacy path has a tree polling timer')
    assert.equal(reads.some(p => p.endsWith('/records')), enabled)
    if (!enabled) assert.match(document.title, new RegExp(org), 'legacy control loaded a valid tree')
    if (enabled) {
      assert.match(document.title, /Baseline/)
      const owner = {}, requestStart = reads.length
      const catchups = reads.filter(p => p.includes('/changes')).length
      await inAct(async () => {
        treeSelections.set(org, owner, { include: Array.from({ length: 300 }, (_, n) => `pin-${n}`) })
        await flush(20)
      })
      const pins = sent.filter(m => m.type === 'subscribe' && m.agents?.some(id => Number(id) >= 2000))
      assert.deepEqual(pins.map(m => m.agents!.length), [128, 128, 44], 'mounted 300-pin selection reaches the org socket')
      assert.equal(reads.slice(requestStart).some(p => p.includes('/foreground-tree') || p.endsWith('/tree')), false)
      assert.equal(reads.filter(p => p.includes('/changes')).length, catchups, 'selection lookup is a read, not a local mutation')
      await inAct(async () => { treeSelections.release(org, owner); await flush(20) })
      for (const pin of pins) assert.ok(sent.some(m => m.type === 'unsubscribe' && m.sub === pin.sub), 'closing releases each pin set')
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

      // An HTTP read already in flight cannot confirm a later local save or
      // detail. A live frame arriving after them is not proof either.
      holdChanges = true
      await inAct(async () => { sockets[0].onopen?.(); await flush(10) })
      assert.equal(delayed.length, 1)
      await advance(10)
      await inAct(async () => {
        await markReadNow(org, { id: 'mail' }, async () => {})
        const ask = { id: 'new-ask', node: 'agent', kind: 'batch', status: 'open', rev: 1,
          at: '2026-10-03T00:00:00Z', revs: { ask: 1 },
          tabs: [{ kind: 'question', question: 'Proceed?', options: [{ label: 'yes' }] }] } as AskInfo
        primeAsk(org, 'agent', ask)
        bumpLive()
        sockets[0].frame(change(5, 6, 'After save'))
        await flush(10)
      })
      const blank = { ...header, roots: [agent] } as unknown as TreePayload
      assert.equal(unconfirmedReads(org).all, 1, 'live frame cannot confirm a local read')
      assert.equal(applyPrimedAsks(org, blank, 0).roots[0].ask?.id, 'new-ask',
        'live frame preserves a detail overlay')
      await inAct(async () => { delayed[0].resolve(json(delayed[0].answer)); await flush(10) })
      assert.equal(unconfirmedReads(org).all, 1, 'delayed older HTTP read cannot confirm the save')
      assert.equal(applyPrimedAsks(org, blank, 0).roots[0].ask?.id, 'new-ask')
      await advance(150)
      assert.ok(delayed.length >= 3, 'prime and mutation acknowledgment each obtain a fresh confirmation')
      await inAct(async () => {
        for (const pending of delayed.slice(1)) pending.resolve(json(pending.answer))
        await flush(10)
      })
      assert.equal(unconfirmedReads(org).all, 0, 'HTTP no-op confirms the save despite a newer live cursor')
      assert.equal(applyPrimedAsks(org, blank, 0).roots[0].ask, undefined,
        'HTTP confirmation retires the detail overlay')
      assert.match(document.title, /After save/, 'delayed HTTP replies never roll back record state')
      assert.equal(reads.filter(p => p.includes('/foreground-tree')).length, before)
      holdChanges = false
      const readsBeforeRuntime = reads.length
      await inAct(async () => {
        sockets[0].frame(runtime(9, 9))
        sockets[0].frame(runtime(7, 7))
        sockets[0].frame({ type: 'node_stream', node: 'agent', kind: 'mcp_tool_count', count: 999 })
        await flush(10)
      })
      assert.equal(metadata.el.textContent, '9', 'ordered runtime owns metadata; old frames and legacy echoes cannot rewind it')
      assert.equal(reads.length, readsBeforeRuntime, 'runtime publication does not fetch')
      replacement = true
      const old = sockets[0], oldCallback = old.onmessage
      await inAct(async () => {
        old.frame({ ...change(0, 1, 'Replacement'), incarnation: 'replacement' })
        await flush(10)
      })
      assert.equal(old.readyState, 3, 'lower revision with a new identity renews the socket epoch')
      assert.equal(metadata.el.textContent, '', 'old host metadata is removed with the old identity')
      await advance(1500)
      assert.equal(sockets.length, 2)
      await inAct(async () => {
        sockets[1].frame(runtime(1, 1, 'new host', 'replacement'))
        oldCallback?.({ data: JSON.stringify(runtime(999, 999)) })
        await flush(10)
      })
      assert.equal(metadata.el.textContent, '1', 'new host lower sequence is accepted; old socket callback is fenced')
    }
  } finally {
    await metadata.unmount(); await view.unmount(); clearNodeMetadata(org)
    resetConvos(); resetLocalReads(); resetPrimedAsks(); localStorage.clear()
    window.history.replaceState(null, '', '/')
    Object.assign(globals, { fetch: saved.fetch, WebSocket: saved.socket, history: saved.history,
      CustomEvent: saved.customEvent, setInterval: saved.setInterval, clearInterval: saved.clearInterval })
    realClock()
  }
})
