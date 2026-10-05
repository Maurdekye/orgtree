import { advance, flush, inAct, mountView, realClock, useFakeClock } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { useOrgStatus } from '../src/orgstatus'
import { useAppRead, useAppReadout } from '../src/appfeed'

test('org list joins app frames, keeps unavailable Retry rows and shares one socket without polling', async () => {
  useFakeClock()
  const globals = globalThis as unknown as Record<string, unknown>
  const saved = { fetch: globals.fetch, WebSocket: globals.WebSocket }
  const requests: string[] = [], sockets: Socket[] = []
  let manualCalls = 0, finishManual: (value: string) => void = () => {}
  let readout: ReturnType<typeof useAppReadout<string>>
  class Socket {
    onmessage: ((event: { data: string }) => void) | null = null
    onclose: (() => void) | null = null
    onerror: (() => void) | null = null
    closed = false
    constructor(readonly url: string) { sockets.push(this) }
    close() { this.closed = true; this.onclose?.() }
    frame(value: unknown) { this.onmessage?.({ data: JSON.stringify(value) }) }
  }
  const epoch = 'app-org-list-test'
  const row = (org_id: number, slug: string, state = 'active') => ({ entity: 'registry_org', id: String(org_id),
    body: { org_id, slug, org_uuid: `u${org_id}`, state, state_reason: state === 'unavailable' ? 'retry migration' : null,
      unavailable_step: null, attempts: 0, report_path: null } })
  const registry = { type: 'registry_snapshot', epoch,
    cursor: { app_uuid: 'app', incarnation: 'i', rev: 1 }, records: [row(1, 'one'), row(2, 'two', 'unavailable'), row(3, 'three', 'trashed')] }
  const summary = { type: 'org_summary', epoch, seq: 3, org_id: 1, org_uuid: 'u1', incarnation: 'i', rev: 99,
    body: { name: 'Current name', nodes: 8, live: 5, created: null, net_slug: null, cost_usd_total: 12 } }
  const copy = { type: 'app_snapshot', epoch, seq: 1, registry, summaries: {}, notices: {},
    runtime: { values: {}, orgs: {} } }
  globals.WebSocket = Socket
  globals.fetch = async (url: string) => {
    requests.push(String(url))
    assert.equal(String(url), '/api/app/records', 'no legacy org-list or provider request')
    return { ok: true, headers: new Headers(), json: async () => copy }
  }
  function Probe() {
    const status = useOrgStatus({ active: true })
    const provider = useAppRead<string>('providers', async () => { throw Error('unexpected legacy provider read') })
    readout = useAppReadout('registered_usage', () => {
      manualCalls++
      return new Promise<string>(resolve => { finishManual = resolve })
    }, 'account-a')
    return <pre>{JSON.stringify({ orgs: status.orgs, freshness: status.freshness, known: status.known,
      provider, usage: readout.value })}</pre>
  }
  let mounted: Awaited<ReturnType<typeof mountView>> | undefined
  try {
    mounted = await mountView(<Probe />, el => el.textContent)
    await flush()
    assert.equal(sockets.length, 1)
    const socket = sockets[0]
    await inAct(() => socket.frame(copy))
    await flush()
    let view = JSON.parse(mounted.el.textContent ?? '{}')
    assert.equal(view.orgs[0].name, 'one', 'slug fallback until first org snapshot')
    assert.deepEqual(view.orgs.map((r: { slug: string }) => r.slug), ['one', 'two'])
    await inAct(() => socket.frame(summary))
    await inAct(() => socket.frame({ type: 'app_runtime', epoch, seq: 6,
      orgs: { '1': { epoch, seq: 4, working: 2 } }, values: { providers: { epoch, seq: 5, value: 'ready' } } }))
    await flush()
    view = JSON.parse(mounted.el.textContent ?? '{}')
    assert.equal(view.orgs[0].name, 'Current name')
    assert.equal(view.orgs[0].working, 2)
    assert.equal(view.orgs[1].nodes, 0)
    assert.equal(view.orgs[1].state, 'unavailable')
    assert.equal(view.provider, 'ready')
    assert.equal(view.freshness, 'current')
    await inAct(() => { void readout.refresh(true) })
    await flush()
    assert.equal(manualCalls, 1)
    await inAct(() => socket.frame({ type: 'app_runtime', epoch, seq: 8,
      values: { registered_usage: { epoch, seq: 8, value: { 'account-a': 'pushed' } } } }))
    await inAct(() => finishManual('delayed manual response'))
    await flush()
    assert.equal(JSON.parse(mounted.el.textContent ?? '{}').usage, 'pushed', 'newer push wins over manual response')
    const before = requests.length
    await advance(120000)
    assert.equal(requests.length, before, 'two minutes without any timer fetch')
    assert.equal(manualCalls, 1, 'usage does not start a timer read')
    await inAct(() => socket.close())
    await flush()
    assert.equal(JSON.parse(mounted.el.textContent ?? '{}').freshness, 'stale')
  } finally {
    await mounted?.unmount()
    Object.assign(globals, saved)
    realClock()
  }
})

test('an unsupported app feed retains legacy periodic reads', async () => {
  useFakeClock()
  const original = globalThis.fetch
  let calls = 0
  globalThis.fetch = async () => new Response(JSON.stringify({ detail: 'disabled' }), { status: 501 })
  function Probe() {
    const value = useAppRead('legacy-provider', async () => ++calls)
    return <pre>{value}</pre>
  }
  let mounted: Awaited<ReturnType<typeof mountView>> | undefined
  try {
    mounted = await mountView(<Probe />, el => el.textContent)
    await flush()
    assert.equal(calls, 1)
    await advance(60000)
    assert.equal(calls, 2)
    assert.equal(mounted.el.textContent, '2')
    await mounted.unmount(); mounted = undefined
    await advance(60000)
    assert.equal(calls, 2, 'unmount removes the legacy timer')
  } finally {
    await mounted?.unmount()
    globalThis.fetch = original
    realClock()
  }
})
