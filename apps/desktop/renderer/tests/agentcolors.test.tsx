import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { AgentColorSetting, applyAgentColorSource, readableAgentAccent, startAgentColorSync } from '../src/agentcolors'
import { ThemeSetting, applyTheme, THEMES } from '../src/themes'
import { applyContrast } from '../src/contrast'
import { CONTRAST_THEMES } from '../../../../packages/contracts/contrast-theme'
import type { NativeDesktop, NativePreferences } from '../src/desktop'
import type { DesktopEvent } from '../../../../packages/contracts'

declare const __SRC_DIR__: string
const css = readFileSync(path.join(__SRC_DIR__, 'styles.css'), 'utf8')
const native = (value?: Partial<NativeDesktop>) => Object.defineProperty(window, 'orgtreeDesktop', { value, configurable:true })
const prefs = (agentColorSource: NativePreferences['agentColorSource'] = 'provider'): NativePreferences => ({
  agentColorSource, visualTheme:'custom:#8435cf', visualThemeExplicit:true, contrastTheme:'charcoal',
  startAtLogin:true, exitOnClose:false, automaticUpdates:true, routineNotifications:false, onboarded:true,
})
const toggle = (el: Element) => el.querySelector<HTMLInputElement>('[aria-label="organization theme color for agents"]')!
const override = () => document.documentElement.classList.contains('agent-colors-organization')
async function click(el: HTMLInputElement) { await inAct(async () => { el.click(); await flush() }) }
function stylesheet() { const style = document.createElement('style'); style.textContent = css; document.head.appendChild(style); return () => style.remove() }

test('Appearance exposes a compact provider/organization toggle, persists it, and leaves both existing selectors independent', async () => {
  native(); localStorage.clear(); localStorage.setItem('orgtree-visual-theme', 'custom:#8435cf')
  localStorage.setItem('orgtree-contrast-theme', 'solarized-light')
  const stop = startAgentColorSync(), view = await mountView(<ThemeSetting />, el => el)
  try {
    assert.equal(toggle(view.el).getAttribute('role'), 'switch')
    assert.equal(toggle(view.el).checked, false)
    assert.match(view.el.textContent!, /Provider colors/)
    await click(toggle(view.el))
    assert.equal(toggle(view.el).checked, true); assert.ok(override())
    assert.match(view.el.textContent!, /Organization theme color/)
    assert.equal(localStorage.getItem('orgtree-agent-colors'), 'organization')
    assert.equal(localStorage.getItem('orgtree-visual-theme'), 'custom:#8435cf')
    assert.equal(localStorage.getItem('orgtree-contrast-theme'), 'solarized-light')
    await view.unmount(); stop(); applyAgentColorSource('provider')
    const restarted = startAgentColorSync()
    assert.ok(override(), 'restart restores the override before settings are opened')
    restarted()
  } finally { await view.unmount(); stop(); native(); localStorage.clear(); applyAgentColorSource('provider') }
})

test('native preference broadcasts beat stale loads, writes only the color source, and rejects obsolete save responses', async () => {
  const listeners = new Set<(e: DesktopEvent) => void>(), reads: Array<(p: NativePreferences) => void> = [], writes: unknown[] = []
  let finish: (p: NativePreferences) => void = () => {}, reject: (e: Error) => void = () => {}
  const broadcast = (source: NativePreferences['agentColorSource']) => { for (const f of listeners) f({type:'preferences',data:prefs(source)}) }
  native({getPreferences:() => new Promise(resolve => reads.push(resolve)), onEvent:fn => { listeners.add(fn); return () => { listeners.delete(fn) } },
    setPreferences:patch => { writes.push(patch); return new Promise((resolve, fail) => { finish=resolve; reject=fail }) }})
  const stop = startAgentColorSync(), view = await mountView(<AgentColorSetting />, el => el)
  try {
    assert.equal(toggle(view.el).disabled, true)
    await inAct(async () => { broadcast('organization'); reads.forEach(resolve => resolve(prefs('provider'))); await flush() })
    assert.ok(override()); assert.equal(toggle(view.el).checked, true)
    await click(toggle(view.el))
    assert.equal(toggle(view.el).disabled, true)
    assert.deepEqual(writes, [{agentColorSource:'provider'}])
    await inAct(async () => { broadcast('organization'); finish(prefs('provider')); await flush() })
    assert.ok(override()); assert.equal(toggle(view.el).checked, true)
    await click(toggle(view.el))
    await inAct(async () => { reject(Error('Disk unavailable')); await flush() })
    assert.ok(override()); assert.match(view.el.querySelector('[role=alert]')!.textContent!, /Disk unavailable/)
    await click(toggle(view.el))
    await inAct(async () => { broadcast('provider'); reject(Error('Obsolete failure')); await flush() })
    assert.equal(override(), false); assert.equal(view.el.querySelector('[role=alert]'), null)
    await click(toggle(view.el)); await view.unmount(); stop()
    await inAct(async () => { finish(prefs('organization')); await flush() })
    assert.equal(override(), false, 'a response arriving after unmount cannot recolor the app')
    assert.equal(listeners.size, 0)
  } finally { await view.unmount(); stop(); native(); applyAgentColorSource('provider') }
})

