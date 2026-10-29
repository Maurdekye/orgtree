import { flush, inAct, mountView as rawMountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import type { ReactNode } from 'react'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { PinFrame, forgetModalPins, forgetModalOpenCache } from '../src/canvas/modalpin'
import { CurrentOrg } from '../src/popout'
import { DeskHead, DeskTitleBar } from '../src/canvas/deskshell'
import { AppsButton, AppsWorkspace } from '../src/canvas/apps/ui'
import type { CustomApp, CustomPanel } from '../src/canvas/apps/types'

// USER 2026-10-29 m6c5594110094 (close-x-button-on-every-closable-panel-rightmost): every panel that can be closed
// gets an X in the same row as its pin / pop-out buttons, to their right, last in the row, doing the panel's own
// close. Coordinator m36dbf634e56e: the shared frame's X is always there, "Close (Esc)" while centred and "Close"
// once pinned (a pinned window ignores Escape); a custom-app panel keeps its hide X, retitled "Close (Esc)" over
// "the panel keeps running"; a popped-out window's own × is its X. The user answered the open two (me188f67b3944):
// a CENTRED desk has the X too ("Yes, add the X"); the in-canvas desk header has none ("No X there").

/** a frame inside an organization, as the canvas mounts one (pin and pop-out need an org scope) */
async function mountView<T>(node: ReactNode, select: (el: HTMLElement) => T) {
  const canvases = ['probe'].map(org => {
    const el = document.createElement('div'); el.dataset.pinOrg = org
    el.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, width: window.innerWidth, height: window.innerHeight,
      right: window.innerWidth, bottom: window.innerHeight, toJSON() {} })
    document.body.appendChild(el); return el
  })
  const v = await rawMountView(<CurrentOrg.Provider value="probe">{node}</CurrentOrg.Provider>, select)
  const unmount = v.unmount
  v.unmount = async () => { await unmount(); canvases.forEach(el => el.remove()) }
  return v
}
const reset = () => { localStorage.clear(); forgetModalPins(); forgetModalOpenCache() }
const bar = () => document.querySelector<HTMLElement>('.modalpin-bar')
/** the bar's own buttons, in order, without the popped-out window controls */
const barButtons = () => [...(bar()?.querySelectorAll<HTMLButtonElement>('button') ?? [])].filter(b => !b.closest('.popout-window-controls'))
const xOf = (buttons: HTMLButtonElement[]) => buttons.find(b => b.classList.contains('modalpin-x')) ?? null

function frame(closes: { n: number }, props: Record<string, unknown> = {}) {
  return (
    <PinFrame kind="usage" title="usage limits" panel="settings usage-modal" close={() => { closes.n += 1 }} {...props}>
      <h3>usage limits</h3>
    </PinFrame>
  )
}

test('§1 a centred panel ends its pin / pop-out row with the X, which closes it', async t => {
  reset(); t.after(reset)
  const closes = { n: 0 }
  const v = await mountView(frame(closes), el => el); t.after(() => v.unmount())
  await flush()
  const buttons = barButtons()
  const pin = buttons.find(b => b.getAttribute('aria-label') === 'pin this to the window')
  assert.ok(pin, 'the centred panel has its pin')
  assert.ok(bar()?.querySelector('button.popout-button'), 'and its pop-out')
  const x = xOf(buttons)
  assert.ok(x, 'a centred panel has an X in the same row')
  assert.equal(buttons.at(-1), x, 'the X is the last button of the row, to the right of pin and pop-out')
  assert.ok(buttons.indexOf(pin) < buttons.indexOf(x), 'right of the pin')
  assert.equal(x.classList.contains('modalpin-btn'), true, 'the same button as the pin')
  assert.equal(x.title, 'Close (Esc)', 'Escape closes a centred panel, so its hint is in the tooltip')
  assert.ok(x.getAttribute('aria-label'), 'an accessible name')
  assert.equal(x.querySelector('svg')?.getAttribute('data-testid'), 'CloseIcon', 'an X')
  await inAct(() => { x.click() }); await flush()
  assert.equal(closes.n, 1, "the X runs the panel's own close")
})

