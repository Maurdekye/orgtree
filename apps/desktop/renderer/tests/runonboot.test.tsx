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
