// Non-Windows wording & Windows-only feature hides (docket orgtree-hubchat-windows-specific-wording-on-non-w).
// Verifies O-01, O-02, O-03, O-04, O-06, O-07, O-09, O-10, O-12, B-01, B-03, B-04 across
// Windows (byte-identical) and Linux/macOS (platform-appropriate wording or hidden).
import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { DesktopSettings, RunAsAdministratorSetting } from '../src/canvas/desktopsettings'
import { Onboarding } from '../src/canvas/onboarding'
import { DraftScopeModal, NodeConfig } from '../src/canvas/modals'
import { AppFilePermissionPrompt } from '../src/canvas/apps/files-ui'
import { AccountRegistrySection, AddAccountDialog } from '../src/canvas/accountsregistry'
import { PhonePanel } from '../src/canvas/phonelink'
import { ShortcutsSettings } from '../src/canvas/shortcutsettings'
import { CharterTemplateDirsSetting } from '../src/canvas/chartersettings'
import { composerKeyHint } from '../src/composerkeys'
import { getHost } from '../src/api'
import type { NativeDesktop, NativePreferences } from '../src/desktop'
import type { CanvasNode } from '../src/canvas/shared'
import type { TreePayload } from '../src/types'

const g = globalThis as unknown as { fetch: typeof fetch }
const basePrefs = {
  startAtLogin: true, exitOnClose: false, automaticUpdates: true,
  routineNotifications: false, notificationsEnabled: true, onboarded: false,
} as NativePreferences

function setBridge(value: Partial<NativeDesktop> | undefined) {
  Object.defineProperty(window, 'orgtreeDesktop', { value, configurable: true })
}

async function seedHostOs(os: string) {
  const prev = g.fetch
  g.fetch = (async () => new Response(JSON.stringify({
    os, build: { commit: 'test', started_at: '2026-11-22T00:00:00Z' }, cli_version: '1.0',
  }), { status: 200, headers: { 'Content-Type': 'application/json' } })) as typeof fetch
  try { await getHost() } finally { g.fetch = prev }
}

test('O-01: non-Windows DesktopSettings and Onboarding start as Run on sign-in with zero Run on boot flash', async t => {
  t.after(() => setBridge(undefined))
  for (const platform of ['linux', 'darwin'] as const) {
    setBridge({
      platform,
      getPreferences: async () => basePrefs,
      setPreferences: async p => ({ ...basePrefs, ...p }),
      onEvent: () => () => {},
      // Deliberately never resolves to prove initial paint never flashes 'Run on boot' / Windows hint.
      getStartupKind: () => new Promise(() => {}),
    })
    const v1 = await mountView(<DesktopSettings />, el => el)
    try {
      const sw = v1.el.querySelector<HTMLInputElement>('input[role="switch"]')
      assert.equal(sw?.getAttribute('aria-label'), 'Run on sign-in', `${platform} DesktopSettings initial label`)
      assert.doesNotMatch(v1.el.textContent ?? '', /Run on boot|Windows asks for permission/)
    } finally { await v1.unmount() }

    const v2 = await mountView(<Onboarding><div /></Onboarding>, el => el)
    try {
      const sw = v2.el.querySelector<HTMLInputElement>('input[role="switch"]')
      assert.equal(sw?.getAttribute('aria-label'), 'Run on sign-in', `${platform} Onboarding initial label`)
      assert.doesNotMatch(v2.el.textContent ?? '', /Run on boot|Windows asks for permission/)
    } finally { await v2.unmount() }
  }

  // Windows keeps exact initial 'Run on boot' + Windows hint
  setBridge({
    platform: 'win32',
    getPreferences: async () => basePrefs,
    setPreferences: async p => ({ ...basePrefs, ...p }),
    onEvent: () => () => {},
    getStartupKind: async () => 'boot',
  })
  const vw = await mountView(<DesktopSettings />, el => el)
  try {
    await inAct(async () => { await flush(5) })
    assert.equal(vw.el.querySelector<HTMLInputElement>('input[role="switch"]')?.getAttribute('aria-label'), 'Run on boot')
    assert.match(vw.el.textContent ?? '', /Windows asks for permission to change this\./)
  } finally { await vw.unmount() }
})

