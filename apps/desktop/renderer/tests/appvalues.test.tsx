import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { UsageModal } from '../src/App'

test('Usage receives accounts and usage after an empty app snapshot, then replaces them on reconnect', async () => {
  const globals = globalThis as unknown as Record<string, unknown>
  const saved = { fetch: globals.fetch, WebSocket: globals.WebSocket }
  const requests: string[] = [], sockets: Socket[] = []
  class Socket {
    onmessage: ((event: { data: string }) => void) | null = null
    onclose: (() => void) | null = null
    onerror: (() => void) | null = null
    constructor(readonly url: string) { sockets.push(this) }
    close() { this.onclose?.() }
    frame(value: unknown) { this.onmessage?.({ data: JSON.stringify(value) }) }
  }
  const copy = (epoch: string) => ({ type: 'app_snapshot', epoch, seq: 1,
    registry: { type: 'registry_snapshot', epoch,
      cursor: { app_uuid: 'app', incarnation: epoch, rev: 1 }, records: [] },
    summaries: {}, notices: {}, runtime: { values: {}, orgs: {} } })
  globals.WebSocket = Socket
  globals.fetch = async (input: unknown) => {
    requests.push(String(input))
    assert.equal(String(input), '/api/app/records', 'capable clients must not fetch legacy usage or accounts')
    return new Response(JSON.stringify(copy('http-probe')))
  }
  const runtime = (epoch: string, email: string) => ({ type: 'app_runtime', epoch, seq: 2,
    values: Object.fromEntries(Object.entries({
      providers: { providers: ['claude', 'openai', 'google', 'openrouter'].map(id => ({
        id, hire_enabled: id === 'claude', status: { installed: id === 'claude' } })) },
      accounts: { accounts: [
        { id: 'claude-1', provider: 'claude', ambient: true, identity: { email } },
        { id: 'claude-4', provider: 'claude', identity: { email: 'secondary@example.test' } },
      ] },
      usage: { available: true, email, limits: [] },
      registered_usage: { 'claude-4': { available: true, limits: [] } },
    }).map(([key, value]) => [key, { epoch, seq: 2, value }])) })
  let view: Awaited<ReturnType<typeof mountView>> | undefined
  try {
    view = await mountView(<UsageModal close={() => {}} toast={() => {}} />, el => el)
    await inAct(() => flush(8))
    assert.equal(sockets.length, 1, 'all app consumers share one socket')
    assert.match(sockets[0].url, /\/api\/app\/ws$/)
    await inAct(() => sockets[0].frame(copy('first')))
    assert.doesNotMatch(view.el.textContent ?? '', /first@example.test|secondary@example.test/)
    await inAct(() => sockets[0].frame(runtime('first', 'first@example.test')))
    const heads = () => [...view!.el.querySelectorAll('.usage-acct-who')].map(el => el.textContent)
    assert.deepEqual(heads(), ['Claude Code · default · first@example.test',
      'Claude Code · claude-4 · secondary@example.test'])
    await view.unmount(); view = undefined
    view = await mountView(<UsageModal close={() => {}} toast={() => {}} />, el => el)
    await inAct(() => flush(8))
    assert.equal(sockets.length, 2)
    await inAct(() => sockets[1].frame(copy('replacement')))
    assert.doesNotMatch(view.el.textContent ?? '', /first@example.test|secondary@example.test/,
      'a new epoch clears previously loaded app values')
    await inAct(() => sockets[1].frame(runtime('replacement', 'next@example.test')))
    assert.deepEqual(heads(), ['Claude Code · default · next@example.test',
      'Claude Code · claude-4 · secondary@example.test'])
    assert.deepEqual(requests, ['/api/app/records', '/api/app/records'])
  } finally {
    await view?.unmount()
    Object.assign(globals, saved)
  }
})
