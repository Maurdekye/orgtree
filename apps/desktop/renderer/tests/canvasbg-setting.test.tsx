// The canvas background picker in App settings > Display (user ruling
// 2026-10-15 18:20Z): mounts the REAL settings panel on its Display tab
// against a native-preference bridge standing in for the main process
// (with the main process's own validator), and drives the rendered select
// and intensity slider: the choice is stored, each theme remembers its
// own intensity, untouched themes stay out of storage, and the choice
// survives a remount.
//
// Absence checks compare booleans (team notes, rig-opus 2026-10-14).

import { flush, inAct, mountView } from './harness'
import type { MountedView } from './harness'
import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { AccountsPanel } from '../src/canvas/accounts'
import type { NativePreferences } from '../src/desktop'
import { DEFAULT_PREFERENCES, preferencesPatch } from '../../main/policy'
import { CANVAS_BACKGROUNDS, CANVAS_BACKGROUND_LABELS, DEFAULT_CANVAS_INTENSITIES } from '../../../../packages/contracts/canvas-background'

const g = globalThis as unknown as Record<string, unknown>
const native = window as unknown as { orgtreeDesktop?: unknown }

/** the routes the panel reads on mount; everything else is refused */
function stubFetch(): void {
  g.fetch = (url: string, init?: RequestInit) => {
    const p = new URL(String(url), 'http://localhost').pathname
    const method = init?.method ?? 'GET'
    const payload = p === '/api/accounts' ? { version: 2, primary: null, keys: [], assignments: {}, accounts: [] }
      : p === '/api/providers' ? { providers: [] }
        : p === '/api/app-settings/runtime' && method === 'GET'
          ? { warming_enabled: true, verbose_logging: false, verbose_logging_pinned: false }
          : null
    if (!payload) return Promise.reject(new Error(`unexpected ${method} ${p}`))
    return Promise.resolve({ ok: true, status: 200, headers: new Headers(), json: () => Promise.resolve(payload) })
  }
}

interface Bridge {
  saved: () => NativePreferences
  writes: Partial<NativePreferences>[]
}

/** a stand-in for the main process: stores patches through the real
 *  validator and broadcasts the result, as main setPreferences does */
function installBridge(t: TestContext, initial: Partial<NativePreferences> = {}): Bridge {
  const previous = native.orgtreeDesktop
  let saved: NativePreferences = { ...DEFAULT_PREFERENCES, ...initial }
  const writes: Partial<NativePreferences>[] = []
  const listeners = new Set<(e: { type: string; data: unknown }) => void>()
  native.orgtreeDesktop = {
    getPreferences: async () => saved,
    setPreferences: async (patch: Partial<NativePreferences>) => {
      writes.push(patch)
      saved = { ...saved, ...preferencesPatch(patch) }
      for (const fn of [...listeners]) fn({ type: 'preferences', data: saved })
      return saved
    },
    onEvent: (fn: (e: { type: string; data: unknown }) => void) => {
      listeners.add(fn)
      return () => { listeners.delete(fn) }
    },
  }
  t.after(() => { native.orgtreeDesktop = previous })
  return { saved: () => saved, writes }
}

async function openDisplay(t: TestContext): Promise<MountedView<HTMLElement>> {
  stubFetch()
  const view = await mountView(<AccountsPanel toast={() => {}} close={() => {}} initialTab="display" />, el => el)
  await inAct(async () => { await flush(10) })
  t.after(async () => { await view.unmount(); delete g.fetch })
  return view
}

const panel = (el: HTMLElement) => el.querySelector<HTMLElement>('#app-settings-panel-display')
const bgSelect = (el: HTMLElement) => el.querySelector<HTMLSelectElement>('select[aria-label="Canvas background"]')
const bgSlider = (el: HTMLElement) => el.querySelector<HTMLInputElement>('input[aria-label="Background intensity"]')

async function choose(el: HTMLSelectElement, value: string): Promise<void> {
  await inAct(async () => { el.value = value; el.dispatchEvent(new Event('change', { bubbles: true })); await flush(6) })
}

async function slide(el: HTMLInputElement, value: string): Promise<void> {
  await inAct(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
    await flush(6)
  })
}

async function blur(el: HTMLElement): Promise<void> {
  await inAct(async () => { el.dispatchEvent(new Event('focusout', { bubbles: true })); await flush(6) })
}

test('Display offers every background theme and one intensity slider, starting on the dot grid with Claude Waves last', async (t) => {
  installBridge(t)
  const view = await openDisplay(t)
  const host = panel(view.el)
  assert.equal(host === null, false)
  const select = bgSelect(host!)
  assert.equal(select === null, false)
  const options = [...select!.options].map(o => [o.value, o.textContent])
  assert.deepEqual(options,
    CANVAS_BACKGROUNDS.map(id => [id, CANVAS_BACKGROUND_LABELS[id]]))
  assert.deepEqual(options[0], ['dots', 'Dot grid'])
  assert.deepEqual(options[options.length - 1], ['ascii', 'Claude Waves'])
  assert.equal(options.some(([v, l]) => v === 'checkerboard' && l === 'Checkerboard'), true)
  assert.equal(select!.value, 'dots')
  const slider = bgSlider(host!)
  assert.equal(slider === null, false)
  assert.equal(slider!.value, String(DEFAULT_CANVAS_INTENSITIES.dots))
  assert.equal(host!.textContent?.includes('100%'), true)
})

