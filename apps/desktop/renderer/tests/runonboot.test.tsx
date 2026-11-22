// "Run on boot" (docket option-to-run-the-background-engine-in-the-user-s, the
// user 2026-10-16 09:38Z): ONE switch in place of "run on startup" and its
// "engine starts" choice, named after what the desktop says this installation
// can do: "run on boot", or "run on sign-in" where Orgtree cannot start at
// boot (a per-user installation, macOS, Linux; coordinator ruling A). Settings
// and first-run setup show the same switch.
import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { DesktopSettings } from '../src/canvas/desktopsettings'
import { Onboarding } from '../src/canvas/onboarding'
import type { NativeDesktop, NativePreferences } from '../src/desktop'
import type { StartupKind } from '../../../../packages/contracts'

const prefs = { startAtLogin: true, exitOnClose: false, routineNotifications: false, onboarded: false } as NativePreferences
function native(kind?: StartupKind, startupCapability?: { available: boolean; reason?: string }) {
  const value: Partial<NativeDesktop> & { getStartupCapability?: () => Promise<{ available: boolean; reason?: string }> } = {
    getPreferences: async () => prefs, setPreferences: async patch => ({ ...prefs, ...patch }), onEvent: () => () => {},
    ...(kind ? { getStartupKind: async () => kind } : {}),
    ...(startupCapability ? { getStartupCapability: async () => startupCapability } : {}),
  }
  Object.defineProperty(window, 'orgtreeDesktop', { value, configurable: true })
}
const startupSwitch = (el: Element) => el.querySelector<HTMLInputElement>('input[role="switch"]')
const SIGNIN = /Start Orgtree quietly in the system tray when you sign in/
const BOOT = /when the computer starts, before anyone signs in\. While you are signed in, agents run in your session/

for (const [kind, label, hint, other] of [
  ['boot', 'Run on boot', BOOT, SIGNIN],
  ['signin', "Run on sign-in", SIGNIN, BOOT],
  [undefined, 'Run on boot', BOOT, SIGNIN], // a desktop that does not say
] as const) {
  test(`Settings name the one startup switch for what starts: ${kind ?? 'unsaid'}`, async () => {
    native(kind)
    const v = await mountView(<DesktopSettings />, el => el)
    try {
      await inAct(async () => { await flush(5) })
      assert.equal(startupSwitch(v.el)?.getAttribute('aria-label'), label)
      assert.equal(startupSwitch(v.el)?.checked, true)
      const text = v.el.textContent ?? ''
      assert.match(text, hint)
      assert.doesNotMatch(text, other)
      assert.ok(!v.el.querySelector('select[aria-label="Where the background engine starts"]'),
        'the removed "engine starts" choice is gone; unrelated preferences may use selects')
      assert.doesNotMatch(text, /run on startup|engine starts/i)
    } finally { await v.unmount() }
  })
}

test('first-run setup shows the same switch', async () => {
  for (const [kind, label] of [['boot', 'Run on boot'], ['signin', "Run on sign-in"]] as const) {
    native(kind)
    const v = await mountView(<Onboarding><div /></Onboarding>, el => el)
    try {
      await inAct(async () => { await flush(5) })
      assert.equal(startupSwitch(v.el)?.getAttribute('aria-label'), label)
      assert.doesNotMatch(v.el.textContent ?? '', /run on startup/i)
    } finally { await v.unmount() }
  }
})

test('non-default data folder disables the startup switch with the one-line hint in Settings and Onboarding', async () => {
  const reason = 'Run on startup is only available for the default data folder.'
  for (const [name, node] of [
    ['Settings', <DesktopSettings />],
    ['Onboarding', <Onboarding><div /></Onboarding>],
  ] as const) {
    native('signin', { available: false, reason })
    const v = await mountView(node, el => el)
    try {
      await inAct(async () => { await flush(5) })
      const sw = startupSwitch(v.el)
      assert.ok(sw, `${name}: startup switch rendered`)
      assert.equal(sw.getAttribute('aria-label'), 'Run on sign-in')
      assert.equal(sw.disabled, true, `${name}: switch must be disabled`)
      assert.equal(sw.checked, false, `${name}: disabled non-default switch must not show on`)
      const text = v.el.textContent ?? ''
      assert.ok(text.includes(reason), `${name}: must show the exact default-folder hint`)
      assert.doesNotMatch(text, SIGNIN, `${name}: must not show the active sign-in hint while disabled`)
    } finally { await v.unmount() }
  }
})