test('O-02: Automatic updates uses Linux AppImage / unavailable-build wording off Windows and keeps Windows exact', async t => {
  t.after(() => setBridge(undefined))

  // Linux AppImage in read-only directory (updatesSupported: true, unattendedInstall: false)
  setBridge({
    platform: 'linux',
    getPreferences: async () => basePrefs,
    setPreferences: async p => ({ ...basePrefs, ...p }),
    onEvent: () => () => {},
    getStartupKind: async () => 'signin',
    getUpdateCapability: async () => ({ unattendedInstall: false, installDirectory: '/opt/orgtree', updatesSupported: true }) as never,
  })
  const vAppImage = await mountView(<DesktopSettings />, el => el)
  try {
    await inAct(async () => { await flush(5) })
    const txt = vAppImage.el.textContent ?? ''
    assert.match(txt, /cannot replace this AppImage automatically/)
    assert.doesNotMatch(txt, /Windows prompt/)
  } finally { await vAppImage.unmount() }

  // Packaged macOS / non-AppImage Linux (updatesSupported: false)
  setBridge({
    platform: 'darwin',
    getPreferences: async () => basePrefs,
    setPreferences: async p => ({ ...basePrefs, ...p }),
    onEvent: () => () => {},
    getStartupKind: async () => 'signin',
    getUpdateCapability: async () => ({ unattendedInstall: false, installDirectory: '/Applications', updatesSupported: false }) as never,
  })
  const vNoFeed = await mountView(<DesktopSettings />, el => el)
  try {
    await inAct(async () => { await flush(5) })
    const toggle = vNoFeed.el.querySelector<HTMLInputElement>('input[aria-label="Automatic updates"]')!
    assert.equal(toggle.disabled, true)
    assert.match(vNoFeed.el.textContent ?? '', /Automatic updates are not available for this build\./)
    assert.doesNotMatch(vNoFeed.el.textContent ?? '', /Windows prompt/)
  } finally { await vNoFeed.unmount() }

  // Windows byte-identical
  setBridge({
    platform: 'win32',
    getPreferences: async () => basePrefs,
    setPreferences: async p => ({ ...basePrefs, ...p }),
    onEvent: () => () => {},
    getStartupKind: async () => 'boot',
    getUpdateCapability: async () => ({ unattendedInstall: false, installDirectory: 'C:\\Program Files\\Orgtree', updatesSupported: true }) as never,
  })
  const vWin = await mountView(<DesktopSettings />, el => el)
  try {
    await inAct(async () => { await flush(5) })
    assert.match(vWin.el.textContent ?? '', /Use "Update now" and approve the Windows prompt\./)
  } finally { await vWin.unmount() }
})

test('O-03 & O-04: Open questions and Run as admin are hidden on Linux/macOS and shown on Windows', async t => {
  t.after(() => setBridge(undefined))
  for (const platform of ['linux', 'darwin'] as const) {
    setBridge({
      platform,
      getPreferences: async () => basePrefs,
      setPreferences: async p => ({ ...basePrefs, ...p }),
      onEvent: () => () => {},
      getStartupKind: async () => 'signin',
      getRunAsAdministrator: async () => ({ available: false, enabled: false, reason: 'Only Windows has this setting.' }),
      setRunAsAdministrator: async () => ({ available: false, enabled: false }),
    })
    const vd = await mountView(<DesktopSettings />, el => el)
    try {
      await inAct(async () => { await flush(5) })
      assert.equal(vd.el.querySelector('select[aria-label="Open questions"]'), null, `${platform} hides Open questions`)
    } finally { await vd.unmount() }

    const va = await mountView(<RunAsAdministratorSetting />, el => el)
    try {
      await inAct(async () => { await flush(5) })
      assert.equal(va.el.textContent, '', `${platform} hides Run as admin`)
    } finally { await va.unmount() }
  }

  setBridge({
    platform: 'win32',
    getPreferences: async () => basePrefs,
    setPreferences: async p => ({ ...basePrefs, ...p }),
    onEvent: () => () => {},
    getStartupKind: async () => 'boot',
    getRunAsAdministrator: async () => ({ available: true, enabled: false }),
    setRunAsAdministrator: async () => ({ available: true, enabled: false }),
  })
  const vdw = await mountView(<DesktopSettings />, el => el)
  const vaw = await mountView(<RunAsAdministratorSetting />, el => el)
  try {
    await inAct(async () => { await flush(5) })
    assert.ok(vdw.el.querySelector('select[aria-label="Open questions"]'))
    assert.ok(vaw.el.querySelector('input[aria-label="Run as admin"]'))
  } finally { await vdw.unmount(); await vaw.unmount() }
})

