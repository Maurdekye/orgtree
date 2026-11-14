// remoteaccess.test.tsx — remote access on the hosting desktop
// (docs/rust-engine/remote-org.md, "A desktop as host"): the Remote access
// block of an organization's Connections tab. Test F-T8 of the amendment.
//
// The overview arrives as the app-feed value `remote_access`, as it does in
// the app; every HTTP call is recorded and answered here; the desktop's bridge
// is a recorder, so no test asks Windows for anything.
//
// Run:  node tests/run.mjs remoteaccess
import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { RemoteAccess, RemoteAccessSettings, SharedChip } from '../src/canvas/remoteaccess'
import { RemoteBanner, RemoteChip, RemoteEngineDialog } from '../src/shell/remotes'
import { addressWithCode, noLongerShared, type RemoteView } from '../src/remotes'
import { addressAndCode, addressNote, allowDoor, changeListening, computerSeen, computersWord, connectedChip, doorTrouble, doorWord,
  removeDoorRules, turnOnOrgAccess, validPort, wantsFirewallRule,
  type ComputerView, type DoorView, type OrgAccessView, type RemoteAccessView } from '../src/remoteaccess'

const URL = 'http://home-pc.tail1234.ts.net:7431'
const door = (patch: Partial<DoorView> = {}): DoorView => ({
  state: 'open', reason: null, port: 7431, lan: false,
  addresses: [{ kind: 'tailscale', ip: '100.64.0.9', port: 7431, url: URL, encrypted: true }],
  firewall: { state: 'ok', present: true }, ...patch,
})
const shut = (firewall: NonNullable<DoorView['firewall']>['state'] = 'missing'): DoorView =>
  door({ state: 'closed', addresses: [], firewall: { state: firewall, present: false } })
const computer = (patch: Partial<ComputerView> = {}): ComputerView => ({
  id: 'c1', name: 'Orgtree desktop (LAPTOP)', label: 'Dana', orgs: ['acme'], created_at: '2026-11-12T09:00:00Z',
  connected: true, connected_since: '2026-11-13T10:00:00Z', last_seen_at: '2026-11-13T10:00:00Z', ...patch,
})
const orgView = (patch: Partial<OrgAccessView> = {}): OrgAccessView => ({
  slug: 'acme', on: true, door: door(), computers: [], known: [], invitations: [],
  limits: { computers: 32, invitations: 5, minutes: 15 }, ...patch,
})
const overview = (on: boolean, at: DoorView, computers: ComputerView[] = []): RemoteAccessView => ({
  computer: 'HOME-PC', port: 7431, default_port: 7431, lan: at.lan, door: at,
  orgs: [
    { slug: 'acme', name: 'Acme', on, computers: computers.length, connected: computers.filter((c) => c.connected).length,
      connected_now: computers.filter((c) => c.connected).map((c) => ({ id: c.id, label: c.label, name: c.name, since: c.connected_since })) },
    { slug: 'beta', name: 'Beta', on: false, computers: 0, connected: 0, connected_now: [] },
  ],
})

type Call = { url: string; method: string; body: unknown }
let feeds = 0

/** The app feed as the renderer opens it (one socket, a first copy, then
 *  pushed values), every HTTP call recorded and answered by `answer`, and a
 *  log that the bridge's recorder writes into as well, so the order of what
 *  was asked of the engine and of Windows can be read off one list. */
function world(t: TestContext, answer: (call: Call) => unknown) {
  const globals = globalThis as unknown as Record<string, unknown>
  const saved = { fetch: globals.fetch, WebSocket: globals.WebSocket }
  const log: string[] = []
  const calls: Call[] = []
  const sockets: Socket[] = []
  class Socket {
    onmessage: ((event: { data: string }) => void) | null = null
    onclose: (() => void) | null = null
    onerror: (() => void) | null = null
    constructor(readonly url: string) { sockets.push(this) }
    close() { this.onclose?.() }
    frame(value: unknown) { this.onmessage?.({ data: JSON.stringify(value) }) }
  }
  const epoch = 'ra' + (++feeds)
  const copy = { type: 'app_snapshot', epoch, seq: 1,
    registry: { type: 'registry_snapshot', epoch, cursor: { app_uuid: 'app', incarnation: epoch, rev: 1 }, records: [] },
    summaries: {}, notices: {}, runtime: { values: {}, orgs: {} } }
  globals.WebSocket = Socket
  globals.fetch = async (input: unknown, init?: RequestInit) => {
    const url = String(input)
    if (url === '/api/app/records') return new Response(JSON.stringify(copy))
    const call = { url, method: init?.method ?? 'GET', body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined }
    calls.push(call)
    log.push(`${call.method} ${url}`)
    const said = answer(call)
    if (said instanceof Response) return said
    return new Response(JSON.stringify(said ?? {}))
  }
  t.after(() => { Object.assign(globals, saved) })
  let seq = 1
  return {
    log, calls,
    /** open the feed (once) and push app values */
    async push(values: Record<string, unknown>) {
      await inAct(() => flush(8))
      assert.ok(sockets.length >= 1, 'the app feed opened its socket')
      const socket = sockets[sockets.length - 1]!
      if (seq === 1) await inAct(() => socket.frame(copy))
      seq += 1
      const at = seq
      await inAct(() => socket.frame({ type: 'app_runtime', epoch, seq: at,
        values: Object.fromEntries(Object.entries(values).map(([key, value]) => [key, { epoch, seq: at, value }])) }))
      await inAct(() => flush(6))
    },
  }
}

