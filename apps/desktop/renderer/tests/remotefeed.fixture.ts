// remotefeed.fixture.ts: the app feed as a window opens it, for tests of an
// organization on a remote engine (docs/rust-engine/remote-org.md). One
// socket, a first copy, then the pushed connection list `remotes`; every
// other request goes to `next`.
import assert from 'node:assert/strict'
import type { TestContext } from 'node:test'
import type { RemoteView } from '../src/remotes'
import { flush, inAct } from './harness'

let feeds = 0

export const remoteView = (patch: Partial<RemoteView> = {}): RemoteView => ({
  id: 'r1', name: 'Galaxy', tag: 'galaxy', url: 'http://100.64.0.7:7430', enabled: true, state: 'connected',
  since: '2026-11-11T10:00:00Z', next_attempt_at: null, version: '4.5.12', app_version: '4.5.12', version_differs: false,
  transport: 'tailscale', client_name: 'Orgtree desktop (TEST-PC)', own_token: true, last_error: null, error_code: null,
  refusal: null, last_connected_at: '2026-11-11T10:00:00Z',
  orgs: [{ alias: 'org', remote_slug: 'org', name: 'Org', local_id: -1, gone: false }],
  ...patch,
})

export function remoteFeed(t: TestContext, next: (url: string, init?: RequestInit) => Promise<Response> | Response) {
  const globals = globalThis as unknown as Record<string, unknown>
  const saved = { fetch: globals.fetch, WebSocket: globals.WebSocket }
  const sockets: Socket[] = []
  class Socket {
    onmessage: ((event: { data: string }) => void) | null = null
    onclose: (() => void) | null = null
    onerror: (() => void) | null = null
    constructor(readonly url: string) { sockets.push(this) }
    close() { this.onclose?.() }
    frame(value: unknown) { this.onmessage?.({ data: JSON.stringify(value) }) }
  }
  // the feed's state is one per document: each test is its own epoch, so nothing of the last one stays
  const epoch = 'remotefeed' + (++feeds)
  const copy = { type: 'app_snapshot', epoch, seq: 1,
    registry: { type: 'registry_snapshot', epoch, cursor: { app_uuid: 'app', incarnation: epoch, rev: 1 }, records: [] },
    summaries: {}, notices: {}, runtime: { values: {}, orgs: {} } }
  globals.WebSocket = Socket
  globals.fetch = async (input: unknown, init?: RequestInit) =>
    String(input) === '/api/app/records' ? new Response(JSON.stringify(copy)) : next(String(input), init)
  t.after(() => { Object.assign(globals, saved) })
  let seq = 1
  return {
    /** open the feed and push the connection list; `values`: more pushed values of that engine */
    async remotes(list: RemoteView[], here?: RemoteView, values: Record<string, unknown> = {}) {
      await inAct(() => flush(8))
      assert.ok(sockets.length >= 1, 'the app feed opened its socket')
      const socket = sockets[sockets.length - 1]!
      if (seq === 1) await inAct(() => socket.frame(copy))
      seq += 1
      // `here`: this window is one of that connection's (the composed feed's `remote_link`)
      await inAct(() => socket.frame({ type: 'app_runtime', epoch, seq,
        values: { remotes: { epoch, seq, value: list }, ...(here ? { remote_link: { epoch, seq, value: here } } : {}),
          ...Object.fromEntries(Object.entries(values).map(([key, value]) => [key, { epoch, seq, value }])) } }))
      await inAct(() => flush(4))
    },
  }
}
