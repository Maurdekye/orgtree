// "Chat from your phone": with Hubchat already on this PC (its person on this
// PC's hub), the panel offers to bring that identity to the phone, and must
// still let the user set the phone up as its own identity with a setup code
// (user bug in 4.1.0-alpha.1: that branch had no way to reach the code).

import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { PhonePanel } from '../src/canvas/phonelink'

const g = globalThis as unknown as Record<string, unknown>

const state = {
  download_url: 'https://example.invalid/Hubchat-android.apk',
  download_qr: '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
  link: null,
  org: {
    slug: 'acme', name: 'Acme', address: 'acme.user.123456', on_local_hub: true,
    persons: [{ address: 'neo.abc123', name: 'Neo', online: true, last_seen: null }],
    code: null,
  },
  tailscale: { state: 'T2', backend: 'Running', account: 'neo@example.com', pc: 'home-pc', ipv4: '100.64.0.2' },
  access: { state: 'A1', scope: 'tailnet', port: 7371, door: '100.64.0.2', door_waiting: false,
    firewall: '100.64.0.0/10,fd7a:115c:a1e0::/48', firewall_wanted: '100.64.0.0/10,fd7a:115c:a1e0::/48' },
  hub: { running: true, healthy: true, error: null },
  keep_awake: true,
  card: { show: false, dismissed: false, org: 'acme' },
  warnings: {},
  hubchat_pc: true,
}

test('Hubchat on this PC: "Set up my phone with a code instead" leads to the download and setup-code steps', async () => {
  const seen: string[] = []
  g.fetch = (url: string, init?: RequestInit) => {
    const u = new URL(String(url), 'http://localhost')
    seen.push(`${init?.method ?? 'GET'} ${u.pathname}`)
    const payload = u.pathname === '/api/desktop/phone' ? state : {}
    return Promise.resolve({ ok: true, status: 200, headers: new Headers(), json: () => Promise.resolve(payload) })
  }
  const view = await mountView(<PhonePanel org="acme" onClose={() => {}} />, el => el.textContent ?? '')
  await inAct(async () => { await flush(10) })
  const before = view.last()
  assert.match(before, /You already use Hubchat on this PC/)
  assert.match(before, /Is neo\.abc123 you\? Yes/)
  const button = [...view.el.querySelectorAll('button')].find(b => b.textContent === 'Set up my phone with a code instead')
  assert.ok(button, 'the branch offers a way to the setup code')
  await inAct(async () => { button!.click(); await flush(4) })
  const after = view.last()
  assert.doesNotMatch(after, /You already use Hubchat on this PC/)
  assert.match(after, /I have Hubchat on my phone → Next/)
  // nothing was linked on the way
  assert.ok(!seen.some(s => s === 'POST /api/desktop/phone/link'), seen.join(', '))
  await view.unmount()
})
