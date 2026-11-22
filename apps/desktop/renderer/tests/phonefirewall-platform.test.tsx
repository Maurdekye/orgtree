// B-06: Gate phone-access Windows Firewall IPC calls (addPhoneFirewallRule /
// removePhoneFirewallRule) to Windows desktops, matching remoteaccess.ts.
// On Linux/macOS/SteamOS, calling addPhoneFirewallRule fails with
// "Only Windows has this firewall." (or missing .exe) and aborts enabling
// phone access before POST /api/desktop/phone/access.
import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { PhonePanel, removePhoneRuleAfterOff } from '../src/canvas/phonelink'
import type { NativeDesktop } from '../src/desktop'

const g = globalThis as unknown as Record<string, unknown>

function phoneState(accessState: 'A0' | 'A1' = 'A0', firewall: string | null = null) {
  return {
    download_url: 'https://example.invalid/Hubchat-android.apk',
    download_qr: '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
    link: null,
    org: {
      slug: 'acme', name: 'Acme', address: 'acme.user.123456', on_local_hub: true,
      persons: [], code: null,
    },
    tailscale: { state: 'T2', backend: 'Running', account: 'neo@example.com', pc: 'deck', ipv4: '100.64.0.2' },
    access: {
      state: accessState, scope: 'tailnet', port: 7371, door: accessState === 'A0' ? null : '100.64.0.2',
      door_waiting: false, firewall, firewall_wanted: '100.64.0.0/10,fd7a:115c:a1e0::/48',
    },
    hub: { running: true, healthy: true, error: null },
    card: { show: false, dismissed: false, org: 'acme' },
    warnings: {},
    hubchat_pc: false,
  }
}

function setBridge(value?: Partial<NativeDesktop>) {
  Object.defineProperty(window, 'orgtreeDesktop', { value, configurable: true })
}

for (const platform of ['linux', 'darwin'] as const) {
  test(`non-Windows (${platform}): Turn on phone access skips addPhoneFirewallRule and calls engine access endpoint`, async t => {
    const oldFetch = g.fetch
    const posts: { url: string; body: unknown }[] = []
    const firewallCalls: string[] = []
    let current = phoneState('A0', null)
    g.fetch = (url: string, init?: RequestInit) => {
      const u = new URL(String(url), 'http://localhost')
      if (init?.method === 'POST') {
        posts.push({ url: u.pathname, body: JSON.parse(String(init.body)) })
        current = phoneState('A1', null)
      }
      return Promise.resolve(new Response(JSON.stringify(current), { status: 200 }))
    }
    setBridge({
      platform,
      addPhoneFirewallRule: async (scope) => {
        firewallCalls.push(`add:${scope}`)
        return { ok: false, declined: false, error: 'Only Windows has this firewall.' }
      },
      removePhoneFirewallRule: async () => {
        firewallCalls.push('remove')
        return { ok: false, declined: false, error: 'Only Windows has this firewall.' }
      },
    } as Partial<NativeDesktop>)
    const view = await mountView(<PhonePanel org="acme" onClose={() => {}} />, el => el)
    t.after(async () => {
      await view.unmount()
      g.fetch = oldFetch
      setBridge(undefined)
    })
    await inAct(async () => { await flush(6) })
    const btn = [...view.el.querySelectorAll('button')].find(b => b.textContent === 'Turn on phone access')
    assert.ok(btn, 'Turn on phone access button rendered')
    await inAct(async () => { btn.click(); await flush(6) })
    assert.deepEqual(firewallCalls, [], 'Windows firewall IPC must not run on ' + platform)
    assert.deepEqual(posts, [{ url: '/api/desktop/phone/access', body: { scope: 'tailnet' } }])
    assert.equal(view.el.querySelector('.phone-note') === null, true, 'no Windows firewall error shown')

    // removePhoneRuleAfterOff also skips on non-Windows even if engine had a stale firewall value
    current = phoneState('A0', 'stale')
    const note = await removePhoneRuleAfterOff()
    assert.equal(note, '')
    assert.deepEqual(firewallCalls, [], 'removePhoneFirewallRule must not run on ' + platform)
  })
}

