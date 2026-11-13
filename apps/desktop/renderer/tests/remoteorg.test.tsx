// remoteorg.test.tsx — remote engines in the desktop (docs/rust-engine/remote-org.md):
// the list group and its marks, rows of an engine that is away, the Add
// dialog and its refusal, the window's chip and its banner. The connection
// list arrives as the app-feed value `remotes`, as it does in the app.
//
// Run:  node tests/run.mjs remoteorg
import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { OrgRows } from '../src/App'
import { projectOrgs } from '../src/recordprojection'
import { remoteBanner, remoteTitle, stateWord, transportLabel, type RemoteView } from '../src/remotes'
import { RemoteBanner, RemoteChip } from '../src/shell/remotes'
import { AppFeedState } from '../../../../packages/contracts/app-feed'
import type { OrgListEntry } from '../src/types'

const remote = (patch: Partial<RemoteView> = {}): RemoteView => ({
  id: 'r1', name: 'Galaxy', tag: 'galaxy', url: 'http://100.64.0.7:7430', enabled: true, state: 'connected',
  since: '2026-11-11T10:00:00Z', next_attempt_at: null, version: '4.5.12', app_version: '4.5.12', version_differs: false,
  transport: 'tailscale', client_name: 'Orgtree desktop (TEST-PC)', own_token: true, last_error: null, error_code: null,
  last_connected_at: '2026-11-11T10:00:00Z',
  orgs: [{ alias: 'acme-galaxy', remote_slug: 'acme', name: 'Acme', local_id: -1, gone: false },
    { alias: 'beta', remote_slug: 'beta', name: 'Beta', local_id: -2, gone: false }],
  ...patch,
})
const mark = (slug: string, state = 'connected') => ({ id: 'r1', name: 'Galaxy', tag: 'galaxy', slug, state })

let feeds = 0

/** The app feed as the renderer opens it: one socket, a first copy, then the
 *  pushed `remotes` value; every HTTP call is recorded and answered by `answer`. */
function appFeed(t: TestContext, answer: (url: string, init?: RequestInit) => Response | undefined = () => undefined) {
  const globals = globalThis as unknown as Record<string, unknown>
  const saved = { fetch: globals.fetch, WebSocket: globals.WebSocket }
  const calls: { url: string; method: string; body: unknown }[] = []
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
  const epoch = 'e' + (++feeds)
  const copy = { type: 'app_snapshot', epoch, seq: 1,
    registry: { type: 'registry_snapshot', epoch, cursor: { app_uuid: 'app', incarnation: epoch, rev: 1 }, records: [] },
    summaries: {}, notices: {}, runtime: { values: {}, orgs: {} } }
  globals.WebSocket = Socket
  globals.fetch = async (input: unknown, init?: RequestInit) => {
    const url = String(input)
    if (url === '/api/app/records') return new Response(JSON.stringify(copy))
    calls.push({ url, method: init?.method ?? 'GET', body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined })
    return answer(url, init) ?? new Response(JSON.stringify({}))
  }
  t.after(() => { Object.assign(globals, saved) })
  let seq = 1
  return {
    calls,
    /** open the feed and push the connection list */
    async remotes(list: RemoteView[]) {
      await inAct(() => flush(8))
      assert.ok(sockets.length >= 1, 'the app feed opened its socket')
      const socket = sockets[sockets.length - 1]!
      if (seq === 1) await inAct(() => socket.frame(copy))
      seq += 1
      await inAct(() => socket.frame({ type: 'app_runtime', epoch, seq,
        values: { remotes: { epoch, seq, value: list } } }))
      await inAct(() => flush(4))
    },
  }
}