test('browser windows and multiple controls synchronize, reset to providers, and keep the prior choice on storage failure', async () => {
  native(); localStorage.clear()
  const view = await mountView(<><AgentColorSetting /><AgentColorSetting /></>, el => el)
  const controls = [...view.el.querySelectorAll<HTMLInputElement>('input')], setItem = window.Storage.prototype.setItem
  try {
    await click(controls[0]!)
    assert.deepEqual(controls.map(c => c.checked), [true,true])
    window.Storage.prototype.setItem = () => { throw Error('Storage unavailable') }
    await click(controls[0]!)
    assert.ok(override()); assert.match(view.el.querySelector('[role=alert]')!.textContent!, /Storage unavailable/)
    window.Storage.prototype.setItem = setItem
    await inAct(async () => { localStorage.clear(); window.dispatchEvent(new window.StorageEvent('storage', {key:null})) })
    assert.equal(override(), false); assert.deepEqual(controls.map(c => c.checked), [false,false])
    await inAct(async () => {
      localStorage.setItem('orgtree-agent-colors', 'organization')
      window.dispatchEvent(new window.StorageEvent('storage', {key:'orgtree-agent-colors',newValue:'organization'}))
    })
    assert.ok(override()); assert.deepEqual(controls.map(c => c.checked), [true,true])
    await inAct(async () => {
      localStorage.setItem('orgtree-agent-colors', 'invalid')
      window.dispatchEvent(new window.StorageEvent('storage', {key:'orgtree-agent-colors',newValue:'invalid'}))
    })
    assert.equal(override(), false)
  } finally { window.Storage.prototype.setItem = setItem; await view.unmount(); localStorage.clear(); applyAgentColorSource('provider') }
})

test('native load failure is visible and a legacy preference broadcast recovers the original provider mode', async () => {
  let event: (e: DesktopEvent) => void = () => {}
  native({getPreferences:async () => { throw Error('Read failed') }, onEvent:fn => { event=fn; return () => {} }})
  const view = await mountView(<AgentColorSetting />, el => el)
  try {
    assert.equal(toggle(view.el).disabled, true)
    assert.match(view.el.querySelector('[role=alert]')!.textContent!, /Could not load agent colors: Read failed/)
    await inAct(async () => { event({type:'preferences',data:{visualTheme:'claude'}}) })
    assert.equal(toggle(view.el).disabled, false); assert.equal(toggle(view.el).checked, false)
    assert.equal(view.el.querySelector('[role=alert]'), null)
  } finally { await view.unmount(); native() }
})