test('O-06: Desktop session in NodeConfig and DraftScopeModal follows serving engine OS (hides on Linux, keeps on remote Windows)', async t => {
  const prevFetch = g.fetch
  t.after(async () => { setBridge(undefined); await seedHostOs('windows'); g.fetch = prevFetch })
  const mockApi = () => {
    g.fetch = (async (url: string) => {
      const p = new URL(String(url), 'http://localhost').pathname
      const body = p === '/api/accounts' ? { accounts: [] } : { servers: [], turns: [], warnings: [] }
      return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }) as typeof fetch
  }
  const node = {
    id: 'agent', title: 'agent', state: 'live', tier: 'haiku', model_id: 'haiku',
    parent: 'USER', children: [], seat: 1, grant: 10, free: 10,
    scope: { permission_mode: 'acceptEdits', add_dirs: [], tools: { bash: true, web: true, edit: true, subagents: true, mcp: [] }, org_visibility: 'team' },
    charter: '', team_charter: '', turns: [], audiences_held: [],
  } as unknown as CanvasNode
  const tree = { slug: 'org', dirs: [], tiers: { haiku: 1, sonnet: 2 }, max_top_grant: 100, default_effort: '', effort_default: 'high', cascade_hire: true } as unknown as TreePayload
  const draft = { id: 'draft-1', tier: 'haiku', name: 'new', charter: '', x: 0, y: 0 } as never

  // Local Linux desktop + Linux engine -> hidden in both NodeConfig and DraftScopeModal
  setBridge({ platform: 'linux' })
  await seedHostOs('linux')
  mockApi()
  const vNodeLinux = await mountView(<NodeConfig node={node} map={new Map([[node.id, node]])} tree={tree} slug="org" op={async () => ({})} toast={() => {}} close={() => {}} />, el => el)
  try {
    await inAct(async () => { await flush(6) })
    assert.equal(document.body.querySelector('select[aria-label="Desktop session"]'), null, 'NodeConfig hides Desktop session on Linux engine')
  } finally { await vNodeLinux.unmount() }

  const vDraftLinux = await mountView(<DraftScopeModal draft={draft} map={new Map()} tree={tree} onSave={() => {}} close={() => {}} />, el => el)
  try {
    await inAct(async () => { await flush(6) })
    assert.equal(document.body.querySelector('select[aria-label="Desktop session"]'), null, 'DraftScopeModal hides Desktop session on Linux engine')
  } finally { await vDraftLinux.unmount() }

  // Linux desktop viewing a remote Windows engine -> shown in both
  setBridge({ platform: 'linux' })
  await seedHostOs('windows')
  mockApi()
  const vNodeRemoteWin = await mountView(<NodeConfig node={node} map={new Map([[node.id, node]])} tree={tree} slug="org" op={async () => ({})} toast={() => {}} close={() => {}} />, el => el)
  try {
    await inAct(async () => { await flush(6) })
    assert.ok(document.body.querySelector('select[aria-label="Desktop session"]'), 'remote Windows engine shows Desktop session')
  } finally { await vNodeRemoteWin.unmount() }

  const vDraftRemoteWin = await mountView(<DraftScopeModal draft={draft} map={new Map()} tree={tree} onSave={() => {}} close={() => {}} />, el => el)
  try {
    await inAct(async () => { await flush(6) })
    assert.ok(document.body.querySelector('select[aria-label="Desktop session"]'), 'remote Windows engine shows DraftScopeModal Desktop session')
  } finally { await vDraftRemoteWin.unmount() }
})

