// shellgeneral.test.tsx — the App settings "General" tab.
//
// Two things the v3 shell moved here, for two different reasons.
//
// THE STARTUP CHOICE is new, and is a NATIVE preference rather than a renderer
// one: what it decides — whether the app reopens your previous organization
// windows or starts with one fresh Homepage — happens before any renderer
// exists to hold an opinion. It is also the clearest case of the settled
// shared-value rule: every window owns its own settings modal, and all of them
// read and write the one app-wide document.
//
// ABOUT is old. The running app version was a badge beside the sidebar's
// Orgtree title, with the repository link next to it, and the v3 shell removes
// that sidebar. The compact menu shows the version inline; this tab keeps the
// fuller detail, including the engine build that answers "which deploy is
// actually serving".
//
// Run:  node apps/desktop/renderer/tests/run.mjs shellgeneral
import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { AboutSection, StartupWindowsSetting } from '../src/shell/general'
import { installBridge, removeBridge } from './shellbridge'

interface Saved { startupMode?: string }

/** A v3 shell: `requestOrg` is the capability the startup choice is gated on,
 *  because a shell without it has no multi-window startup to choose between. */
function v3Bridge(initial: Saved, saves: Saved[], onEvent?: (fn: (e: { type: string; data: unknown }) => void) => void) {
  let prefs: Saved = { ...initial }
  return installBridge({
    requestOrg: async () => ({ action: 'pending', org: 'x' }),
    getPreferences: async () => prefs,
    setPreferences: async (patch: Saved) => { saves.push(patch); prefs = { ...prefs, ...patch }; return prefs },
    onEvent: (fn: (e: { type: string; data: unknown }) => void) => { onEvent?.(fn); return () => {} },
  })
}

const radios = (el: HTMLElement) =>
  [...el.querySelectorAll<HTMLInputElement>('input[type="radio"]')]

test('a shell that cannot honour the startup choice does not offer it', async () => {
  // no bridge at all — a plain browser
  let view = await mountView(<StartupWindowsSetting />, (el) => el)
  await inAct(async () => { await flush() })
  assert.equal(radios(view.el).length, 0, 'the browser has no windows to restore')
  await view.unmount()

  // a bridge WITHOUT the v3 window model — today's shipped shell
  const bridge = installBridge({ getPreferences: async () => ({}) })
  try {
    view = await mountView(<StartupWindowsSetting />, (el) => el)
    await inAct(async () => { await flush() })
    assert.equal(radios(view.el).length, 0,
      'a preference nothing reads is a capability claim the app cannot meet')
    await view.unmount()
  } finally { removeBridge(bridge) }
})

test('restoring previous windows is the default, and is what an older shell reads as', async () => {
  const saves: Saved[] = []
  const bridge = v3Bridge({}, saves)     // no startupMode stored at all
  try {
    const view = await mountView(<StartupWindowsSetting />, (el) => el)
    await inAct(async () => { await flush() })
    const [restore, homepage] = radios(view.el)
    assert.ok(restore && homepage, 'exactly the two settled choices')
    assert.equal(restore!.value, 'restore')
    assert.equal(homepage!.value, 'homepage')
    assert.equal(restore!.checked, true, 'restoring is the default')
    assert.equal(homepage!.checked, false)
    assert.deepEqual(saves, [], 'reading the default writes nothing')
    await view.unmount()
  } finally { removeBridge(bridge) }
})

test('choosing the other option writes THAT KEY ALONE to the native preferences', async () => {
  const saves: Saved[] = []
  const bridge = v3Bridge({ startupMode: 'restore' }, saves)
  try {
    const view = await mountView(<StartupWindowsSetting />, (el) => el)
    await inAct(async () => { await flush() })
    await inAct(async () => { radios(view.el)[1]!.click(); await flush(6) })
    assert.deepEqual(saves, [{ startupMode: 'homepage' }],
      'one key — a body carrying a neighbouring preference would rewrite a value nobody touched')
    assert.equal(radios(view.el)[1]!.checked, true, 'and the choice is reflected back')
    await view.unmount()
  } finally { removeBridge(bridge) }
})

test('a save in ANOTHER window lands here — the values are app-wide, the modal is not', async () => {
  const saves: Saved[] = []
  let fire: (e: { type: string; data: unknown }) => void = () => {}
  const bridge = v3Bridge({ startupMode: 'restore' }, saves, (fn) => { fire = fn })
  try {
    const view = await mountView(<StartupWindowsSetting />, (el) => el)
    await inAct(async () => { await flush() })
    assert.equal(radios(view.el)[0]!.checked, true)
    // the native `preferences` event is broadcast to every main window
    await inAct(async () => {
      fire({ type: 'preferences', data: { startupMode: 'homepage' } }); await flush(4)
    })
    assert.equal(radios(view.el)[1]!.checked, true,
      'this window never asked and never focused the other one')
    assert.deepEqual(saves, [], 'and adopting somebody else’s save does not re-save it')
    await view.unmount()
  } finally { removeBridge(bridge) }
})

// ----------------------------------------------------------------- About

const HOST = {
  build: { commit: 'abc1234', branch: 'main', started_at: '2026-09-10T12:00:00Z' },
}

async function about(appVersion: string | null, host: unknown = HOST) {
  const old = globalThis.fetch
  globalThis.fetch = (async () => ({
    ok: true, headers: new Headers(), json: async () => host,
  })) as unknown as typeof fetch
  const view = await mountView(<AboutSection appVersion={appVersion} />, (el) => el)
  await inAct(async () => { await flush(8) })
  return { view, stop: async () => { await view.unmount(); globalThis.fetch = old } }
}

test('About names the running app version and the engine build that is serving', async () => {
  const a = await about('3.0.0-alpha.0')
  try {
    const text = a.view.el.textContent ?? ''
    assert.match(text, /3\.0\.0-alpha\.0/, 'the packaged version')
    assert.match(text, /main@abc1234/, 'the engine build — which deploy is actually serving')
    assert.match(text, /started/)
    const link = a.view.el.querySelector('a')!
    assert.equal(link.getAttribute('href'), 'https://github.com/Maurdekye/orgtree',
      'the repository link the removed sidebar used to carry')
  } finally { await a.stop() }
})

test('a plain browser is given no invented version, and an unknown build no fake hash', async () => {
  const a = await about(null)
  try {
    assert.doesNotMatch(a.view.el.textContent ?? '', /3\.0\.0/)
    assert.match(a.view.el.textContent ?? '', /main@abc1234/, 'the engine hash still stands alone')
  } finally { await a.stop() }
  const b = await about(null, { build: { commit: 'unknown', branch: '', started_at: '' } })
  try {
    assert.match(b.view.el.textContent ?? '', /version unknown/,
      'nothing known, and it says so rather than showing a blank')
  } finally { await b.stop() }
})