/** The desktop's bridge as a recorder: what it was asked, and what the prompt "came to". */
function bridge(t: TestContext, log: string[], result: () => { ok: true } | { ok: false; declined: boolean; error: string }) {
  const host = window as unknown as Record<string, unknown>
  const saved = host.orgtreeDesktop
  host.orgtreeDesktop = {
    addRemoteAccessFirewallRule: async (port: number, lan: boolean) => { log.push(`firewall ${port} ${lan}`); return result() },
    removeRemoteAccessFirewallRule: async () => { log.push('firewall remove'); return result() },
  }
  t.after(() => { host.orgtreeDesktop = saved })
}

test('the words: the door, an address, a computer, the chip', () => {
  assert.equal(doorTrouble(shut()), null, 'nothing is shared: nothing to say')
  assert.equal(doorTrouble(door()), null)
  assert.equal(doorTrouble(door({ reason: 'Port 7431 is taken by another program.' })), 'Port 7431 is taken by another program.',
    'open at one address, not at the other')
  assert.equal(doorTrouble(door({ state: 'waiting', addresses: [], reason: 'Tailscale is not running on this computer.' })),
    'Tailscale is not running on this computer.')
  assert.equal(doorTrouble(door({ state: 'blocked', addresses: [], reason: null })), 'The port is taken by another program.')
  assert.deepEqual(['tailscale', 'lan', 'local', 'rig'].map((kind) => addressNote({ kind: kind as 'tailscale' })),
    ['Tailscale', 'Private network, not encrypted (http)', 'This computer only: for an SSH tunnel or a local https proxy', 'This computer'])
  const time = () => '12:00', day = () => 'Nov 12, 2026'
  assert.equal(computerSeen(computer(), time, day), 'connected since 12:00')
  assert.equal(computerSeen(computer({ connected: false, connected_since: null }), time, day), 'last seen Nov 12, 2026')
  assert.equal(computerSeen(computer({ connected: false, connected_since: null, last_seen_at: null }), time, day), 'not connected yet')
  assert.equal(addressAndCode(URL, 'ABCDEFGHJKMNPQRSTVWXYZ0123'), `${URL} ABCDEFGHJKMNPQRSTVWXYZ0123`)
  assert.equal(connectedChip(undefined), null)
  assert.equal(connectedChip({ connected: 0, connected_now: [] }), null, 'nobody is connected: no chip')
  assert.deepEqual(connectedChip({ connected: 1, connected_now: [{ id: 'c1', label: 'Dana', name: 'x', since: null }] }),
    { text: '1 computer connected', title: 'Dana' })
  assert.deepEqual(connectedChip({ connected: 2, connected_now: [{ id: 'c1', label: 'Dana', name: 'x', since: null }, { id: 'c2', label: 'Lee', name: 'y', since: null }] }),
    { text: '2 computers connected', title: 'Dana, Lee' })
  // the rules are asked for only where there is a desktop to ask Windows, and only when they are missing or unreadable
  const can = { addRemoteAccessFirewallRule: async () => ({ ok: true as const }) }
  assert.deepEqual((['missing', 'unknown', 'ok', 'none'] as const).map((state) => wantsFirewallRule(shut(state), can)), [true, true, false, false])
  assert.equal(wantsFirewallRule(shut('missing'), undefined), false, 'a browser page has no bridge')
  assert.equal(wantsFirewallRule({ ...shut(), firewall: undefined }, can), false, 'an engine that does not say')
})

test('turning on asks the engine first, then Windows, then turns the switch: and stops at the first No', async (t) => {
  let fresh: OrgAccessView = orgView({ on: false, door: shut(), refusal: 'Tailscale is not running on this computer.' })
  const w = world(t, (call) => call.method === 'GET' ? fresh : orgView())
  let prompt: { ok: true } | { ok: false; declined: boolean; error: string } = { ok: true }
  const recorder = { addRemoteAccessFirewallRule: async (port: number, lan: boolean) => { w.log.push(`firewall ${port} ${lan}`); return prompt } }
  // the engine would refuse: nobody is shown a prompt, and nothing is changed
  assert.deepEqual(await turnOnOrgAccess('acme', recorder), { refused: 'Tailscale is not running on this computer.' })
  assert.deepEqual(w.log, ['GET /api/remote-access/orgs/acme?fresh=1'])
  // it could be turned on, and the rules are missing: Windows first; a No leaves the switch off
  w.log.length = 0
  fresh = orgView({ on: false, door: { ...shut(), lan: true, port: 7440 }, refusal: null })
  prompt = { ok: false, declined: true, error: 'Nothing changed: Windows Firewall stays as it was.' }
  assert.deepEqual(await turnOnOrgAccess('acme', recorder), { refused: 'Nothing changed: Windows Firewall stays as it was.' })
  assert.deepEqual(w.log, ['GET /api/remote-access/orgs/acme?fresh=1', 'firewall 7440 true'], 'the port and the choice are the engine\'s; no switch')
  // a Yes: then, and only then, the switch
  w.log.length = 0
  prompt = { ok: true }
  const done = await turnOnOrgAccess('acme', recorder)
  assert.ok('view' in done && done.view.on)
  assert.deepEqual(w.log, ['GET /api/remote-access/orgs/acme?fresh=1', 'firewall 7440 true', 'PUT /api/remote-access/orgs/acme'])
  assert.deepEqual(w.calls.at(-1)!.body, { on: true })
  // the rules are there already: no prompt
  w.log.length = 0
  fresh = orgView({ on: false, door: shut('ok'), refusal: null })
  await turnOnOrgAccess('acme', recorder)
  assert.deepEqual(w.log, ['GET /api/remote-access/orgs/acme?fresh=1', 'PUT /api/remote-access/orgs/acme'])
  // no desktop (a page in a browser): the switch alone
  w.log.length = 0
  fresh = orgView({ on: false, door: shut(), refusal: null })
  await turnOnOrgAccess('acme', undefined)
  assert.deepEqual(w.log, ['GET /api/remote-access/orgs/acme?fresh=1', 'PUT /api/remote-access/orgs/acme'])
  // Allow, by itself
  assert.equal(await allowDoor(door(), undefined), 'Windows Firewall can only be changed from the Orgtree app on this computer.')
  prompt = { ok: false, declined: false, error: 'The firewall rule could not be added (exit code 1).' }
  assert.equal(await allowDoor(door(), recorder), 'The firewall rule could not be added (exit code 1).')
  prompt = { ok: true }
  assert.equal(await allowDoor(door(), recorder), null)
})

