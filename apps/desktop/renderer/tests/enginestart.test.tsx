// "engine starts" (docket option-to-run-the-background-engine-in-the-user-s):
// where the background engine starts while "run on startup" is on, at boot or
// at sign-in. Coordinator rulings 2026-10-15: shown only on an installation
// for all users on Windows, disabled while "run on startup" is off, and a
// change offers "Restart the background engine now" the way "Run Orgtree as
// administrator" does.
import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { EngineStartSetting } from '../src/canvas/desktopsettings'
import type { NativeDesktop } from '../src/desktop'
import type { EngineStartMode, EngineStartState } from '../../../../packages/contracts'

function native(value?: Partial<NativeDesktop>) {
  Object.defineProperty(window, 'orgtreeDesktop', { value, configurable: true })
}
const SELECT = 'select[aria-label="Where the background engine starts"]'
const restartButton = (el: Element) => [...el.querySelectorAll('button')].find(b => /Restart the background engine now/.test(b.textContent ?? ''))
async function choose(select: HTMLSelectElement, value: EngineStartMode) {
  await inAct(async () => {
    select.value = value
    select.dispatchEvent(new Event('change', { bubbles: true }))
    await flush(5)
  })
}

test('the choice changes only through the bridge and offers to restart an engine a task started', async () => {
  let state: EngineStartState = { installed: true, available: true, mode: 'boot', restartable: true }
  const calls: [EngineStartMode, boolean][] = []
  native({ getEngineStart: async () => state,
    setEngineStart: async (mode, restartNow) => { calls.push([mode, restartNow]); return state = { ...state, mode } } })
  const v = await mountView(<EngineStartSetting runOnStartup={true} />, el => el)
  try {
    await inAct(async () => { await flush(5) })
    const select = v.el.querySelector<HTMLSelectElement>(SELECT)!
    assert.ok(select, 'the choice is rendered')
    assert.equal(select.value, 'boot')
    assert.equal(select.disabled, false)
    assert.deepEqual([...select.options].map(o => o.textContent), ['At boot, before sign-in', 'At sign-in, in my session'])
    assert.match(v.el.textContent ?? '', /Windows asks for permission to change this/)
    assert.equal(restartButton(v.el) === undefined, true, 'nothing to restart before a change')
    await choose(select, 'signin')
    assert.deepEqual(calls, [['signin', false]])
    assert.equal(select.value, 'signin')
    const restart = restartButton(v.el)
    assert.ok(restart, 'a change offers the restart')
    assert.match(v.el.textContent ?? '', /Running agent turns are interrupted/)
    // Restart now repeats the chosen mode with restartNow; the offer then goes away.
    await inAct(async () => { restart!.click(); await flush(5) })
    assert.deepEqual(calls, [['signin', false], ['signin', true]])
    assert.equal(restartButton(v.el) === undefined, true)
  } finally { await v.unmount() }
})

test('an engine Orgtree started itself is not offered a restart: the change applies at the next start', async () => {
  let state: EngineStartState = { installed: true, available: true, mode: 'signin', restartable: false }
  native({ getEngineStart: async () => state, setEngineStart: async mode => (state = { ...state, mode }) })
  const v = await mountView(<EngineStartSetting runOnStartup={true} />, el => el)
  try {
    await inAct(async () => { await flush(5) })
    await choose(v.el.querySelector<HTMLSelectElement>(SELECT)!, 'boot')
    assert.equal(v.el.querySelector<HTMLSelectElement>(SELECT)!.value, 'boot')
    assert.equal(restartButton(v.el) === undefined, true)
  } finally { await v.unmount() }
})

test('a declined permission prompt is shown and leaves the choice where it was', async () => {
  native({ getEngineStart: async () => ({ installed: true, available: true, mode: 'boot', restartable: true }),
    setEngineStart: async () => { throw new Error('Windows did not give permission, so the engine still starts at boot.') } })
  const v = await mountView(<EngineStartSetting runOnStartup={true} />, el => el)
  try {
    await inAct(async () => { await flush(5) })
    const select = v.el.querySelector<HTMLSelectElement>(SELECT)!
    await choose(select, 'signin')
    assert.equal(select.value, 'boot')
    assert.match(v.el.querySelector('[role="alert"]')?.textContent ?? '', /still starts at boot/)
    assert.equal(restartButton(v.el) === undefined, true, 'no restart is offered for a change that did not happen')
  } finally { await v.unmount() }
})

test('with "run on startup" off the choice is disabled, says why, and is read again when it comes on', async () => {
  let on = false
  let reads = 0
  native({ getEngineStart: async () => { reads++
      return on ? { installed: true, available: true, mode: 'signin', restartable: true }
        : { installed: true, available: false, mode: 'signin', restartable: true, reason: 'Turn on "run on startup" to choose where the background engine starts.' } },
    setEngineStart: async () => { throw new Error('must not be called') } })
  const v = await mountView(<EngineStartSetting runOnStartup={false} />, el => el)
  try {
    await inAct(async () => { await flush(5) })
    assert.equal(v.el.querySelector<HTMLSelectElement>(SELECT)!.disabled, true)
    assert.match(v.el.textContent ?? '', /Turn on "run on startup"/)
    on = true
    await v.render(<EngineStartSetting runOnStartup={true} />)
    await inAct(async () => { await flush(5) })
    assert.equal(reads, 2, 'the choice is read again when "run on startup" changes')
    assert.equal(v.el.querySelector<HTMLSelectElement>(SELECT)!.disabled, false)
  } finally { await v.unmount() }
})

test('shown only on an installation for all users on Windows', async () => {
  native({ getEngineStart: async () => ({ installed: false, available: false, mode: 'boot', restartable: false, reason: 'Only an installation of Orgtree for all users on Windows has this choice.' }),
    setEngineStart: async () => { throw new Error('must not be called') } })
  const v = await mountView(<EngineStartSetting runOnStartup={true} />, el => el)
  try {
    await inAct(async () => { await flush(5) })
    assert.equal(v.el.textContent, '')
  } finally { await v.unmount() }
  native({})
  const bare = await mountView(<EngineStartSetting runOnStartup={true} />, el => el)
  try {
    await inAct(async () => { await flush(5) })
    assert.equal(bare.el.textContent, '', 'a bridge without the choice (browser, older desktop) renders nothing')
  } finally { await bare.unmount() }
})
