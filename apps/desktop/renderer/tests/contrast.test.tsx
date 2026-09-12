import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { ContrastSetting, applyContrast, startContrastSync } from '../src/contrast'
import { ThemeSetting, applyTheme } from '../src/themes'
import type { NativeDesktop, NativePreferences } from '../src/desktop'
import type { DesktopEvent } from '../../../../packages/contracts'
import { CONTRAST_THEMES } from '../../../../packages/contracts/contrast-theme'

declare const __SRC_DIR__: string
const native = (value?: Partial<NativeDesktop>) => Object.defineProperty(window, 'orgtreeDesktop', { value, configurable: true })
const prefs = (contrastTheme: NativePreferences['contrastTheme'] = 'charcoal'): NativePreferences => ({
  contrastTheme, visualTheme:'custom:#8435cf', visualThemeExplicit:true, startAtLogin:true,
  exitOnClose:false, automaticUpdates:true, routineNotifications:false, onboarded:true,
})
const select = (el: Element) => el.querySelector<HTMLSelectElement>('[aria-label="Contrast color"]')!
async function change(el: HTMLSelectElement, value: string) {
  await inAct(async () => { el.value = value; el.dispatchEvent(new window.Event('change', { bubbles: true })); await flush() })
}
const chosen = () => CONTRAST_THEMES.filter(id => document.documentElement.classList.contains(`contrast-${id}`))

test('Appearance offers the exact four contrast choices independently of custom and preset accents, and reloads them', async () => {
  native(); localStorage.clear()
  localStorage.setItem('orgtree-visual-theme', 'custom:#8435cf')
  document.documentElement.classList.add('mobile')
  const stop = startContrastSync()
  const view = await mountView(<ThemeSetting />, el => el)
  try {
    const contrast = select(view.el), accent = view.el.querySelector<HTMLSelectElement>('[aria-label="Visual theme"]')!
    assert.equal(view.el.querySelectorAll('select').length, 2)
    assert.deepEqual([...contrast.options].map(x => x.textContent), ['Charcoal', 'Light', 'Solarized Light', 'Obsidian Black'])
    assert.equal(contrast.value, 'charcoal')
    for (const id of CONTRAST_THEMES) {
      await change(contrast, id)
      assert.equal(localStorage.getItem('orgtree-contrast-theme'), id)
      assert.deepEqual(chosen(), [id])
      assert.equal(document.documentElement.style.getPropertyValue('--accent'), '#8435cf')
      assert.equal(localStorage.getItem('orgtree-visual-theme'), 'custom:#8435cf')
      assert.ok(document.documentElement.classList.contains('mobile'), 'unrelated root classes survive')
    }
    await change(accent, 'codex')
    assert.deepEqual(chosen(), ['obsidian-black'])
    assert.equal(localStorage.getItem('orgtree-contrast-theme'), 'obsidian-black')
    stop(); applyContrast('charcoal')
    const stopReloaded = startContrastSync()
    assert.deepEqual(chosen(), ['obsidian-black'], 'startup restores without opening settings')
    stopReloaded()
  } finally { await view.unmount(); stop(); localStorage.clear(); document.documentElement.classList.remove('mobile'); applyContrast('charcoal') }
})

