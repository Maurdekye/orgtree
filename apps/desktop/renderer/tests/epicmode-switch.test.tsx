// EPIC Mode's secret switch (user 2026-10-14 23:42Z and 23:43Z).
//
// Mounts the REAL App settings panel on its Developer tab, with a native
// preference bridge standing in for the main process, and drives the rendered
// checkbox: where it sits (below every other Developer option), how it looks
// off and on, that clicking reveals it and unticking hides it again, and that
// the choice is a stored desktop preference that survives a remount. The main
// process's own preference validation is checked too.
//
// Absence checks compare booleans: a failing assertion handed a React-rendered
// element exhausts the reporter's memory (team notes, rig-opus 2026-10-14).

import { flush, inAct, mountView } from './harness'
import type { MountedView } from './harness'
import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { AccountsPanel } from '../src/canvas/accounts'
import type { NativePreferences } from '../src/desktop'
import { DEFAULT_PREFERENCES, preferencesPatch } from '../../main/policy'

declare const __SRC_DIR__: string

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
  subscriptions: () => number
}

/** a stand-in for the main process: stores patches and broadcasts the result
 *  to every subscriber, as main/index.ts setPreferences does */
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
  return { saved: () => saved, writes, subscriptions: () => listeners.size }
}

async function openDeveloper(t: TestContext): Promise<MountedView<HTMLElement>> {
  stubFetch()
  const view = await mountView(<AccountsPanel toast={() => {}} close={() => {}} initialTab="developer" />, el => el)
  await inAct(async () => { await flush(10) })
  t.after(async () => { await view.unmount(); delete g.fetch })
  return view
}

const panel = (el: HTMLElement) => el.querySelector<HTMLElement>('#app-settings-panel-developer')
const epicSwitch = (el: HTMLElement) => el.querySelector<HTMLInputElement>('[role="switch"][aria-label="EPIC Mode"]')
const row = (input: HTMLInputElement) => input.closest('.set-row') as HTMLElement

async function click(input: HTMLInputElement) {
  await inAct(async () => { input.click(); await flush(6) })
}

test('EPIC Mode is always rendered as the last option on the Developer tab', async t => {
  installBridge(t)
  const view = await openDeveloper(t)
  const dev = panel(view.el)
  assert.equal(dev !== null, true, 'the Developer tab panel is mounted')
  const input = epicSwitch(view.el)
  assert.equal(input !== null, true, 'the EPIC Mode switch is rendered while off')
  assert.equal(dev!.contains(input!), true, 'it lives on the Developer tab')
  const switches = [...dev!.querySelectorAll('input[type="checkbox"]')]
  assert.equal(switches.length >= 2, true, 'the ordinary Developer toggles rendered too')
  assert.equal(switches[switches.length - 1] === input, true, 'no Developer option comes after it')
  assert.equal(dev!.lastElementChild === row(input!), true, 'its row is the panel\'s last row')
  assert.equal(input!.getAttribute('type'), 'checkbox')
})

test('off: unchecked, unrevealed, with no hint, no state word and no hairline above it', async t => {
  const bridge = installBridge(t)
  const view = await openDeveloper(t)
  const input = epicSwitch(view.el)
  assert.equal(input !== null, true)
  assert.equal(input!.checked, false)
  const r = row(input!)
  assert.equal(r.classList.contains('epic-switch'), true)
  assert.equal(r.classList.contains('on'), false, 'not revealed while off')
  assert.equal(r.textContent, 'EPIC Mode', 'the row says only its name: no hint, no on/off word')
  assert.equal(r.previousElementSibling?.classList.contains('set-row') ?? false, false,
    'a .set-row right after another draws a hairline (.set-row + .set-row), which would give it away')
  assert.equal(bridge.writes.length, 0, 'showing the switch writes nothing')
  assert.equal(Object.hasOwn(bridge.saved(), 'epicMode'), false, 'an untouched install stores nothing')
})

