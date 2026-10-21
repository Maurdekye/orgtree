import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { RunAsAdministratorSetting } from '../src/canvas/desktopsettings'

function bridge(canRun: boolean, launch: () => Promise<unknown>, changes: boolean[]) {
  Object.defineProperty(window, 'orgtreeDesktop', { configurable: true, value: {
    getRunAsAdministrator: async () => ({ available: true, enabled: true, canRunInSession: canRun }),
    setRunAsAdministrator: async (enabled: boolean) => { changes.push(enabled); return { available: true, enabled } },
    runThisSessionAsAdmin: launch,
  } })
}

test('Session 0 toggle and independent current-session action share the settings row', async () => {
  const changes: boolean[] = []; let launches = 0
  bridge(true, async () => { launches++; return { available: true, enabled: true, canRunInSession: true } }, changes)
  const v = await mountView(<RunAsAdministratorSetting />, el => el)
  try {
    await inAct(async () => { await flush(5) })
    const toggle = v.el.querySelector<HTMLInputElement>('input[aria-label="Run Session 0 as admin"]')
    assert.ok(!!toggle, 'the toggle names Session 0 explicitly')
    assert.equal(toggle!.checked, true)
    const button = [...v.el.querySelectorAll('button')].find(b => b.textContent === 'Run this session as admin')
    assert.ok(!!button, 'the one-off button is visible')
    assert.equal(toggle!.closest('.set-row'), button!.closest('.set-row'))
    await inAct(async () => { button!.click(); await flush(5) })
    assert.equal(launches, 1)
    assert.deepEqual(changes, [], 'one-off launch never changes the stored boot toggle')
    assert.equal(toggle!.checked, true)
  } finally { await v.unmount() }
})

test('one-off admin action is disabled without a signed-in console', async () => {
  let launches = 0
  bridge(false, async () => { launches++ }, [])
  const v = await mountView(<RunAsAdministratorSetting />, el => el)
  try {
    await inAct(async () => { await flush(5) })
    const button = [...v.el.querySelectorAll('button')].find(b => b.textContent === 'Run this session as admin')
    assert.ok(!!button)
    assert.equal(button!.disabled, true)
    await inAct(async () => { button!.click(); await flush(5) })
    assert.equal(launches, 0)
  } finally { await v.unmount() }
})

test('declined one-off elevation leaves the toggle unchanged and reports the refusal', async () => {
  const changes: boolean[] = []
  bridge(true, async () => { throw new Error('Windows did not give permission; the running engine is unchanged.') }, changes)
  const v = await mountView(<RunAsAdministratorSetting />, el => el)
  try {
    await inAct(async () => { await flush(5) })
    const button = [...v.el.querySelectorAll('button')].find(b => b.textContent === 'Run this session as admin')
    assert.ok(!!button)
    await inAct(async () => { button!.click(); await flush(5) })
    assert.match(v.el.querySelector('[role="alert"]')?.textContent ?? '', /running engine is unchanged/)
    assert.deepEqual(changes, [])
    assert.equal(v.el.querySelector<HTMLInputElement>('input')!.checked, true)
  } finally { await v.unmount() }
})