test('browser settings follow other windows, resets and same-window changes; an unavailable store leaves the prior selection', async () => {
  native(); localStorage.clear()
  const stop = startContrastSync()
  const view = await mountView(<><ContrastSetting /><ContrastSetting /></>, el => el)
  const controls = [...view.el.querySelectorAll<HTMLSelectElement>('select')]
  const setItem = window.Storage.prototype.setItem
  try {
    await change(controls[0]!, 'solarized-light')
    assert.equal(controls[1]!.value, 'solarized-light', 'another mounted settings surface stays synchronized')
    await inAct(async () => {
      localStorage.setItem('orgtree-contrast-theme', 'light')
      window.dispatchEvent(new window.StorageEvent('storage', { key:'orgtree-contrast-theme', newValue:'light' }))
    })
    assert.deepEqual(controls.map(x => x.value), ['light', 'light'])
    window.Storage.prototype.setItem = () => { throw Error('Storage unavailable') }
    await change(controls[0]!, 'obsidian-black')
    assert.equal(controls[0]!.value, 'light')
    assert.deepEqual(chosen(), ['light'])
    assert.match(view.el.querySelector('[role="alert"]')!.textContent!, /Storage unavailable/)
    window.Storage.prototype.setItem = setItem
    await inAct(async () => { localStorage.clear(); window.dispatchEvent(new window.StorageEvent('storage', { key:null })) })
    assert.deepEqual(controls.map(x => x.value), ['charcoal', 'charcoal'])
    await inAct(async () => {
      localStorage.setItem('orgtree-contrast-theme', 'invalid')
      window.dispatchEvent(new window.StorageEvent('storage', { key:'orgtree-contrast-theme', newValue:'invalid' }))
    })
    assert.deepEqual(chosen(), ['charcoal'])
  } finally { window.Storage.prototype.setItem = setItem; await view.unmount(); stop(); localStorage.clear() }
})

test('native broadcasts beat a stale startup read, and only contrast is written through the native preference bridge', async () => {
  const listeners = new Set<(e: DesktopEvent) => void>(), reads: Array<(p: NativePreferences) => void> = [], writes: unknown[] = []
  let stored = prefs()
  const broadcast = (value: NativePreferences) => { for (const fn of listeners) fn({ type:'preferences', data:value }) }
  native({ getPreferences:() => new Promise(resolve => reads.push(resolve)), onEvent:fn => { listeners.add(fn); return () => { listeners.delete(fn) } },
    setPreferences:async patch => { writes.push(patch); stored = { ...stored, ...patch }; broadcast(stored); return stored } })
  applyTheme('custom:#8435cf')
  const stop = startContrastSync(), view = await mountView(<ContrastSetting />, el => el)
  try {
    assert.equal(select(view.el).disabled, true)
    await inAct(async () => { broadcast(prefs('light')); reads.forEach(resolve => resolve(prefs('charcoal'))); await flush() })
    assert.equal(select(view.el).value, 'light')
    assert.deepEqual(chosen(), ['light'])
    for (const id of CONTRAST_THEMES) await change(select(view.el), id)
    assert.deepEqual(writes, CONTRAST_THEMES.map(contrastTheme => ({ contrastTheme })))
    assert.equal(stored.visualTheme, 'custom:#8435cf')
    assert.equal(document.documentElement.style.getPropertyValue('--accent'), '#8435cf')
    await view.unmount(); stop()
    assert.equal(listeners.size, 0)
    applyContrast('charcoal')
    const restore = startContrastSync()
    reads.at(-1)!(stored)
    await flush()
    assert.deepEqual(chosen(), ['obsidian-black'])
    restore()
  } finally { await view.unmount(); stop(); native(); applyContrast('charcoal') }
})

test('a late native save response or rejection cannot replace a newer broadcast, and failed saves retain the current value', async () => {
  let event: (e: DesktopEvent) => void = () => {}, resolveSave: (p: NativePreferences) => void = () => {}, rejectSave: (e: Error) => void = () => {}
  native({ getPreferences:async () => prefs('light'), onEvent:fn => { event = fn; return () => {} },
    setPreferences:() => new Promise((resolve, reject) => { resolveSave = resolve; rejectSave = reject }) })
  const view = await mountView(<ContrastSetting />, el => el)
  try {
    await change(select(view.el), 'obsidian-black')
    assert.equal(select(view.el).disabled, true)
    await inAct(async () => { event({ type:'preferences', data:prefs('solarized-light') }); resolveSave(prefs('obsidian-black')); await flush() })
    assert.equal(select(view.el).value, 'solarized-light')
    assert.deepEqual(chosen(), ['solarized-light'])
    await change(select(view.el), 'obsidian-black')
    await inAct(async () => { rejectSave(Error('Disk unavailable')); await flush() })
    assert.equal(select(view.el).value, 'solarized-light')
    assert.match(view.el.querySelector('[role="alert"]')!.textContent!, /Disk unavailable/)
    await change(select(view.el), 'obsidian-black')
    await inAct(async () => { event({ type:'preferences', data:prefs('light') }); rejectSave(Error('Old failure')); await flush() })
    assert.equal(select(view.el).value, 'light')
    assert.equal(view.el.querySelector('[role="alert"]'), null)
    await change(select(view.el), 'obsidian-black')
    await view.unmount()
    await inAct(async () => { resolveSave(prefs('obsidian-black')); await flush() })
    assert.deepEqual(chosen(), ['light'], 'unmounted controls cannot apply a delayed save result')
  } finally { await view.unmount(); native(); applyContrast('charcoal') }
})

