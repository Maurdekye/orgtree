import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { RunAsAdministratorSetting } from '../src/canvas/desktopsettings'
import type { NativeDesktop } from '../src/desktop'
import type { RunAsAdministratorState } from '../../../../packages/contracts'

function native(value?: Partial<NativeDesktop>) {
  Object.defineProperty(window, 'orgtreeDesktop', { value, configurable: true })
}

test('"run Orgtree as administrator" is off by default, warns, and changes only through the bridge', async () => {
  let state: RunAsAdministratorState = { available: true, enabled: false }
  const calls: [boolean, boolean][] = []
  native({ getRunAsAdministrator: async () => state,
    setRunAsAdministrator: async (enabled, restartNow) => { calls.push([enabled, restartNow]); return state = { ...state, enabled } } })
  const v = await mountView(<RunAsAdministratorSetting />, el => el)
  try {
    await inAct(async () => { await flush(5) })
    const toggle = v.el.querySelector<HTMLInputElement>('input[aria-label="run Orgtree as administrator"]')!
    assert.ok(toggle, 'the switch is rendered')
    assert.equal(toggle.checked, false)
    assert.equal(toggle.disabled, false)
    assert.match(v.el.textContent ?? '', /Agents get full control of this PC/)
    assert.equal(v.el.querySelector('button'), null, 'nothing to restart before a change')
    // Turning it on asks main to write it; it applies at the next engine start.
    await inAct(async () => { toggle.click(); await flush(5) })
    assert.deepEqual(calls, [[true, false]])
    assert.equal(toggle.checked, true)
    const restart = [...v.el.querySelectorAll('button')].find(b => /Restart the background engine now/.test(b.textContent ?? ''))
    assert.ok(restart, 'a change offers the restart')
    // Restart now repeats the stored value with restartNow; the offer then goes away.
    await inAct(async () => { restart!.click(); await flush(5) })
    assert.deepEqual(calls, [[true, false], [true, true]])
    assert.equal(v.el.querySelector('button'), null)
  } finally { await v.unmount() }
})

test('a refused change (UAC declined) is shown and leaves the switch where it was', async () => {
  native({ getRunAsAdministrator: async () => ({ available: true, enabled: false }),
    setRunAsAdministrator: async () => { throw new Error('Windows did not give permission, so the setting was not changed.') } })
  const v = await mountView(<RunAsAdministratorSetting />, el => el)
  try {
    await inAct(async () => { await flush(5) })
    const toggle = v.el.querySelector<HTMLInputElement>('input[aria-label="run Orgtree as administrator"]')!
    await inAct(async () => { toggle.click(); await flush(5) })
    assert.equal(toggle.checked, false)
    assert.match(v.el.querySelector('[role="alert"]')?.textContent ?? '', /did not give permission/)
    assert.equal(v.el.querySelector('button'), null, 'no restart is offered for a change that did not happen')
  } finally { await v.unmount() }
})

test('without a background engine the switch is disabled and says why', async () => {
  const reason = "Orgtree is not using its background engine, so the engine runs with Orgtree's own rights."
  native({ getRunAsAdministrator: async () => ({ available: false, enabled: false, reason }),
    setRunAsAdministrator: async () => { throw new Error('must not be called') } })
  const v = await mountView(<RunAsAdministratorSetting />, el => el)
  try {
    await inAct(async () => { await flush(5) })
    const toggle = v.el.querySelector<HTMLInputElement>('input[aria-label="run Orgtree as administrator"]')!
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