test('the stylesheet draws the off switch in nothing but the background, hints on hover, and reveals it in the accent', () => {
  const css = readFileSync(path.join(__SRC_DIR__, 'epic', 'epic.css'), 'utf8')
  const rule = (selector: string): string => {
    const at = css.indexOf(selector + ' {')
    assert.equal(at >= 0, true, `missing rule ${selector}`)
    return css.slice(at, css.indexOf('}', at))
  }
  const box = rule('.settings .epic-switch:not(.on) .set-lead input[type="checkbox"]')
  for (const decl of ['appearance: none', 'background: transparent', 'border: 0', 'box-shadow: none', 'outline: none']) {
    assert.equal(box.includes(decl), true, `off checkbox: ${decl}`)
  }
  assert.equal(rule('.settings .epic-switch:not(.on) .epic-switch-label').includes('color: transparent'), true)
  assert.equal(css.includes('.settings .epic-switch:not(.on):hover,'), true, 'a hover highlight exists')
  assert.equal(rule('.settings .epic-switch:not(.on):has(input:focus-visible)').includes('background: var(--panel-2)'), true,
    'the highlight is the panel\'s own subtle hover surface')
  assert.equal(rule('.settings .epic-switch.on .epic-switch-label').includes('color: var(--accent)'), true,
    'revealed: the name in the theme accent')
  assert.equal(/\.epic-switch\.on[^{]*input[^{]*\{[^}]*appearance/.test(css), false,
    'on, the checkbox is the settings sheet\'s ordinary accent-coloured box again')
})

test('clicking checks it and reveals it; the choice is saved as a desktop preference', async t => {
  const bridge = installBridge(t)
  const view = await openDeveloper(t)
  const input = epicSwitch(view.el)!
  await click(input)
  const after = epicSwitch(view.el)!
  assert.equal(after.checked, true, 'the checkbox is checked')
  assert.equal(row(after).classList.contains('on'), true, 'revealed: the accent rule applies')
  assert.deepEqual(bridge.writes, [{ epicMode: true }])
  assert.equal(bridge.saved().epicMode, true)
})

test('unticking hides it again and saves that too', async t => {
  const bridge = installBridge(t, { epicMode: true })
  const view = await openDeveloper(t)
  const input = epicSwitch(view.el)!
  assert.equal(input.checked, true, 'a saved choice shows checked')
  assert.equal(row(input).classList.contains('on'), true)
  await click(input)
  const after = epicSwitch(view.el)!
  assert.equal(after.checked, false)
  assert.equal(row(after).classList.contains('on'), false, 'invisible again')
  assert.deepEqual(bridge.writes, [{ epicMode: false }])
  assert.equal(bridge.saved().epicMode, false)
})

test('the saved choice survives closing and reopening settings', async t => {
  const bridge = installBridge(t)
  const first = await openDeveloper(t)
  await click(epicSwitch(first.el)!)
  await first.unmount()
  assert.equal(bridge.saved().epicMode, true)
  const second = await openDeveloper(t)
  const input = epicSwitch(second.el)!
  assert.equal(input.checked, true, 'reopened settings show it on')
  assert.equal(row(input).classList.contains('on'), true)
  assert.equal(bridge.writes.length, 1, 'reading it back writes nothing')
})

test('another window turning it on updates this window\'s switch', async t => {
  const bridge = installBridge(t)
  const view = await openDeveloper(t)
  assert.equal(epicSwitch(view.el)!.checked, false)
  await inAct(async () => {
    await (native.orgtreeDesktop as { setPreferences: (p: unknown) => Promise<unknown> }).setPreferences({ epicMode: true })
    await flush(6)
  })
  assert.equal(epicSwitch(view.el)!.checked, true)
  assert.equal(bridge.saved().epicMode, true)
})

test('without the native bridge (a plain browser) the switch keeps its bit in localStorage', async t => {
  const previous = native.orgtreeDesktop
  delete native.orgtreeDesktop
  t.after(() => { native.orgtreeDesktop = previous; localStorage.removeItem('orgtree-epic-mode') })
  localStorage.removeItem('orgtree-epic-mode')
  const view = await openDeveloper(t)
  const input = epicSwitch(view.el)!
  assert.equal(input.checked, false)
  await click(input)
  assert.equal(localStorage.getItem('orgtree-epic-mode'), '1')
  assert.equal(epicSwitch(view.el)!.checked, true)
  await click(epicSwitch(view.el)!)
  assert.equal(localStorage.getItem('orgtree-epic-mode'), '0')
  assert.equal(epicSwitch(view.el)!.checked, false)
})

test('the main process stores epicMode only as a boolean, and nothing by default', () => {
  assert.deepEqual(preferencesPatch({ epicMode: true }), { epicMode: true })
  assert.deepEqual(preferencesPatch({ epicMode: false }), { epicMode: false })
  assert.throws(() => preferencesPatch({ epicMode: 'yes' }), /Invalid preference/)
  assert.throws(() => preferencesPatch({ epicMode: 1 }), /Invalid preference/)
  assert.equal(Object.hasOwn(DEFAULT_PREFERENCES, 'epicMode'), false, 'absent means off; no default is written')
})