test('load errors are visible and recover on the next native broadcast; an absent old preference means Charcoal', async () => {
  let event: (e: DesktopEvent) => void = () => {}
  native({ getPreferences:async () => { throw Error('Cannot read preferences') }, onEvent:fn => { event = fn; return () => {} } })
  const view = await mountView(<ContrastSetting />, el => el)
  try {
    assert.match(view.el.querySelector('[role="alert"]')!.textContent!, /Could not load contrast color: Cannot read preferences/)
    assert.equal(select(view.el).disabled, true)
    await inAct(async () => { event({ type:'preferences', data:{ visualTheme:'claude' } }) })
    assert.equal(select(view.el).value, 'charcoal')
    assert.equal(select(view.el).disabled, false)
    assert.equal(view.el.querySelector('[role="alert"]'), null)
  } finally { await view.unmount(); native() }
})

test('all four CSS palettes have distinct lightness, readable core text and native control color schemes without changing accent', () => {
  const css = readFileSync(path.join(__SRC_DIR__, 'styles.css'), 'utf8')
  const style = document.createElement('style')
  // Use the actual root palettes; the remainder of the sheet is component layout.
  style.textContent = css.slice(0, css.indexOf('* { box-sizing: border-box; }'))
  document.head.appendChild(style)
  const luminance = (hex: string) => {
    assert.match(hex, /^#[0-9a-f]{6}$/i)
    const [r,g,b] = [1,3,5].map(i => { const s = parseInt(hex.slice(i, i+2), 16)/255; return s <= .04045 ? s/12.92 : ((s+.055)/1.055)**2.4 })
    return r!*.2126 + g!*.7152 + b!*.0722
  }
  const ratio = (a: string, b: string) => { const x = luminance(a), y = luminance(b); return (Math.max(x,y)+.05)/(Math.min(x,y)+.05) }
  const backgrounds: number[] = []
  applyTheme('codex')
  try {
    for (const id of CONTRAST_THEMES) {
      applyContrast(id)
      const computed = getComputedStyle(document.documentElement), token = (name: string) => computed.getPropertyValue(name).trim()
      const light = id === 'light' || id === 'solarized-light'
      assert.equal(computed.colorScheme, light ? 'light' : 'dark')
      backgrounds.push(luminance(token('--bg')))
      for (const surface of ['--bg', '--side', '--panel', '--panel-2', '--input']) {
        for (const ink of ['--ink', '--ink-strong', '--dim']) assert.ok(ratio(token(ink), token(surface)) >= 4.5, `${id}: ${ink} on ${surface}`)
        if (light) for (const ink of ['--ok', '--bad', '--warn', '--work', '--review', '--backlog', '--deploy-ready', '--ice']) {
          assert.ok(ratio(token(ink), token(surface)) >= 4.5, `${id}: ${ink} on ${surface}`)
        }
      }
      assert.equal(token('--accent'), '#22c4bd')
    }
    assert.equal(new Set(backgrounds).size, 4)
    assert.ok(backgrounds[3]! < backgrounds[0]! && backgrounds[0]! < backgrounds[2]! && backgrounds[2]! < backgrounds[1]!)
  } finally { style.remove(); applyContrast('charcoal') }
})