test('Linux and macOS keep the startup switch disabled until capability responds (no enabled flash); Windows stays unchanged', async () => {
  const reason = 'Run on startup is only available for the default data folder.'
  for (const platform of ['linux', 'darwin'] as const) {
    for (const [name, makeNode] of [
      ['Settings', () => <DesktopSettings />],
      ['Onboarding', () => <Onboarding><div /></Onboarding>],
    ] as const) {
      let resolveCap!: (c: { available: boolean; reason?: string }) => void
      const writes: unknown[] = []
      const value: Partial<NativeDesktop> & {
        platform?: string
        getStartupCapability?: () => Promise<{ available: boolean; reason?: string }>
      } = {
        platform,
        getPreferences: async () => prefs,
        setPreferences: async patch => { writes.push(patch); return { ...prefs, ...patch } },
        onEvent: () => () => {},
        getStartupKind: async () => 'signin',
        getStartupCapability: () => new Promise(resolve => { resolveCap = resolve }),
      }
      Object.defineProperty(window, 'orgtreeDesktop', { value, configurable: true })
      const v = await mountView(makeNode(), el => el)
      try {
        // Preferences resolve while capability is still pending: switch must stay disabled (no enabled flash)
        await inAct(async () => { await flush(5) })
        const sw = startupSwitch(v.el)!
        assert.ok(sw, `${platform} ${name}: switch rendered`)
        assert.equal(sw.disabled, true, `${platform} ${name}: disabled while capability pending`)
        assert.equal(sw.checked, false, `${platform} ${name}: unchecked while capability pending`)
        assert.doesNotMatch(v.el.textContent ?? '', SIGNIN, `${platform} ${name}: no active hint flash while pending`)
        await inAct(async () => { sw.click(); await flush(3) })
        assert.deepEqual(writes, [], `${platform} ${name}: clicking while pending writes nothing`)

        // Resolving unavailable keeps it disabled with exact hint
        await inAct(async () => { resolveCap({ available: false, reason }); await flush(5) })
        assert.equal(sw.disabled, true)
        assert.equal(sw.checked, false)
        assert.ok((v.el.textContent ?? '').includes(reason))
      } finally { await v.unmount() }

      // Resolving available enables the switch
      let resolveAvail!: (c: { available: boolean; reason?: string }) => void
      Object.defineProperty(window, 'orgtreeDesktop', {
        value: { ...value, getStartupCapability: () => new Promise(resolve => { resolveAvail = resolve }) },
        configurable: true,
      })
      const v2 = await mountView(makeNode(), el => el)
      try {
        await inAct(async () => { await flush(5) })
        assert.equal(startupSwitch(v2.el)!.disabled, true, `${platform} ${name}: disabled before available arrives`)
        await inAct(async () => { resolveAvail({ available: true }); await flush(5) })
        assert.equal(startupSwitch(v2.el)!.disabled, false, `${platform} ${name}: enabled once available arrives`)
        assert.equal(startupSwitch(v2.el)!.checked, true)
        assert.match(v2.el.textContent ?? '', SIGNIN)
      } finally { await v2.unmount() }

      // Failed capability read stays disabled (fail closed)
      Object.defineProperty(window, 'orgtreeDesktop', {
        value: { ...value, getStartupCapability: () => Promise.reject(new Error('ipc failed')) },
        configurable: true,
      })
      const v3 = await mountView(makeNode(), el => el)
      try {
        await inAct(async () => { await flush(5) })
        assert.equal(startupSwitch(v3.el)!.disabled, true, `${platform} ${name}: stays disabled on capability error`)
      } finally { await v3.unmount() }
    }
  }

  // Windows unchanged: switch enables as soon as preferences arrive even while capability is pending
  let resolveWin!: (c: { available: boolean; reason?: string }) => void
  Object.defineProperty(window, 'orgtreeDesktop', {
    value: {
      platform: 'win32',
      getPreferences: async () => prefs,
      setPreferences: async patch => ({ ...prefs, ...patch }),
      onEvent: () => () => {},
      getStartupKind: async () => 'boot',
      getStartupCapability: () => new Promise(resolve => { resolveWin = resolve }),
    },
    configurable: true,
  })
  const vWin = await mountView(<DesktopSettings />, el => el)
  try {
    await inAct(async () => { await flush(5) })
    const sw = startupSwitch(vWin.el)!
    assert.equal(sw.disabled, false, 'Windows: switch is not held disabled while capability is pending')
    assert.equal(sw.checked, true, 'Windows: switch shows stored startAtLogin immediately')
    assert.match(vWin.el.textContent ?? '', BOOT, 'Windows: shows boot hint immediately')
    resolveWin({ available: true })
  } finally { await vWin.unmount() }
})