test('Windows (win32): Turn on phone access still calls addPhoneFirewallRule before engine access endpoint', async t => {
  const oldFetch = g.fetch
  const posts: { url: string; body: unknown }[] = []
  const firewallCalls: string[] = []
  let failFirewall = true
  let current = phoneState('A0', '100.64.0.0/10')
  g.fetch = (url: string, init?: RequestInit) => {
    const u = new URL(String(url), 'http://localhost')
    if (init?.method === 'POST') {
      posts.push({ url: u.pathname, body: JSON.parse(String(init.body)) })
      current = phoneState('A1', '100.64.0.0/10')
    }
    return Promise.resolve(new Response(JSON.stringify(current), { status: 200 }))
  }
  setBridge({
    platform: 'win32',
    addPhoneFirewallRule: async (scope) => {
      firewallCalls.push(`add:${scope}`)
      return failFirewall
        ? { ok: false, declined: true, error: 'Nothing changed: phone access stays as it was.' }
        : { ok: true }
    },
    removePhoneFirewallRule: async () => {
      firewallCalls.push('remove')
      return { ok: true }
    },
  } as Partial<NativeDesktop>)
  const view = await mountView(<PhonePanel org="acme" onClose={() => {}} />, el => el)
  t.after(async () => {
    await view.unmount()
    g.fetch = oldFetch
    setBridge(undefined)
  })
  await inAct(async () => { await flush(6) })
  const btn = () => [...view.el.querySelectorAll('button')].find(b => b.textContent === 'Turn on phone access')
  assert.ok(btn(), 'Turn on phone access button rendered')

  // Declined Windows prompt stops before POST /api/desktop/phone/access
  await inAct(async () => { btn()!.click(); await flush(6) })
  assert.deepEqual(firewallCalls, ['add:tailnet'])
  assert.deepEqual(posts, [])
  assert.match(view.el.querySelector('.phone-note')?.textContent ?? '', /Nothing changed/)

  // Approved Windows prompt proceeds to POST /api/desktop/phone/access
  failFirewall = false
  await inAct(async () => { btn()!.click(); await flush(6) })
  assert.deepEqual(firewallCalls, ['add:tailnet', 'add:tailnet'])
  assert.deepEqual(posts, [{ url: '/api/desktop/phone/access', body: { scope: 'tailnet' } }])

  // removePhoneRuleAfterOff runs on Windows when a firewall rule exists
  const note = await removePhoneRuleAfterOff()
  assert.equal(note, 'The firewall rule for phone access was removed.')
  assert.deepEqual(firewallCalls, ['add:tailnet', 'add:tailnet', 'remove'])
})

test('Windows (win32): missing addPhoneFirewallRule capability or thrown error refuses before POST /api/desktop/phone/access', async t => {
  const oldFetch = g.fetch
  const posts: { url: string; body: unknown }[] = []
  g.fetch = (url: string, init?: RequestInit) => {
    const u = new URL(String(url), 'http://localhost')
    if (init?.method === 'POST') posts.push({ url: u.pathname, body: JSON.parse(String(init.body)) })
    return Promise.resolve(new Response(JSON.stringify(phoneState('A0', null)), { status: 200 }))
  }
  t.after(() => { g.fetch = oldFetch; setBridge(undefined) })

  // 1. Windows desktop bridge without addPhoneFirewallRule capability must refuse.
  setBridge({ platform: 'win32' } as Partial<NativeDesktop>)
  const vMissing = await mountView(<PhonePanel org="acme" onClose={() => {}} />, el => el)
  try {
    await inAct(async () => { await flush(6) })
    const btn = [...vMissing.el.querySelectorAll('button')].find(b => b.textContent === 'Turn on phone access')
    assert.ok(btn, 'Turn on phone access button rendered')
    await inAct(async () => { btn.click(); await flush(6) })
    assert.deepEqual(posts, [], 'must not activate phone access on Windows without firewall capability')
    assert.match(vMissing.el.querySelector('.phone-note')?.textContent ?? '', /Windows Firewall/i)
  } finally { await vMissing.unmount() }

  // 2. Windows desktop bridge where addPhoneFirewallRule throws must also refuse.
  setBridge({
    platform: 'win32',
    addPhoneFirewallRule: async () => { throw new Error('UAC prompt failed') },
  } as Partial<NativeDesktop>)
  const vThrow = await mountView(<PhonePanel org="acme" onClose={() => {}} />, el => el)
  try {
    await inAct(async () => { await flush(6) })
    const btn = [...vThrow.el.querySelectorAll('button')].find(b => b.textContent === 'Turn on phone access')
    assert.ok(btn)
    await inAct(async () => { btn.click(); await flush(6) })
    assert.deepEqual(posts, [], 'must not activate phone access on Windows when firewall IPC throws')
    assert.match(vThrow.el.querySelector('.phone-note')?.textContent ?? '', /UAC prompt failed/)
  } finally { await vThrow.unmount() }

  // 3. M5: Unavailable desktop bridge (no preload) must refuse with the same refusal note.
  setBridge(undefined)
  const vNoBridge = await mountView(<PhonePanel org="acme" onClose={() => {}} />, el => el)
  try {
    await inAct(async () => { await flush(6) })
    const btn = [...vNoBridge.el.querySelectorAll('button')].find(b => b.textContent === 'Turn on phone access')
    assert.ok(btn, 'Turn on phone access button rendered without bridge')
    await inAct(async () => { btn.click(); await flush(6) })
    assert.deepEqual(posts, [], 'must not activate phone access when desktop bridge is unavailable')
    assert.equal(
      vNoBridge.el.querySelector('.phone-note')?.textContent,
      'This desktop app cannot add the Windows Firewall rule required for phone access.',
    )
  } finally { await vNoBridge.unmount() }

  // 4. M5: Present bridge with unidentified platform and no firewall method must also refuse.
  setBridge({} as Partial<NativeDesktop>)
  const vUnknownBridge = await mountView(<PhonePanel org="acme" onClose={() => {}} />, el => el)
  try {
    await inAct(async () => { await flush(6) })
    const btn = [...vUnknownBridge.el.querySelectorAll('button')].find(b => b.textContent === 'Turn on phone access')
    assert.ok(btn)
    await inAct(async () => { btn.click(); await flush(6) })
    assert.deepEqual(posts, [], 'must not activate phone access without an identified Linux/macOS desktop')
    assert.equal(
      vUnknownBridge.el.querySelector('.phone-note')?.textContent,
      'This desktop app cannot add the Windows Firewall rule required for phone access.',
    )
  } finally { await vUnknownBridge.unmount() }
})