test('§2 a pinned panel keeps the X last; its tooltip drops the Escape hint, which a pinned window ignores', async t => {
  reset(); t.after(reset)
  const closes = { n: 0 }
  const v = await mountView(frame(closes), el => el); t.after(() => v.unmount())
  await flush()
  const pin = barButtons().find(b => b.getAttribute('aria-label') === 'pin this to the window')!
  await inAct(() => { pin.click() }); await flush()
  const buttons = barButtons()
  const x = xOf(buttons)
  assert.ok(x, 'the pinned window has its X')
  assert.equal(buttons.at(-1), x, 'last in the row')
  assert.equal(x.title, 'Close', 'no Escape hint once pinned')
  await inAct(() => { x.click() }); await flush()
  assert.equal(closes.n, 1)
})

test('§3 a panel that cannot be pinned still has the X in its title row', async t => {
  reset(); t.after(reset)
  const closes = { n: 0 }
  const v = await mountView(frame(closes, { pinnable: false }), el => el); t.after(() => v.unmount())
  await flush()
  const buttons = barButtons()
  const x = xOf(buttons)
  assert.ok(x, 'an X even without pin and pop-out')
  assert.equal(buttons.at(-1), x)
  assert.equal(x.title, 'Close (Esc)')
  await inAct(() => { x.click() }); await flush()
  assert.equal(closes.n, 1)
})

test('§4 a centred desk ends its row with the X too (USER me188f67b3944 "Yes, add the X")', async t => {
  reset(); t.after(reset)
  const closes = { n: 0 }
  const v = await mountView(frame(closes, { kind: 'project-desk', deskTitle: true }), el => el); t.after(() => v.unmount())
  await flush()
  const x = xOf(barButtons())
  assert.ok(x, 'the centred desk has the X')
  assert.equal(barButtons().at(-1), x, 'last in its title row')
  assert.equal(x.title, 'Close (Esc)', 'Escape still closes it')
  await inAct(() => { x.click() }); await flush()
  assert.equal(closes.n, 1, "the desk modal's own close")
})

test('§5 CONTROL the in-canvas desk header has no X (USER me188f67b3944 "No X there")', async t => {
  const v = await rawMountView(<DeskHead nodeId="ada" left={<b>ada</b>} tabs={null}
    pin={{ ariaLabel: "pin ada's desk as a window", onPin: () => {} }} settings={{ label: 'ada' }} />, el => el)
  t.after(() => v.unmount())
  const right = [...v.el.querySelectorAll<HTMLButtonElement>('.cc-head-right button')]
  assert.deepEqual(right.map(b => b.getAttribute('aria-label')), ["pin ada's desk as a window", 'settings for ada'],
    'pin and settings, and no close')
  assert.equal(v.el.querySelector('.cc-head [data-testid="CloseIcon"]'), null, 'no X anywhere in the header')
})

test('§5b the temporary desk title bar ends with its X after the pin when given its close (tempdesk.tsx always gives it)', async t => {
  const closes = { n: 0 }
  const without = await rawMountView(<DeskTitleBar id="ada" tier="haiku" onPin={() => {}} />, el => el)
  assert.equal(without.el.querySelector('.tempdesk-close'), null, 'switch off: no X, Escape and the backdrop close it')
  await without.unmount()
  const v = await rawMountView(<DeskTitleBar id="ada" tier="haiku" onPin={() => {}} onClose={() => { closes.n += 1 }} />, el => el)
  t.after(() => v.unmount())
  const buttons = [...v.el.querySelectorAll<HTMLButtonElement>('.tempdesk-head button')]
  const x = v.el.querySelector<HTMLButtonElement>('.tempdesk-head button.tempdesk-close')
  assert.ok(x, 'given a close, the title bar has an X')
  assert.equal(buttons.at(-1), x, 'after the pin')
  assert.equal(x.classList.contains('pinwin-unpin'), true, 'the same button as the pin')
  assert.equal(x.title, 'Close (Esc)')
  await inAct(() => { x.click() })
  assert.equal(closes.n, 1)
})