test('the block: the switch and its hint; then the address, the computers and Revoke', async (t) => {
  const dana = computer()
  const lee = computer({ id: 'c2', name: 'Orgtree desktop (STUDIO)', label: 'Orgtree desktop (STUDIO)', connected: false, connected_since: null,
    last_seen_at: '2026-11-12T18:30:00Z', orgs: ['acme', 'beta'] })
  let listed = [dana, lee]
  const w = world(t, (call) => {
    if (call.method === 'GET' && call.url.startsWith('/api/remote-access/orgs/acme')) {
      return orgView({ on: call.url.endsWith('?fresh=1') ? false : true, door: call.url.endsWith('?fresh=1') ? shut() : door(), computers: listed, refusal: null })
    }
    if (call.method === 'PUT') return orgView({ computers: listed })
    if (call.method === 'DELETE') { listed = listed.filter((c) => !call.url.endsWith(c.id)); return { revoked: 'c1' } }
    return undefined
  })
  bridge(t, w.log, () => ({ ok: true }))
  const toasts: string[] = []
  const view = await mountView(<div id="block"><RemoteAccess slug="acme" name="Acme" toast={(lines) => { toasts.push(...lines) }} /></div>, (el) => el)
  t.after(() => view.unmount())
  const doc = view.el.ownerDocument
  const block = () => view.el.querySelector('#block') as HTMLElement
  // an engine that offers nothing (a standalone engine, an older one): no block at all
  await w.push({ remotes: [] })
  assert.equal(block().textContent, '')
  // this desktop's own organization, switch off
  await w.push({ remote_access: overview(false, shut()) })
  assert.equal(block().querySelector('.set-group-head')!.textContent, 'Remote access')
  const toggle = () => block().querySelector('input[role="switch"]') as HTMLInputElement
  assert.equal(toggle().getAttribute('aria-label'), 'Let other computers open this organization')
  assert.equal(toggle().checked, false)
  assert.match(block().textContent!, /A computer you add can use this organization as you do\. Through its agents it can run commands and read or change files on this computer with your account's rights, as if it had signed in over SSH: add only computers you would trust with this whole computer\./)
  const labels = () => [...block().querySelectorAll('.set-row > .set-label, .set-block > .set-label')].map((el) => el.textContent!.trim())
  assert.deepEqual(labels(), ['Let other computers open this organization'], 'off: no address, no computers, nothing to add')
  // turning it on: the engine is asked, Windows is asked, then the switch
  w.log.length = 0
  await inAct(() => { toggle().click() })
  await inAct(() => flush(10))
  assert.deepEqual(w.log, ['GET /api/remote-access/orgs/acme?fresh=1', 'firewall 7431 false', 'PUT /api/remote-access/orgs/acme'])
  assert.deepEqual(toasts, ['Computers you add can now open this organization'])
  // the engine pushes what is so now
  await w.push({ remote_access: overview(true, door(), listed) })
  assert.equal(toggle().checked, true)
  assert.deepEqual(labels(), ['Let other computers open this organization', 'Address', 'Computers', 'Let another computer in'])
  const row = (label: string) => [...block().querySelectorAll('.set-row')].find((el) => el.querySelector('.set-label')!.textContent!.trim() === label) as HTMLElement
  const address = row('Address').querySelector('.chip')!
  assert.equal(address.textContent, URL)
  assert.equal(address.getAttribute('data-streamer-field'), 'ip', 'Streamer mode masks the address like other addresses')
  assert.match(row('Address').textContent!, /Tailscale/)
  const rows = () => [...block().querySelectorAll('.remote-computers li')]
  assert.equal(rows().length, 2)
  assert.match(rows()[0]!.textContent!, /^Dana · Orgtree desktop \(LAPTOP\) · added .+ · connected since .+Revoke$/)
  assert.match(rows()[1]!.textContent!, /^Orgtree desktop \(STUDIO\) · added .+ · last seen .+Revoke$/, 'a computer nobody renamed is named once')
  assert.equal(rows()[0]!.querySelector('[data-streamer-field="ip"]')!.textContent, 'Orgtree desktop (LAPTOP)', 'its own name is a host field')
  assert.equal(rows()[0]!.querySelector('[data-streamer-field="external"]')!.textContent, 'Dana')
  // Revoke asks first, and says what goes
  w.log.length = 0
  await inAct(() => { (rows()[1]!.querySelector('button') as HTMLButtonElement).click() })
  const confirm = () => doc.querySelector('.confirm-box') as HTMLElement | null
  assert.match(confirm()!.textContent!, /Revoke Orgtree desktop \(STUDIO\)\?/)
  assert.match(confirm()!.textContent!, /can no longer open any of the 2 organizations it has on this computer/)
  assert.deepEqual(w.log, [], 'nothing yet')
  await inAct(() => { (confirm()!.querySelector('button.danger') as HTMLButtonElement).click() })
  await inAct(() => flush(10))
  assert.deepEqual(w.log, ['DELETE /api/remote-access/computers/c2', 'GET /api/remote-access/orgs/acme'])
  assert.equal(rows().length, 1)
  assert.equal(confirm(), null)
  // an organization that is itself on a remote engine has no block: no chains
  await w.push({ remotes: [{ id: 'r1', name: 'Galaxy', tag: 'galaxy', url: 'http://100.64.0.7:7430', enabled: true, state: 'connected',
    since: '2026-11-11T10:00:00Z', next_attempt_at: null, version: '4.6.0', app_version: '4.6.0', version_differs: false, transport: 'tailscale',
    client_name: null, own_token: true, last_error: null, error_code: null, last_connected_at: null,
    orgs: [{ alias: 'acme', remote_slug: 'acme', name: 'Acme', local_id: -1, gone: false }] }] })
  assert.equal(block().textContent, '')
})

test('a No at the prompt leaves the switch off and says so; a door that cannot stand says why; a blocked one offers Allow', async (t) => {
  let prompt: { ok: true } | { ok: false; declined: boolean; error: string } =
    { ok: false, declined: true, error: 'Nothing changed: Windows Firewall stays as it was.' }
  let refusal: string | null = null
  const w = world(t, (call) => {
    if (call.method === 'GET' && call.url.endsWith('?fresh=1')) return orgView({ on: false, door: shut(), refusal })
    return orgView()
  })
  bridge(t, w.log, () => prompt)
  const view = await mountView(<div id="block"><RemoteAccess slug="acme" name="Acme" toast={() => {}} /></div>, (el) => el)
  t.after(() => view.unmount())
  const block = () => view.el.querySelector('#block') as HTMLElement
  const toggle = () => block().querySelector('input[role="switch"]') as HTMLInputElement
  await w.push({ remote_access: overview(false, shut()) })
  w.log.length = 0
  await inAct(() => { toggle().click() })
  await inAct(() => flush(10))
  assert.deepEqual(w.log, ['GET /api/remote-access/orgs/acme?fresh=1', 'firewall 7431 false'], 'no switch after a No')
  assert.equal(block().querySelector('.remote-access-note')!.textContent, 'Nothing changed: Windows Firewall stays as it was.')
  assert.equal(toggle().checked, false)
  // the engine would refuse: its sentence, and no prompt
  refusal = 'Tailscale is not running on this computer, so no other computer could reach it.'
  w.log.length = 0
  await inAct(() => { toggle().click() })
  await inAct(() => flush(10))
  assert.deepEqual(w.log, ['GET /api/remote-access/orgs/acme?fresh=1'])
  assert.equal(block().querySelector('.remote-access-note')!.textContent, refusal)
  // on, but the door has nowhere to stand: the reason, and no address
  await w.push({ remote_access: overview(true, door({ state: 'waiting', addresses: [], reason: 'Tailscale is not running on this computer.' })) })
  assert.equal(block().querySelector('.remote-access-door')!.textContent, 'Tailscale is not running on this computer.')
  assert.equal(block().querySelector('.chip'), null)
  // on and standing, but Windows Firewall has no rule for it: Allow asks Windows, then the engine again
  await w.push({ remote_access: overview(true, door({ firewall: { state: 'missing', present: false } })) })
  const blocked = [...block().querySelectorAll('.set-row')].find((el) => el.textContent!.startsWith('Windows Firewall is blocking this')) as HTMLElement
  assert.ok(blocked, 'the row is there')
  prompt = { ok: true }
  w.log.length = 0
  await inAct(() => { (blocked.querySelector('button') as HTMLButtonElement).click() })
  await inAct(() => flush(10))
  assert.equal(blocked.querySelector('button')!.textContent, 'Allow')
  assert.deepEqual(w.log, ['firewall 7431 false', 'GET /api/remote-access/orgs/acme?fresh=1'])
  // the rules are known to be there, or nothing is known: no such row
  for (const state of ['ok', 'unknown', 'none'] as const) {
    await w.push({ remote_access: overview(true, door({ firewall: { state, present: state === 'ok' } })) })
    assert.ok(![...block().querySelectorAll('.set-row')].some((el) => el.textContent!.startsWith('Windows Firewall is blocking this')), state)
  }
})

test('Add a computer: the address, a code that is shown once, both in one line; or a computer that is already known', async (t) => {
  const studio = computer({ id: 'c2', name: 'Orgtree desktop (STUDIO)', label: 'Lee', orgs: ['beta'], connected: false, connected_since: null })
  let known = [studio]
  let refuse = false
  const w = world(t, (call) => {
    if (call.method === 'POST' && call.url === '/api/remote-access/orgs/acme/invitations') {
      return refuse
        ? new Response(JSON.stringify({ detail: 'Five codes are already open for this organization. Wait for one to run out.' }), { status: 409 })
        : { id: 'i1', code: 'ABCDEFGHJKMNPQRSTVWXYZ0123', created_at: '2026-11-13T10:00:00Z', expires_at: '2026-11-13T10:15:00Z', minutes: 15, door: door() }
    }
    if (call.method === 'PUT' && call.url === '/api/remote-access/orgs/acme/computers/c2') { known = []; return orgView({ computers: [studio], known }) }
    return orgView({ known })
  })
  const copied: string[] = []
  const nav = navigator as unknown as { clipboard?: unknown }
  const hadClipboard = nav.clipboard
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => { copied.push(text) } } })
  t.after(() => { Object.defineProperty(navigator, 'clipboard', { configurable: true, value: hadClipboard }) })
  const toasts: string[] = []
  const view = await mountView(<div id="block"><RemoteAccess slug="acme" name="Acme" toast={(lines) => { toasts.push(...lines) }} /></div>, (el) => el)
  t.after(() => view.unmount())
  const doc = view.el.ownerDocument
  await w.push({ remote_access: overview(true, door()) })
  const button = (text: string, within: ParentNode = doc) => [...within.querySelectorAll('button')].find((b) => b.textContent === text) as HTMLButtonElement
  w.log.length = 0
  await inAct(() => { button('Add a computer...').click() })
  await inAct(() => flush(10))
  assert.deepEqual(w.log, ['POST /api/remote-access/orgs/acme/invitations'], 'one code for one opening')
  const dialog = () => doc.querySelector('[role="group"][aria-label="Add a computer"]') as HTMLElement
  const rows = () => Object.fromEntries([...dialog().querySelectorAll('.set-row')].map((row) => [row.querySelector('.set-label')!.textContent!.trim(), row as HTMLElement]))
  assert.deepEqual(Object.keys(rows()), ['Address', 'One-time code', 'Both in one line'])
  assert.equal(rows().Address!.querySelector('.chip')!.textContent, URL)
  assert.equal(rows().Address!.querySelector('.chip')!.getAttribute('data-streamer-field'), 'ip')
  const code = rows()['One-time code']!
  assert.equal(code.querySelector('.chip')!.textContent, 'ABCDEFGHJKMNPQRSTVWXYZ0123')
  assert.equal(code.querySelector('.chip')!.getAttribute('data-streamer-field'), 'secret', 'Streamer mode masks the code')
  assert.match(code.textContent!, /Valid for 15 minutes, for one computer\./)
  const both = rows()['Both in one line']!
  assert.equal(both.querySelector('.chip')!.textContent, `${URL} ABCDEFGHJKMNPQRSTVWXYZ0123`)
  assert.equal(both.querySelector('.chip')!.getAttribute('data-streamer-field'), 'secret')
  await inAct(() => { button('Copy both', dialog()).click() })
  await inAct(() => flush(4))
  assert.deepEqual(copied, [`${URL} ABCDEFGHJKMNPQRSTVWXYZ0123`])
  assert.deepEqual(toasts, ['Address and code copied'])
  // a computer that already has another organization here: this one at once, with no code
  const list = () => [...dialog().querySelectorAll('.remote-computers li')]
  assert.equal(list().length, 1)
  assert.match(list()[0]!.textContent!, /^Lee · Orgtree desktop \(STUDIO\) · added .+Give access$/)
  w.log.length = 0
  await inAct(() => { button('Give access', dialog()).click() })
  await inAct(() => flush(10))
  assert.deepEqual(w.log, ['PUT /api/remote-access/orgs/acme/computers/c2'])
  assert.equal(list().length, 0, 'it is in the organization now')
  assert.equal(toasts.at(-1), 'Lee can now open this organization')
  assert.equal(view.el.querySelectorAll('#block .remote-computers li').length, 1, 'and in the block\'s list')
  await inAct(() => { button('Done', dialog()).click() })
  assert.equal(dialog(), null)
  // the engine's refusal is the sentence to show, and no code is shown
  refuse = true
  await inAct(() => { button('Add a computer...').click() })
  await inAct(() => flush(10))
  assert.equal(dialog().querySelector('.remote-add-error')!.textContent, 'Five codes are already open for this organization. Wait for one to run out.')
  assert.deepEqual(Object.keys(rows()), ['Address', 'One-time code'])
  assert.equal(rows()['One-time code']!.querySelector('.chip'), null)
})