test('the banner says what is the matter and names the one thing to do', () => {
  const clock = () => '12:00'
  const now = Date.parse('2026-11-11T10:05:00Z')
  assert.equal(remoteBanner(remote(), now, clock), null, 'connected: no banner')
  assert.deepEqual(remoteBanner(remote({ state: 'connecting' }), now, clock), { text: 'Connecting to Galaxy...', action: null, label: null })
  assert.deepEqual(remoteBanner(remote({ state: 'offline', next_attempt_at: '2026-11-11T10:05:08Z' }), now, clock),
    { text: 'Galaxy is offline since 12:00. Showing the last known state; nothing can be changed. Reconnecting in 8 s.', action: 'retry', label: 'Retry now' })
  assert.match(remoteBanner(remote({ state: 'offline', next_attempt_at: '2026-11-11T10:04:59Z' }), now, clock)!.text, /Reconnecting now\.$/)
  assert.deepEqual(remoteBanner(remote({ state: 'auth_failed' }), now, clock),
    { text: "Galaxy no longer accepts this computer's token.", action: 'token', label: 'Enter a new token' })
  assert.deepEqual(remoteBanner(remote({ state: 'refused', last_error: 'Galaxy runs Orgtree 4.5.10. This app needs 4.5.11 or later on the remote engine.' }), now, clock),
    { text: 'Galaxy runs Orgtree 4.5.10. This app needs 4.5.11 or later on the remote engine.', action: 'details', label: 'Connection details' })
  assert.deepEqual(remoteBanner(remote({ state: 'paused' }), now, clock), { text: 'Disconnected from Galaxy.', action: 'connect', label: 'Connect' })
  assert.deepEqual(['connected', 'connecting', 'offline', 'auth_failed', 'refused', 'paused'].map((s) => stateWord(s as RemoteView['state'])),
    [null, 'connecting', 'offline', 'sign-in needed', 'can’t connect', 'paused'])
  assert.deepEqual(['https', 'tailscale', 'private-http', 'loopback', null].map((x) => transportLabel(x as RemoteView['transport'])),
    ['Encrypted (https)', 'Tailscale', 'Private network, not encrypted (http)', 'This computer (forwarded port)', 'Not connected'])
  assert.equal(remoteTitle(remote(), mark('acme'), 'acme-galaxy'), 'On Galaxy (remote engine) · http://100.64.0.7:7430 · named acme there')
  assert.equal(remoteTitle(remote(), mark('beta'), 'beta'), 'On Galaxy (remote engine) · http://100.64.0.7:7430')
})

test('remote organizations follow this computer’s own in the list and keep their mark', () => {
  const app = new AppFeedState()
  const body = (org_id: number, slug: string, extra: object = {}) => ({ org_id, slug, org_uuid: `u-${slug}`, state: 'active',
    unavailable_step: null, state_reason: null, attempts: 0, report_path: null, ...extra })
  const rows = [body(-2, 'beta', { remote: mark('beta') }), body(7, 'zeta'), body(-1, 'acme-galaxy', { remote: mark('acme') }), body(3, 'alpha')]
  const records = new Map([['registry_org', new Map(rows.map((r) => [String(r.org_id), r]))]])
  const orgs = projectOrgs(records as never, app)
  assert.deepEqual(orgs.map((o) => o.slug), ['alpha', 'zeta', 'acme-galaxy', 'beta'], 'local first, then the engine’s, by name')
  assert.deepEqual(orgs.map((o) => o.remote?.slug ?? null), [null, null, 'acme', 'beta'])
})

const ORGS: OrgListEntry[] = [
  { slug: 'home', name: 'Home', nodes: 3, live: 2, working: 1, created: null },
  { slug: 'acme-galaxy', name: 'Acme', nodes: 4, live: 3, working: 2, created: null, remote: mark('acme') },
  { slug: 'beta', name: 'Beta', nodes: 2, live: 1, working: 0, created: null, remote: mark('beta') },
]