// ---- the custom-app panel: its hide X, retitled ---------------------------------------------------------------
const tick = async () => { for (let i = 0; i < 5; i++) await flush() }
function appsFixture(t: test.TestContext) {
  const app: CustomApp = { id: 'timer', name: 'Timer', description: 'Background timer', rev: 1, permission_rev: 1, width: 360, height: 280,
    capabilities: [], permissions: {}, created_by: 'maker', updated_at: '',
    definition: { name: 'Timer', description: '', html: '<p>Timer runs</p>', initial_state: {}, capabilities: [], width: 360, height: 280 } }
  const panel = { id: 'clock', app: 'timer', label: 'Clock', rev: 1, open: true, running: true, run_generation: 1, state: {}, event_seq: 0,
    placement: { mode: 'float', x: 40, y: 40, width: 360, height: 280 }, linked_agents: [], used_at: '', updated_at: '' } as CustomPanel & { running: boolean; run_generation: number }
  const original = globalThis.fetch
  Object.defineProperty(document, 'hidden', { configurable: true, value: false })
  globalThis.fetch = async (raw, init) => {
    const url = new URL(String(raw), 'http://local')
    const input = init?.method === 'POST' ? JSON.parse(String(init.body)) : JSON.parse(url.searchParams.get('request') ?? '{}')
    let out: unknown
    if (input.action === 'list') out = { items: input.kind === 'apps' ? [app] : [panel].filter(p => (input.open === undefined || p.open === input.open)
      && (input.running === undefined || p.running === input.running)), next_cursor: null, new_count: 0 }
    else if (input.action === 'app_get') out = app
    else if (input.action === 'panel_get') out = panel
    else if (input.action === 'events') out = { events: [], next_cursor: null }
    else if (input.action === 'panel_update') { Object.assign(panel, input); panel.rev++; out = panel }
    else if (input.action === 'runtime') out = { items: [], next_cursor: null }
    else if (input.action === 'session_close') out = { closed: true }
    else out = {}
    return new Response(JSON.stringify(out), { headers: { 'Content-Type': 'application/json' } })
  }
  t.after(() => { globalThis.fetch = original; delete (document as unknown as Record<string, unknown>).hidden })
  return { app, panel }
}

test('§6 a custom-app panel keeps its hide X last, titled "Close (Esc)" over "the panel keeps running"', async t => {
  const f = appsFixture(t)
  const view = await rawMountView(<><AppsButton slug="closex-apps" /><AppsWorkspace slug="closex-apps" /></>, e => e)
  t.after(() => view.unmount())
  await inAct(tick)
  const hide = view.el.querySelector<HTMLButtonElement>('[aria-label="Hide Clock"]')
  assert.ok(hide, 'the panel header has its hide control')
  assert.equal([...hide.closest('header')!.querySelectorAll('button')].at(-1), hide, 'the X is the far-right header control')
  assert.equal(hide.title, 'Close (Esc)\nthe panel keeps running', 'the shared Close tooltip; the second line says what closing keeps')
  await inAct(async () => { hide.click(); await tick() })
  assert.equal(f.panel.open, false, 'it closes the window')
  assert.equal(f.panel.running, true, 'and the panel keeps running')
})

// ─── §7 the agent ⚙ panel's header row stays clear of the WHOLE frame row ────────────────────────────
// Centred, agent settings lays the frame's row over its header (position: absolute), and the header keeps its folder
// buttons clear with padding-right (user 2026-10-18 07:24Z). Measured in the Session 0 close-X capture at 1440x900:
// that row is 46px with pop-out and pin and 74px with the X, and the old 64px reserve left the row's pop-out over the
// "Open team scratch folder" button. The reserve keeps the 18px of clearance it always had: 74 + 18.
declare const __SRC_DIR__: string
test('§7 the agent settings header keeps its folder buttons clear of pop-out, pin and the X', () => {
  const css = readFileSync(path.join(__SRC_DIR__, 'styles.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
  const sel = '.settings.cfg:not(.modalpin-win):not(.modalpin-detached) > .agent-settings-header'
  const pads = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)]
    .filter((m) => m[1]!.split(',').some((s) => s.trim() === sel))
    .map((m) => /(?:^|;)\s*padding-right\s*:\s*([\d.]+)px/.exec(m[2]!)?.[1])
    .filter((v): v is string => !!v)
  assert.ok(pads.length > 0, 'the header reserves room for the row')
  assert.ok(Number(pads.at(-1)) >= 92, `padding-right ${pads.at(-1)}px leaves the 74px row its 18px of clearance`)
})