test('the App settings page: where it listens, the port, the organizations, Stop all and the firewall rules', async (t) => {
  let prompt: { ok: true } | { ok: false; declined: boolean; error: string } = { ok: true }
  const w = world(t, () => overview(false, shut()))
  bridge(t, w.log, () => prompt)
  const host = window as unknown as { confirm: (text: string) => boolean }
  const asked: string[] = []
  const hadConfirm = host.confirm
  host.confirm = (text: string) => { asked.push(text); return true }
  t.after(() => { host.confirm = hadConfirm })
  const toasts: string[] = []
  const view = await mountView(<div id="page"><RemoteAccessSettings toast={(lines) => { toasts.push(...lines) }} /></div>, (el) => el)
  t.after(() => view.unmount())
  const doc = view.el.ownerDocument
  const page = () => view.el.querySelector('#page') as HTMLElement
  await w.push({ remotes: [] })
  assert.equal(page().textContent, '', 'an engine that offers nothing has no page')
  // (the feed is one per document: until this test's first copy arrived, the last test's values stood)
  w.log.length = 0
  // nothing is shared, and the rules of an earlier time are still in Windows Firewall
  await w.push({ remote_access: overview(false, { ...shut(), firewall: { state: 'ok', present: true } }) })
  assert.deepEqual(w.log, ['GET /api/remote-access'], 'the owner looks: the engine is asked once, and reads the firewall behind its answer')
  const labels = () => [...page().querySelectorAll('.set-row > .set-label')].map((el) => el.textContent!.trim())
  assert.deepEqual(labels(), ['Tailscale', 'This private network', 'This computer only', 'Port', 'Now', 'Windows Firewall still has the rules for remote access', 'Stop all remote access'])
  const row = (label: string) => [...page().querySelectorAll('.set-row')].find((el) => el.querySelector('.set-label')!.textContent!.trim() === label) as HTMLElement
  assert.equal(row('Now').querySelector('.chip')!.textContent, 'Not listening: nothing is shared')
  assert.match(page().textContent!, /None\. The switch is in an organization's settings, under Connections\./)
  const button = (text: string) => [...page().querySelectorAll('button')].find((b) => b.textContent === text) as HTMLButtonElement
  assert.equal(button('Stop all remote access').disabled, true, 'nothing to stop')
  // the rules can go: Windows is asked, then the engine reads again
  w.log.length = 0
  await inAct(() => { button('Remove the rules').click() })
  await inAct(() => flush(10))
  assert.deepEqual(w.log, ['firewall remove', 'GET /api/remote-access?fresh=1'])
  assert.deepEqual(toasts, ['The firewall rules for remote access were removed'])
  // where it listens, while nothing is shared: the engine alone (the rules are asked for when a switch goes on)
  // three places, each switched by itself (user ruling 2026-11-14: not limited to Tailscale)
  assert.equal(page().querySelector('.set-block > .set-label')!.textContent, 'Where it listens')
  const place = (label: string) => page().querySelector(`input[role="switch"][aria-label="${label}"]`) as HTMLInputElement
  assert.deepEqual(['Tailscale', 'This private network', 'This computer only'].map((label) => place(label).checked), [true, false, false])
  assert.match(place('This private network').closest('.set-row')!.textContent!, /not encrypted/)
  assert.match(place('This computer only').closest('.set-row')!.textContent!, /SSH tunnel or a local https proxy/)
  w.log.length = 0
  await inAct(() => { place('This private network').click() })
  await inAct(() => flush(10))
  assert.deepEqual(w.log, ['PUT /api/remote-access'])
  assert.deepEqual(w.calls.at(-1)!.body, { lan: true })
  await inAct(() => { place('This computer only').click() })
  await inAct(() => flush(10))
  assert.deepEqual(w.calls.at(-1)!.body, { local: true })
  // two organizations are shared, one with somebody in it
  const dana = computer()
  const both = overview(true, door(), [dana])
  both.orgs[1] = { ...both.orgs[1]!, on: true, computers: 2 }
  await w.push({ remote_access: both })
  assert.deepEqual(labels(), ['Tailscale', 'This private network', 'This computer only', 'Port', 'Now', 'Acme', 'Beta', 'Stop all remote access'])
  assert.equal(row('Now').querySelector('.chip')!.textContent, 'Listening')
  assert.equal(row('Now').querySelector('[data-streamer-field="ip"]')!.textContent, URL)
  assert.equal(row('Acme').querySelector('.set-control')!.textContent, '1 computer, 1 connected')
  assert.equal(row('Beta').querySelector('.set-control')!.textContent, '2 computers, 0 connected')
  // another port while something is shared: Windows first, with the new port; then the engine
  const port = () => page().querySelector('input[aria-label="Remote access port"]') as HTMLInputElement
  const type = async (input: HTMLInputElement, value: string) => {
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value')!.set!
    await inAct(() => { setter.call(input, value); input.dispatchEvent(new (doc.defaultView!.Event)('input', { bubbles: true })) })
  }
  assert.equal(port().value, '7431')
  assert.equal(button('Change').disabled, true, 'the port it has')
  await type(port(), '80')
  assert.equal(button('Change').disabled, true, 'not a port the door may have')
  await type(port(), '7440')
  w.log.length = 0
  await inAct(() => { button('Change').click() })
  await inAct(() => flush(10))
  assert.deepEqual(w.log, ['firewall 7440 false', 'PUT /api/remote-access'])
  assert.deepEqual(w.calls.at(-1)!.body, { port: 7440 })
  // a No: the door stays where it is, and the field says so again
  prompt = { ok: false, declined: true, error: 'Nothing changed: Windows Firewall stays as it was.' }
  await type(port(), '7450')
  w.log.length = 0
  await inAct(() => { button('Change').click() })
  await inAct(() => flush(10))
  assert.deepEqual(w.log, ['firewall 7450 false'])
  assert.equal(page().querySelector('.remote-access-note')!.textContent, 'Nothing changed: Windows Firewall stays as it was.')
  assert.equal(port().value, '7431')
  // Stop all says what goes, then asks the engine
  w.log.length = 0
  await inAct(() => { button('Stop all remote access').click() })
  await inAct(() => flush(10))
  assert.equal(asked.length, 1)
  assert.match(asked[0]!, /^Stop all remote access\? Other computers can no longer open any of 2 organizations, and the computer that is connected loses it at once\. The lists of computers stay\.$/)
  assert.deepEqual(w.log, ['POST /api/remote-access/stop'])
  // shared and the rules are missing: Allow here too
  await w.push({ remote_access: overview(true, door({ firewall: { state: 'missing', present: false } })) })
  assert.ok(labels().includes('Windows Firewall is blocking this'))
})

test('the words of the page, and the order of a change', async (t) => {
  assert.deepEqual((['closed', 'open', 'waiting', 'blocked'] as const).map((state) => doorWord({ state })),
    ['Not listening: nothing is shared', 'Listening', 'Waiting for an address', 'Cannot listen'])
  assert.equal(computersWord({ computers: 1, connected: 0 }), '1 computer, 0 connected')
  assert.equal(computersWord({ computers: 3, connected: 2 }), '3 computers, 2 connected')
  assert.deepEqual([1023, 1024, 7431, 65535, 65536, 7431.5, Number.NaN].map(validPort), [false, true, true, true, false, false, false])
  const w = world(t, () => overview(true, door()))
  let prompt: { ok: true } | { ok: false; declined: boolean; error: string } = { ok: true }
  const recorder = {
    addRemoteAccessFirewallRule: async (port: number, lan: boolean, tailscale?: boolean) => {
      w.log.push(`firewall ${port} ${lan}${tailscale === false ? ' without Tailscale' : ''}`); return prompt
    },
    removeRemoteAccessFirewallRule: async () => { w.log.push('firewall remove'); return prompt },
  }
  // shared: the rules follow first, with what the door will have (the new choice, the port it keeps)
  await changeListening(overview(true, door()), { lan: true }, recorder)
  assert.deepEqual(w.log, ['firewall 7431 true', 'PUT /api/remote-access'])
  // the private network without Tailscale: Windows is asked for that rule alone
  w.log.length = 0
  await changeListening(overview(true, door()), { tailscale: false, lan: true }, recorder)
  assert.deepEqual(w.log, ['firewall 7431 true without Tailscale', 'PUT /api/remote-access'])
  // this computer only needs no rule: Windows is not asked at all
  w.log.length = 0
  await changeListening(overview(true, door()), { tailscale: false, local: true }, recorder)
  assert.deepEqual(w.log, ['PUT /api/remote-access'])
  // the last place cannot be switched off: nothing is asked of anybody
  w.log.length = 0
  assert.deepEqual(await changeListening(overview(true, door()), { tailscale: false }, recorder),
    { refused: 'Choose at least one place for remote access to listen.' })
  assert.deepEqual(w.log, [])
  // nothing shared, or no firewall of this kind, or no desktop: the engine alone
  for (const [now, with_] of [[overview(false, shut()), recorder], [overview(true, door({ firewall: { state: 'none', present: false } })), recorder],
    [overview(true, door()), undefined]] as const) {
    w.log.length = 0
    await changeListening(now, { port: 7440 }, with_)
    assert.deepEqual(w.log, ['PUT /api/remote-access'])
  }
  assert.equal(await removeDoorRules(undefined), 'Windows Firewall can only be changed from the Orgtree app on this computer.')
  prompt = { ok: false, declined: true, error: 'Nothing changed: the firewall stays as it was.' }
  assert.equal(await removeDoorRules(recorder), 'Nothing changed: the firewall stays as it was.')
})

test('the chip on the status strip of an organization somebody else is in', async (t) => {
  const w = world(t, () => orgView())
  let opened = 0
  const view = await mountView(<span id="strip"><SharedChip slug="acme" onOpen={() => { opened += 1 }} /><SharedChip slug="beta" onOpen={() => {}} /></span>, (el) => el)
  t.after(() => view.unmount())
  const strip = () => view.el.querySelector('#strip') as HTMLElement
  await w.push({ remote_access: overview(true, door(), [computer({ connected: false, connected_since: null })]) })
  assert.equal(strip().textContent, '', 'it was let in, and is not connected: no chip')
  await w.push({ remote_access: overview(true, door(), [computer()]) })
  const chips = strip().querySelectorAll('.shared-chip')
  assert.equal(chips.length, 1, 'the organization it is in, and no other')
  assert.equal(chips[0]!.textContent!.trim(), '1 computer connected')
  assert.match(chips[0]!.getAttribute('title')!, /Dana — click for Remote access$/)
  await inAct(() => { (chips[0] as HTMLElement).click() })
  assert.equal(opened, 1)
  assert.deepEqual(w.log, [], 'the chip asks the engine nothing: it is pushed')
})

/** A hosting desktop as the connecting side lists it. */
const hosting = (patch: Partial<RemoteView> = {}): RemoteView => ({
  id: 'r1', name: 'HOME-PC', tag: 'home-pc', url: URL, enabled: true, state: 'connected',
  since: '2026-11-13T10:00:00Z', next_attempt_at: null, version: '4.6.0', app_version: '4.6.0', version_differs: false,
  transport: 'tailscale', client_name: 'Orgtree desktop (LAPTOP)', own_token: true, mode: 'host', scope: 'member',
  last_error: null, error_code: null, last_connected_at: '2026-11-13T10:00:00Z',
  orgs: [{ alias: 'acme', remote_slug: 'acme', name: 'Acme', local_id: -1, gone: false }],
  ...patch,
})
const unshared = [{ alias: 'acme', remote_slug: 'acme', name: 'Acme', local_id: -1, gone: true }]

test('the other computer: one pasted line fills both fields, the details say "these organizations only", and an organization that is no longer shared says so', async (t) => {
  const code = 'ABCDEFGHJKMNPQRSTVWXYZ0123'
  assert.deepEqual(addressWithCode(`${URL} ${code}`), { url: URL, code })
  assert.deepEqual(addressWithCode(`  ${URL}\t${code}\n`), { url: URL, code }, 'however the two are spaced')
  assert.equal(addressWithCode(URL), null, 'an address alone')
  assert.equal(addressWithCode(`home-pc.tail1234.ts.net ${code}`), null, 'no scheme: left as it was typed')
  assert.equal(addressWithCode(`${URL} two more words`), null)
  assert.equal(addressWithCode(`${URL} short`), null)
  assert.equal(noLongerShared(hosting({ orgs: unshared }), 'acme'), 'HOME-PC no longer shares this organization.')
  assert.equal(noLongerShared(hosting(), 'acme'), null, 'it is shared')
  assert.equal(noLongerShared(hosting({ orgs: unshared, mode: 'standalone', scope: 'full' }), 'acme'), null, 'an engine that runs by itself shares nothing')
  assert.equal(noLongerShared(hosting({ orgs: unshared, state: 'offline' }), 'acme'), null, 'away: the offline banner speaks')
  assert.equal(noLongerShared(hosting({ orgs: unshared }), 'other'), null)

  const w = world(t, () => ({ supported: true, people: [] }))
  const view = await mountView(<div>
    <span id="chip"><RemoteChip slug="acme" /></span><div id="banner"><RemoteBanner slug="acme" /></div>
    <div id="add"><RemoteEngineDialog close={() => {}} /></div>
  </div>, (el) => el)
  t.after(() => view.unmount())
  const doc = view.el.ownerDocument
  await w.push({ remotes: [hosting()] })
  assert.equal(view.el.querySelector('#banner')!.textContent, '', 'connected and shared: no banner')
  // Connection details
  await inAct(() => { (view.el.querySelector('.remote-chip') as HTMLElement).click() })
  await inAct(() => flush(6))
  const signed = [...doc.querySelectorAll('.remote-details .set-row')].find((row) => row.querySelector('.set-label')!.textContent!.trim() === 'Signed in as') as HTMLElement
  assert.equal(signed.querySelector('.set-control')!.textContent, 'Orgtree desktop (LAPTOP) · these organizations only')
  assert.equal(signed.querySelector('[data-streamer-field="ip"]')!.textContent, 'Orgtree desktop (LAPTOP)', 'this computer\'s name stays a host field')
  assert.match(signed.querySelector('.set-hint')!.textContent!, /^HOME-PC is somebody's own computer\. It decides which of its organizations this computer may open, and can end that at any time\./)
  // an engine that runs by itself keeps its own words
  await w.push({ remotes: [hosting({ mode: 'standalone', scope: 'full' })] })
  assert.equal(signed.querySelector('.set-control')!.textContent, 'Orgtree desktop (LAPTOP)')
  assert.match(signed.querySelector('.set-hint')!.textContent!, /^Full control\./)
  // the hosting desktop switched the organization off: its sentence, and nothing to press
  await w.push({ remotes: [hosting({ orgs: unshared })] })
  const banner = view.el.querySelector('#banner .remote-banner') as HTMLElement
  assert.equal(banner.textContent, 'HOME-PC no longer shares this organization.')
  assert.equal(banner.querySelector('button'), null)
  // the Add dialog: "Both in one line", pasted into Address, goes into the two fields
  const field = (label: string) => doc.querySelector(`#add input[aria-label="${label}"], input[aria-label="${label}"]`) as HTMLInputElement
  const type = async (input: HTMLInputElement, value: string) => {
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value')!.set!
    await inAct(() => { setter.call(input, value); input.dispatchEvent(new (doc.defaultView!.Event)('input', { bubbles: true })) })
  }
  await type(field('Engine address'), `${URL} ${code}`)
  assert.equal(field('Engine address').value, URL)
  assert.equal(field('Engine token').value, code)
  assert.match(doc.body.textContent!, /for another person's computer, the one-time code it gave you/)
  // a token that was typed already is not replaced by a paste into Address
  await type(field('Engine token'), 'typed-by-hand')
  await type(field('Engine address'), `${URL} ${code}`)
  assert.equal(field('Engine token').value, 'typed-by-hand')
})