test('the list groups a remote engine’s organizations under its heading, marked; an engine that is away shows no numbers', async (t) => {
  const feed = appFeed(t)
  const picked: string[] = []
  const view = await mountView(<OrgRows orgs={ORGS} slug={null} onPick={(s) => picked.push(s)} onDelete={() => {}} />, (el) => el)
  t.after(() => view.unmount())
  await feed.remotes([remote(), remote({ id: 'r2', name: 'Moon', tag: 'moon', url: 'https://moon.example', orgs: [], state: 'offline' })])
  const el = view.el
  // this computer's organization is as before, outside any group
  const rows = [...el.querySelectorAll('.org')]
  assert.deepEqual(rows.map((r) => r.querySelector('.org-name-text')!.textContent), ['Home', 'Acme', 'Beta'])
  assert.equal(rows[0]!.closest('.org-remote-group'), null)
  assert.equal(rows[0]!.querySelector('.org-remote-mark'), null)
  assert.equal(rows[0]!.querySelector('.org-counts')!.textContent, '1/2')
  // each engine has its heading, also the one with no organization; the state word shows when it is not connected
  const heads = [...el.querySelectorAll('.org-remote-head')]
  assert.deepEqual(heads.map((h) => h.textContent), ['Galaxy', 'Moonoffline'])
  assert.deepEqual(heads.map((h) => h.querySelector('.org-remote-head-state')?.textContent ?? null), [null, 'offline'])
  // the remote rows sit in their engine's group, carry the mark and say where they are
  for (const row of rows.slice(1)) {
    assert.equal(row.closest('.org-remote-group')!.getAttribute('aria-label'), 'organizations on Galaxy')
    assert.ok(row.querySelector('.org-remote-mark'), 'the remote glyph before the name')
  }
  assert.equal(rows[1]!.getAttribute('title'), 'On Galaxy (remote engine) · http://100.64.0.7:7430 · named acme there')
  assert.equal(rows[1]!.querySelector('.org-counts')!.textContent, '2/3')
  assert.ok(rows[1]!.querySelector('.cc-spin'), 'a connected remote organization with a turn running spins')
  // a remote row opens like any organization, by its alias
  await inAct(() => { (rows[1] as HTMLElement).click() })
  assert.deepEqual(picked, ['acme-galaxy'])
  // the engine goes away: the rows stay, claim nothing, and the heading says so
  const away = ORGS.map((o) => o.remote ? { ...o, remote: mark(o.remote.slug, 'offline') } : o)
  await view.render(<OrgRows orgs={away} slug={null} onPick={(s) => picked.push(s)} onDelete={() => {}} />)
  await feed.remotes([remote({ state: 'offline' })])
  const after = [...el.querySelectorAll('.org')]
  assert.deepEqual(after.map((r) => r.querySelector('.org-name-text')!.textContent), ['Home', 'Acme', 'Beta'], 'the rows stay')
  assert.equal(after[1]!.querySelector('.org-counts')!.textContent, '', 'no numbers are offered for an engine that is away')
  assert.equal(after[1]!.querySelector('.cc-spin'), null, 'and nothing spins')
  assert.ok(after[1]!.className.includes('org-remote-away'))
  assert.equal(el.querySelector('.org-remote-head-state')!.textContent, 'offline')
  // the way to add one is under the list
  assert.equal(el.querySelector('.org-remote-add')!.textContent!.trim(), 'Add a remote engine...')
})

test('Add a remote engine sends what was typed, shows a refusal under the fields and keeps them; success closes', async (t) => {
  let refuse = true
  const feed = appFeed(t, (url, init) => {
    if (url !== '/api/remotes' || init?.method !== 'POST') return undefined
    return refuse
      ? new Response(JSON.stringify({ detail: "That engine didn't accept the token.", code: 'E4' }), { status: 403 })
      : new Response(JSON.stringify(remote()))
  })
  const view = await mountView(<OrgRows orgs={[]} slug={null} onPick={() => {}} onDelete={() => {}} />, (el) => el)
  t.after(() => view.unmount())
  await feed.remotes([])
  const doc = view.el.ownerDocument
  await inAct(() => { (view.el.querySelector('.org-remote-add') as HTMLElement).click() })
  const field = (label: string) => doc.querySelector(`input[aria-label="${label}"]`) as HTMLInputElement
  assert.ok(field('Engine address') && field('Engine token') && field('Engine name'), 'the three fields')
  assert.equal(field('Engine token').type, 'password')
  assert.equal(field('Engine address').getAttribute('data-streamer-field'), 'ip', 'Streamer mode masks the address like other addresses')
  const type = async (input: HTMLInputElement, value: string) => {
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value')!.set!
    await inAct(() => { setter.call(input, value); input.dispatchEvent(new (doc.defaultView!.Event)('input', { bubbles: true })) })
  }
  const button = (text: string) => [...doc.querySelectorAll('button')].find((b) => b.textContent === text) as HTMLButtonElement
  assert.equal(button('Connect').disabled, true, 'nothing to send yet')
  await type(field('Engine address'), 'http://100.64.0.7:7430')
  await type(field('Engine token'), 'pasted-token')
  await type(field('Engine name'), 'Galaxy')
  assert.equal(button('Connect').disabled, false)
  await inAct(() => { button('Connect').click() })
  await inAct(() => flush(8))
  assert.deepEqual(feed.calls.filter((c) => c.url === '/api/remotes'), [{ url: '/api/remotes', method: 'POST',
    body: { url: 'http://100.64.0.7:7430', token: 'pasted-token', name: 'Galaxy' } }])
  assert.equal(doc.querySelector('.remote-add-error')!.textContent, "That engine didn't accept the token.")
  assert.equal(field('Engine address').value, 'http://100.64.0.7:7430', 'the fields stay')
  refuse = false
  await inAct(() => { button('Connect').click() })
  await inAct(() => flush(8))
  assert.equal(doc.querySelector('input[aria-label="Engine address"]'), null, 'the dialog closed')
})