test('O-07: AppFilePermissionPrompt whole-computer wording branches on host OS', async t => {
  t.after(async () => { setBridge(undefined); await seedHostOs('windows') })
  const prompt = {
    session: 's1',
    request: { name: 'App', label: 'Panel', capability: 'files.read', request: { action: 'grant', scope: 'computer' } },
    finish: () => {},
  } as never

  await seedHostOs('linux')
  const vNix = await mountView(<AppFilePermissionPrompt slug="org" prompt={prompt} owner={document} />, el => el)
  try {
    const txt = document.body.textContent ?? ''
    assert.match(txt, /across the whole computer as your user account\?/)
    assert.match(txt, /that your system account can access\./)
    assert.doesNotMatch(txt, /Windows/)
  } finally { await vNix.unmount() }

  await seedHostOs('windows')
  const vWin = await mountView(<AppFilePermissionPrompt slug="org" prompt={prompt} owner={document} />, el => el)
  try {
    const txt = document.body.textContent ?? ''
    assert.match(txt, /across the whole computer as your Windows user\?/)
    assert.match(txt, /that Windows lets you access\./)
  } finally { await vWin.unmount() }
})

test('O-09: Antigravity single sign-in notices omit Windows Credential Manager off Windows', async t => {
  t.after(async () => { setBridge(undefined); await seedHostOs('windows') })
  const registry = {
    rows: [{
      id: 'google-2', provider: 'google', label: 'google-2', mode: 'subscription', ambient: false,
      credential: { kind: 'managed', path: '/tmp/g2' }, identity: { email: 'g2@example.test' },
      standing: { auth: 'unauthenticated', state: 'ready', marks: {} }, bound: [], tint_ordinal: 1,
    }],
    error: null,
    reload: async () => {},
  } as never

  await seedHostOs('linux')
  const vSecNix = await mountView(<AccountRegistrySection provider="google" registry={registry} toast={() => {}} />, el => el)
  const vDlgNix = await mountView(<AddAccountDialog provider="google" onAdded={async () => {}} close={() => {}} />, el => el)
  try {
    assert.match(vSecNix.el.textContent ?? '', /Antigravity keeps one Google sign-in per system user:/)
    assert.doesNotMatch(vSecNix.el.textContent ?? '', /Windows/)
    assert.match(vDlgNix.el.textContent ?? '', /per system user, in the system keyring\./)
    assert.doesNotMatch(vDlgNix.el.textContent ?? '', /Windows/)
  } finally { await vSecNix.unmount(); await vDlgNix.unmount() }

  await seedHostOs('windows')
  const vSecWin = await mountView(<AccountRegistrySection provider="google" registry={registry} toast={() => {}} />, el => el)
  const vDlgWin = await mountView(<AddAccountDialog provider="google" onAdded={async () => {}} close={() => {}} />, el => el)
  try {
    assert.match(vSecWin.el.textContent ?? '', /Antigravity keeps one Google sign-in per Windows user:/)
    assert.match(vDlgWin.el.textContent ?? '', /per Windows user, in the Windows Credential Manager\./)
  } finally { await vSecWin.unmount(); await vDlgWin.unmount() }
})