test('picking a theme stores it at once, and the slider then edits that theme only', async (t) => {
  const bridge = installBridge(t)
  const view = await openDisplay(t)
  const host = panel(view.el)!
  await choose(bgSelect(host)!, 'hex-lines')
  assert.deepEqual(bridge.saved().canvasBackground, { theme: 'hex-lines' })
  const slider = bgSlider(host)!
  assert.equal(slider.value, String(DEFAULT_CANVAS_INTENSITIES['hex-lines']))
  assert.equal(host.textContent?.includes('50%'), true)
  await slide(slider, '0.8')
  await blur(slider)
  assert.deepEqual(bridge.saved().canvasBackground,
    { theme: 'hex-lines', intensities: { 'hex-lines': 0.8 } })
  assert.equal(host.textContent?.includes('80%'), true)
  // another theme still shows its own untouched default, and switching to
  // it does not freeze that default into storage
  await choose(bgSelect(host)!, 'ascii')
  assert.equal(bgSlider(host)!.value, String(DEFAULT_CANVAS_INTENSITIES.ascii))
  assert.deepEqual(bridge.saved().canvasBackground,
    { theme: 'ascii', intensities: { 'hex-lines': 0.8 } })
  // and the edited theme kept its intensity
  await choose(bgSelect(host)!, 'hex-lines')
  assert.equal(bgSlider(host)!.value, '0.8')
})

test('a stored choice (including legacy ascii, legacy square-tiles -> Checkerboard, and v2 Square tiles) is what a fresh panel opens on', async (t) => {
  installBridge(t, { canvasBackground: { theme: 'triangle-tiles', intensities: { 'triangle-tiles': 0.25 } } })
  const view = await openDisplay(t)
  const host = panel(view.el)!
  assert.equal(bgSelect(host)!.value, 'triangle-tiles')
  assert.equal(bgSlider(host)!.value, '0.25')
  assert.equal(host.textContent?.includes('25%'), true)
  await view.unmount()

  installBridge(t, { canvasBackground: { theme: 'ascii', intensities: { ascii: 0.7 } } })
  const viewAscii = await openDisplay(t)
  const hostAscii = panel(viewAscii.el)!
  const selAscii = bgSelect(hostAscii)!
  assert.equal(selAscii.value, 'ascii')
  assert.equal(selAscii.selectedOptions[0]?.textContent, 'Claude Waves')
  assert.equal(bgSlider(hostAscii)!.value, '0.7')
  await viewAscii.unmount()

  // Legacy unversioned square-tiles selection loads as Checkerboard with its remembered intensity
  const bridgeLegacy = installBridge(t, { canvasBackground: { theme: 'square-tiles', intensities: { 'square-tiles': 0.3 } } })
  const viewLegacy = await openDisplay(t)
  const hostLegacy = panel(viewLegacy.el)!
  const selLegacy = bgSelect(hostLegacy)!
  assert.equal(selLegacy.value, 'checkerboard')
  assert.equal(selLegacy.selectedOptions[0]?.textContent, 'Checkerboard')
  assert.equal(bgSlider(hostLegacy)!.value, '0.3')
  assert.equal(hostLegacy.textContent?.includes('30%'), true)
  // Picking the new Square tiles option stores version: 2 alongside the migrated checkerboard intensity
  await choose(selLegacy, 'square-tiles')
  assert.deepEqual(bridgeLegacy.saved().canvasBackground, {
    theme: 'square-tiles',
    version: 2,
    intensities: { checkerboard: 0.3 },
  })
  const sliderSq = bgSlider(hostLegacy)!
  await slide(sliderSq, '0.65')
  await blur(sliderSq)
  assert.deepEqual(bridgeLegacy.saved().canvasBackground, {
    theme: 'square-tiles',
    version: 2,
    intensities: { checkerboard: 0.3, 'square-tiles': 0.65 },
  })
  await viewLegacy.unmount()

  // Reopening on that v2 square-tiles preference opens on Square tiles at 65%
  installBridge(t, { canvasBackground: bridgeLegacy.saved().canvasBackground })
  const viewSq = await openDisplay(t)
  const hostSq = panel(viewSq.el)!
  const selSq = bgSelect(hostSq)!
  assert.equal(selSq.value, 'square-tiles')
  assert.equal(selSq.selectedOptions[0]?.textContent, 'Square tiles')
  assert.equal(bgSlider(hostSq)!.value, '0.65')
})