test('the window’s chip shows the connection, and the banner offers the retry; a local organization has neither', async (t) => {
  const feed = appFeed(t, (url) => url === '/api/remotes/r1/retry' ? new Response(JSON.stringify(remote())) : undefined)
  const view = await mountView(<div>
    <span id="remote"><RemoteChip slug="beta" /></span><span id="local"><RemoteChip slug="home" /></span>
    <div id="banner"><RemoteBanner slug="beta" /></div><div id="local-banner"><RemoteBanner slug="home" /></div>
  </div>, (el) => el)
  t.after(() => view.unmount())
  await feed.remotes([remote()])
  const chip = () => view.el.querySelector('#remote .remote-chip')
  assert.equal(chip()!.textContent!.trim(), 'Galaxy')
  assert.ok(chip()!.className.includes(' ok'), 'connected')
  assert.match(chip()!.getAttribute('title')!, /^Remote engine Galaxy · http:\/\/100\.64\.0\.7:7430 · connected since /)
  assert.equal(view.el.querySelector('#local')!.textContent, '', 'a local organization has no chip')
  assert.equal(view.el.querySelector('#banner')!.textContent, '', 'connected: no banner')
  // a version difference is a warning, not an error
  await feed.remotes([remote({ version: '4.5.11', version_differs: true })])
  assert.ok(chip()!.className.includes(' warn'))
  // away: the chip turns bad and names the state; the banner explains and offers the retry
  await feed.remotes([remote({ state: 'offline', next_attempt_at: new Date(Date.now() + 20000).toISOString() })])
  assert.ok(chip()!.className.includes(' bad'))
  assert.equal(chip()!.textContent!.trim(), 'Galaxy: offline')
  const banner = view.el.querySelector('#banner .remote-banner')!
  assert.match(banner.textContent!, /^Galaxy is offline since .+\. Showing the last known state; nothing can be changed\. Reconnecting in \d+ s\.Retry now$/)
  assert.equal(view.el.querySelector('#local-banner')!.textContent, '', 'a local organization has no banner')
  await inAct(() => { (banner.querySelector('button') as HTMLButtonElement).click() })
  await inAct(() => flush(8))
  assert.deepEqual(feed.calls.filter((c) => c.url.startsWith('/api/remotes')), [{ url: '/api/remotes/r1/retry', method: 'POST', body: undefined }])
  // back: the banner says so, once
  await feed.remotes([remote()])
  assert.equal(view.el.querySelector('#banner')!.textContent, 'Reconnected to Galaxy.')
})

test('Connection details opens from the chip; Streamer mode masks the address and this computer’s name', async (t) => {
  const feed = appFeed(t)
  const view = await mountView(<span id="remote"><RemoteChip slug="beta" /></span>, (el) => el)
  t.after(() => view.unmount())
  await feed.remotes([remote()])
  const doc = view.el.ownerDocument
  await inAct(() => { (view.el.querySelector('.remote-chip') as HTMLElement).click() })
  const rows = () => Object.fromEntries([...doc.querySelectorAll('.remote-details .set-row')].map((row) => {
    const control = row.querySelector('.set-control')!
    return [row.querySelector('.set-label')!.textContent!.trim(), control]
  }))
  assert.deepEqual(Object.keys(rows()), ['Name', 'Address', 'State', 'Transport', 'Remote engine version', 'Signed in as',
    'Shown to others as', 'Also connected', 'Organizations'])
  assert.equal(rows().Transport!.textContent, 'Tailscale')
  assert.equal(rows().Organizations!.textContent, 'Acme, Beta')
  const masked = (label: string) => rows()[label]!.querySelector('[data-streamer-field]')
  assert.equal(masked('Address')!.getAttribute('data-streamer-field'), 'ip')
  assert.equal(masked('Address')!.textContent, 'http://100.64.0.7:7430')
  // "Orgtree desktop (<computer>)" holds this computer's name: a host field, masked like the address
  assert.equal(masked('Signed in as')?.getAttribute('data-streamer-field'), 'ip', 'the computer name is a host field')
  assert.equal(masked('Signed in as')!.textContent, 'Orgtree desktop (TEST-PC)')
  // without a token of its own there is no computer name to mask
  await feed.remotes([remote({ client_name: null, own_token: false })])
  assert.equal(rows()['Signed in as']!.textContent, 'the pasted token')
  assert.equal(masked('Signed in as'), null)
})