test('O-10 & B-01: PhonePanel uses This computer / this computer and omits Windows prompt off Windows', async t => {
  const prevFetch = g.fetch
  t.after(() => { setBridge(undefined); g.fetch = prevFetch })
  const state = {
    download_url: 'https://example.invalid/Hubchat.apk',
    download_qr: '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
    link: null,
    org: { slug: 'acme', name: 'Acme', address: 'acme.1', on_local_hub: true, persons: [], code: null },
    tailscale: { state: 'T2', backend: 'Running', account: 'user@example.com', pc: 'linux-box', ipv4: '100.64.0.2' },
    access: { state: 'A0', scope: 'tailnet', port: 7371, door: '', door_waiting: false, firewall: '', firewall_wanted: '' },
    hub: { running: true, healthy: true, error: null },
    card: { show: false, dismissed: false, org: 'acme' },
    warnings: {},
    hubchat_pc: false,
  }
  g.fetch = (async () => new Response(JSON.stringify(state), { status: 200 })) as typeof fetch

  setBridge({ platform: 'linux' })
  const vNix = await mountView(<PhonePanel org="acme" onClose={() => {}} />, el => el)
  try {
    await inAct(async () => { await flush(8) })
    const txt = vNix.el.textContent ?? ''
    assert.match(txt, /This computer/)
    assert.match(txt, /Let your phone reach this computer\./)
    assert.doesNotMatch(txt, /Windows asks for permission once/)
    assert.doesNotMatch(txt, /\bPC\b/)
  } finally { await vNix.unmount() }

  setBridge({ platform: 'win32' })
  const vWin = await mountView(<PhonePanel org="acme" onClose={() => {}} />, el => el)
  try {
    await inAct(async () => { await flush(8) })
    const txt = vWin.el.textContent ?? ''
    assert.match(txt, /This PC/)
    assert.match(txt, /Windows asks for permission once\./)
  } finally { await vWin.unmount() }
})

test('O-12: ShortcutsSettings omits Windows Alt+Shift/Alt+Space note off Windows', async t => {
  t.after(() => setBridge(undefined))
  setBridge({ platform: 'linux' })
  const vLin = await mountView(<ShortcutsSettings />, el => el)
  try {
    assert.doesNotMatch(vLin.el.textContent ?? '', /Windows may reserve Alt\+Shift/)
  } finally { await vLin.unmount() }

  setBridge({ platform: 'win32' })
  const vMac = await mountView(<ShortcutsSettings mac={true} />, el => el)
  try {
    assert.doesNotMatch(vMac.el.textContent ?? '', /Windows may reserve Alt\+Shift/)
  } finally { await vMac.unmount() }

  const vWin = await mountView(<ShortcutsSettings mac={false} />, el => el)
  try {
    assert.match(vWin.el.textContent ?? '', /Windows may reserve Alt\+Shift \/ Alt\+Space\. No OS setting is changed\./)
  } finally { await vWin.unmount() }
})

test('B-03: CharterTemplateDirsSetting uses symbolic link and omits junction/OneDrive off Windows', async t => {
  const prevFetch = g.fetch
  t.after(async () => { setBridge(undefined); await seedHostOs('windows'); g.fetch = prevFetch })
  g.fetch = (async () => new Response(JSON.stringify({
    dirs: ['/tmp/link'],
    directories: [{ path: '/tmp/link', status: 'link_refused', count: 0 }],
    duplicates: [],
  }), { status: 200 })) as typeof fetch

  await seedHostOs('linux')
  const vNix = await mountView(<CharterTemplateDirsSetting />, el => el)
  try {
    await inAct(async () => { await flush(6) })
    const txt = vNix.el.textContent ?? ''
    assert.match(txt, /refused — the path goes through a symbolic link/)
    assert.doesNotMatch(txt, /junction|OneDrive/i)
  } finally { await vNix.unmount() }

  await seedHostOs('windows')
  const vWin = await mountView(<CharterTemplateDirsSetting />, el => el)
  try {
    await inAct(async () => { await flush(6) })
    const txt = vWin.el.textContent ?? ''
    assert.match(txt, /refused — the path goes through a link or junction/)
    assert.match(txt, /OneDrive/)
  } finally { await vWin.unmount() }
})

test('B-04: composerKeyHint shows Command+Enter on macOS and keeps Ctrl+Enter on Windows/Linux', t => {
  t.after(() => setBridge(undefined))
  setBridge({ platform: 'darwin' })
  assert.equal(composerKeyHint('newline'), 'Enter inserts a new line; Command+Enter sends')
  setBridge({ platform: 'win32' })
  assert.equal(composerKeyHint('newline'), 'Enter inserts a new line; Ctrl+Enter sends')
  setBridge({ platform: 'linux' })
  assert.equal(composerKeyHint('newline'), 'Enter inserts a new line; Ctrl+Enter sends')
})
