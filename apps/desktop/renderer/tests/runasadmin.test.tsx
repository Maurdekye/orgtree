import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { RunAsAdministratorSetting } from '../src/canvas/desktopsettings'
import type { NativeDesktop } from '../src/desktop'
import type { RunAsAdministratorState } from '../../../../packages/contracts'

function native(value?: Partial<NativeDesktop>) {
  Object.defineProperty(window, 'orgtreeDesktop', { value, configurable: true })
}

test('"Run as admin" is off by default, warns, and a change applies at once (coordinator Q1)', async () => {
  let state: RunAsAdministratorState = { available: true, enabled: false }
  const calls: unknown[][] = []
  native({ getRunAsAdministrator: async () => state,
    setRunAsAdministrator: (async (...args: unknown[]) => { calls.push(args); return state = { ...state, enabled: args[0] === true } }) as NativeDesktop['setRunAsAdministrator'] })
  const v = await mountView(<RunAsAdministratorSetting />, el => el)
  try {
    await inAct(async () => { await flush(5) })
    const toggle = v.el.querySelector<HTMLInputElement>('input[aria-label="Run as admin"]')!
    assert.ok(toggle, 'the switch is rendered')
    assert.equal(toggle.checked, false)
    assert.equal(toggle.disabled, false)
    assert.match(v.el.textContent ?? '', /Every agent runs with full administrator rights/)
    // invariant 7: the engine and the sign-in helper change together, at once
    assert.match(v.el.textContent ?? '', /engine in Session 0 and the sign-in helper in your session/)
    assert.match(v.el.textContent ?? '', /restart at once/)
    await inAct(async () => { toggle.click(); await flush(5) })
    assert.deepEqual(calls, [[true]], 'one call: main writes it and restarts the engine, and the helper follows')
    assert.equal(toggle.checked, true)
    assert.equal(v.el.querySelector('button') === null, true, 'no restart is left to offer: nothing is pending')
  } finally { await v.unmount() }
})

test('the one-off "Run this session as admin" is gone, even from a bridge that still offers it (user Q2)', async () => {
  let launches = 0
  native({ getRunAsAdministrator: async () => ({ available: true, enabled: false, canRunInSession: true }) as RunAsAdministratorState,
    setRunAsAdministrator: async () => ({ available: true, enabled: false }),
    runThisSessionAsAdmin: async () => { launches++; return { available: true, enabled: false } } } as unknown as Partial<NativeDesktop>)
  const v = await mountView(<RunAsAdministratorSetting />, el => el)
  try {
    await inAct(async () => { await flush(5) })
    assert.ok(v.el.querySelector('input[aria-label="Run as admin"]'), 'the setting itself stays')
    assert.equal([...v.el.querySelectorAll('button')].some(b => /Run this session as admin/.test(b.textContent ?? '')), false)
    assert.equal(launches, 0)
  } finally { await v.unmount() }
})

test('a refused change (UAC declined) is shown and leaves the switch where it was', async () => {
  native({ getRunAsAdministrator: async () => ({ available: true, enabled: false }),
    setRunAsAdministrator: async () => { throw new Error('Windows did not give permission, so the setting was not changed.') } })
  const v = await mountView(<RunAsAdministratorSetting />, el => el)
  try {
    await inAct(async () => { await flush(5) })
    const toggle = v.el.querySelector<HTMLInputElement>('input[aria-label="Run as admin"]')!
    await inAct(async () => { toggle.click(); await flush(5) })
    assert.equal(toggle.checked, false)
    assert.match(v.el.querySelector('[role="alert"]')?.textContent ?? '', /did not give permission/)
    assert.equal(v.el.querySelector('button') === null, true, 'no restart is offered for a change that did not happen')
  } finally { await v.unmount() }
})

test('without a background engine the switch is disabled and says why', async () => {
  const reason = "Orgtree is not using its background engine, so the engine runs with Orgtree's own rights."
  native({ getRunAsAdministrator: async () => ({ available: false, enabled: false, reason }),
    setRunAsAdministrator: async () => { throw new Error('must not be called') } })
  const v = await mountView(<RunAsAdministratorSetting />, el => el)
  try {
    await inAct(async () => { await flush(5) })
    const toggle = v.el.querySelector<HTMLInputElement>('input[aria-label="Run as admin"]')!
    assert.equal(toggle.disabled, true)
    assert.match(v.el.textContent ?? '', /not using its background engine/)
  } finally { await v.unmount() }
})

test('a bridge without the setting (browser, older desktop) renders nothing', async () => {
  native({})
  const v = await mountView(<RunAsAdministratorSetting />, el => el)
  try {
    await inAct(async () => { await flush(5) })
    assert.equal(v.el.textContent, '')
  } finally { await v.unmount() }
})