// jsdom exposes the real winning CSS custom-property declarations but leaves
// var() in computed colors. Resolve only those references, with a cycle guard;
// selectors, specificity, inheritance and !important still come from its CSSOM.
function token(el: Element, name: string, depth = 0): string {
  assert.ok(depth < 12, `cyclic color variable ${name}`)
  const value = window.getComputedStyle(el).getPropertyValue(name).trim()
  const reference = /^var\((--[\w-]+)\)$/.exec(value)
  return reference ? token(el, reference[1]!, depth+1) : value
}
test('organization mode reaches all provider-scoped agent surfaces, nested destinations and inline account shades without touching status or tier identity', () => {
  native(); localStorage.clear(); applyTheme('custom:#8435cf'); applyContrast('charcoal')
  const removeCss = stylesheet(), host = document.createElement('div')
  const families = ['claude','openai','google','openrouter']
  const surfaces = ['sq','desk-body','pinwin','pin-snap-preview','tray-row','edge-jump','desk-nav-chip','proc-state active','cc-spin','eye-count','tab-count','badge']
  host.innerHTML = families.map(p => surfaces.map(cls => `<div class="${cls} prov-${p}"></div>`).join('')).join('')
    + '<div class="sq prov-openai" style="--provider-accent:#123456"><div class="desk-body prov-openai"><a class="desk-nav-chip prov-claude">destination</a><div class="md"><a href="#test">transcript link</a></div><span class="statuschip working">Working</span><span class="tier t-luna">Luna</span><div class="mailbtn"><b class="count prov-openai">3</b></div></div></div>'
    + '<div class="acct-provider-head prov-openai">Provider settings</div>'
  document.body.appendChild(host)
  const agent = host.querySelector<HTMLElement>('[style]')!, scopeElements = [...host.querySelectorAll('[class*="prov-"]')].filter(el => !el.classList.contains('acct-provider-head'))
  const control = host.querySelector('.acct-provider-head')!, status = host.querySelector('.statuschip')!, tier = host.querySelector('.tier')!
  try {
    applyAgentColorSource('provider')
    const original = scopeElements.map(el => token(el, '--provider-accent'))
    assert.equal(token(agent, '--provider-accent'), '#123456')
    const originalStatus = window.getComputedStyle(status).color, originalTier = window.getComputedStyle(tier).color
    applyAgentColorSource('organization')
    for (const el of scopeElements) {
      assert.equal(token(el, '--accent'), '#8435cf', el.className.toString())
      assert.equal(token(el, '--provider-accent'), '#8435cf', el.className.toString())
    }
    assert.equal(token(control, '--prov-openai'), '#22c4bd', 'provider management stays on its own identity color')
    assert.equal(window.getComputedStyle(status).color, originalStatus)
    assert.equal(window.getComputedStyle(tier).color, originalTier)
    assert.match(window.getComputedStyle(host.querySelector('.md a')!).color, /--agent-accent-text/)
    assert.match(window.getComputedStyle(host.querySelector('.cc-spin')!).color, /--prov-/)
    applyTheme('codex')
    for (const el of scopeElements) assert.equal(token(el, '--accent'), THEMES.codex.accent)
    applyAgentColorSource('provider')
    assert.deepEqual(scopeElements.map(el => token(el, '--provider-accent')), original, 'switching back restores every original provider/account color')
    assert.equal(document.documentElement.style.getPropertyValue('--org-agent-text'), '')
  } finally { host.remove(); removeCss(); applyAgentColorSource('provider') }
})

test('theme and contrast changes keep organization accent text and filled labels readable across all four contrast modes', () => {
  native(); localStorage.clear(); localStorage.setItem('orgtree-agent-colors', 'organization')
  const removeCss = stylesheet(), stop = startAgentColorSync()
  const luminance = (hex: string) => [1,3,5].map(i => parseInt(hex.slice(i,i+2),16)/255).map(n => n <= .04045 ? n/12.92 : ((n+.055)/1.055)**2.4).reduce((s,n,i) => s+n*[.2126,.7152,.0722][i]!,0)
  const ratio = (a: string,b: string) => (Math.max(luminance(a),luminance(b))+.05)/(Math.min(luminance(a),luminance(b))+.05)
  const tint = (a: string, bg: string, weight: number) => '#' + [1,3,5].map(i =>
    Math.round(parseInt(a.slice(i,i+2),16)*weight + parseInt(bg.slice(i,i+2),16)*(1-weight)).toString(16).padStart(2,'0')).join('')
  try {
    for (const contrast of CONTRAST_THEMES) {
      applyContrast(contrast)
      const statuses = ['--ok','--bad','--work','--warn'].map(name => token(document.documentElement, name))
      for (const theme of [...Object.keys(THEMES), 'custom:#000000', 'custom:#ffffff', 'custom:#8435cf']) {
        applyTheme(theme)
        const value = (name: string) => token(document.documentElement, name)
        const accent = value('--org-accent'), text = value('--org-agent-text'), ink = value('--org-agent-ink')
        assert.equal(accent, value('--accent'), 'activity marks keep the exact selected accent')
        const surfaces = ['--bg','--side','--panel','--panel-2','--input'].map(value)
        const textSurfaces = [...surfaces, ...surfaces.map(bg => tint(accent,bg,.21))]
        assert.deepEqual({text,ink}, readableAgentAccent(accent,textSurfaces))
        for (const bg of textSurfaces) assert.ok(ratio(text,bg) >= 4.5, `${contrast}/${theme}: text on ${bg}`)
        assert.ok(ratio(ink,accent) >= 4.5, `${contrast}/${theme}: label on filled accent`)
        assert.ok(ratio(value('--org-agent-count-ink'), tint(accent,value('--panel-2'),.42)) >= 4.5,
          `${contrast}/${theme}: unread count on its tinted badge`)
        assert.deepEqual(['--ok','--bad','--work','--warn'].map(value), statuses)
      }
    }
  } finally { stop(); removeCss(); localStorage.clear(); applyAgentColorSource('provider'); applyContrast('charcoal') }
})
