import { flush, inAct, mountView as rawMountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { useState, type ReactNode } from 'react'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { PinFrame, forgetModalPins, forgetModalOpenCache, isModalPinned, pinModal } from '../src/canvas/modalpin'
import { CurrentOrg } from '../src/popout'
import { DeskHead, DeskTitleBar } from '../src/canvas/deskshell'
import { AppsButton, AppsWorkspace } from '../src/canvas/apps/ui'
import type { CustomApp, CustomPanel } from '../src/canvas/apps/types'
import { AttentionView, DESK_KIND, QUEUE_KIND } from '../src/attention/AttentionView'
import { forgetAttentionMode, setOrgView } from '../src/attention/mode'
import { ProviderDialog } from '../src/canvas/providerdialog'
import { AddAccountDialog } from '../src/canvas/accountsregistry'
import { USER, type CanvasNode, type OpFn } from '../src/canvas/shared'
import type { TreePayload } from '../src/types'
import { compatibilityWorkFixture } from './workcompat.fixture'

// USER 2026-10-29 m6c5594110094 (close-x-button-on-every-closable-panel-rightmost): every panel that can be closed
// gets an X in the same row as its pin / pop-out buttons, to their right, last in the row, doing the panel's own
// close. Coordinator m36dbf634e56e: the shared frame's X is always there, "Close (Esc)" while centred and "Close"
// once pinned (a pinned window ignores Escape); a custom-app panel keeps its hide X, retitled "Close (Esc)" over
// "the panel keeps running"; a popped-out window's own × is its X. The user answered the open two (me188f67b3944):
// a CENTRED desk has the X too ("Yes, add the X"); the in-canvas desk header has none ("No X there").
// USER 2026-10-30 (m46997f801a3f, m743d0c8ff8fe, m680431a91e2f "they dont do anything anyway"), coordinator
// mbfcad188f152: an X shows only where it actually closes something (§8-§12); USER 2026-10-30 ma605876f7306 ("Grey out
// the X"): in the two busy dialogs, the X stays visible and disabled while saving/adding, matching their disabled Cancel.

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

// ─── §8-§12 AN X ONLY WHERE IT CLOSES SOMETHING ────────────────────────────────────────────────────────────────
// USER 2026-10-30 08:44Z, on 4.5.2-alpha.3: "the dynamic agent panel should not have this x when not pinned or popped
// out" (m46997f801a3f), "same for the needs attention list panel" (m743d0c8ff8fe), "they dont do anything anyway"
// (m680431a91e2f). Coordinator mbfcad188f152: remove every X that does nothing. Each section opens its surface, clicks
// the X wherever one shows and asserts what closed; where closing would do nothing there is no X, and no Close in the
// bar's menu either, which names the bar's own controls.
const W = window as unknown as Window & typeof globalThis
const menuLabels = () => [...document.querySelectorAll('.ctxmenu [role="menuitem"]')].map(b => b.textContent ?? '')
async function barMenu(el: Element) {
  if (document.querySelector('.ctxmenu')) {
    await inAct(() => { document.body.dispatchEvent(new W.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })) })
    await flush(2)
  }
  await inAct(() => { el.dispatchEvent(new W.MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: 40, clientY: 30 })) })
  await flush(3)
  return menuLabels()
}

// the Attention view (attentionview.test.tsx's empty organization): its stage, both panels and their frames
const SLUG = 'probe'
const attentionTree = () => ({ slug: SLUG, name: 'Probe', epoch: 1, rev: 1, roots: [], work_items_summary: { attention: 0, active: 0 },
  user_inbox_count: 0, user_inbox_urgent_count: 0, asks: [], asks_open: 0 } as unknown as TreePayload)
const attentionMap = () => new Map([[USER, { id: USER, parent: null, tier: null, state: 'user', children: [] } as unknown as CanvasNode]])
async function mountAttention(t: test.TestContext) {
  reset(); forgetAttentionMode()
  const original = globalThis.fetch
  globalThis.fetch = compatibilityWorkFixture((url: RequestInfo | URL) => {
    const at = new URL(String(url), 'http://localhost').pathname
    const body = /\/work-items(?:-view)?$/.test(at)
      ? { items: [], archived: [], backlogged: [], counts: { attention: 0, active: 0, archived: 0, backlogged: 0 } }
      : /\/inbox$/.test(at) ? { pending: [], delivered: [], sent: [] } : { ok: true }
    return Promise.resolve(new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } }))
  })
  setOrgView(SLUG, 'attention')
  const op = (() => Promise.resolve({ ok: true })) as unknown as OpFn
  const v = await mountView(<AttentionView slug={SLUG} tree={attentionTree()} op={op} toast={() => {}} map={attentionMap()}
    attentionDeskActiveAgentsOnly={false} />, el => el)
  t.after(async () => { await v.unmount(); globalThis.fetch = original; reset(); forgetAttentionMode() })
  await inAct(async () => { await flush(3) })
  return v
}
const attentionPanels = [['Needs attention', 'queue', QUEUE_KIND], ['Agent desk', 'desk', DESK_KIND]] as const
const panelBar = (which: string) => document.querySelector<HTMLElement>(`.attn-panel-${which} > .modalpin-bar`)
const rowOf = (el: HTMLElement | null) => [...(el?.querySelectorAll<HTMLButtonElement>('button') ?? [])].filter(b => !b.closest('.popout-window-controls'))
/** the X a person sees. In the two busy dialogs that cannot be pinned, the X stays visible and disabled while
 *  saving/adding, matching their disabled Cancel (USER 2026-10-30 ma605876f7306 "Grey out the X"; §10, §11). */
const shownX = (root: ParentNode | null) => [...(root?.querySelectorAll<HTMLButtonElement>('.modalpin-x') ?? [])]
  .find(x => x.style.visibility !== 'hidden') ?? null

test('§8 RED an Attention panel in its slot has no X: its close only unpins, so there the X did nothing', async t => {
  await mountAttention(t)
  for (const [name, which] of attentionPanels) {
    const bar = panelBar(which)
    assert.ok(bar, `the ${name} panel is in its slot with its bar`)
    assert.equal(bar.closest('.modalpin-win'), null, `${name}: not pinned`)
    assert.ok(rowOf(bar).some(b => b.getAttribute('aria-label') === 'pin this to the window'), `${name}: its pin is there`)
    assert.equal(xOf(rowOf(bar)), null, `${name}: no X in its slot (USER m46997f801a3f, m743d0c8ff8fe)`)
    const labels = await barMenu(bar)
    assert.ok(labels.includes('Pin to window'), `${name}: the bar menu opened, have ${JSON.stringify(labels)}`)
    assert.equal(labels.includes('Close'), false, `${name}: and no Close in the bar menu, have ${JSON.stringify(labels)}`)
  }
})

test('§9 pinned, an Attention panel has the X last, and it closes the window back into the slot', async t => {
  await mountAttention(t)
  for (const [name, which, kind] of attentionPanels) {
    await inAct(() => pinModal(kind, { x: 20, y: 20, w: 420, h: 480 }, SLUG)); await flush(3)
    const bar = panelBar(which)
    assert.ok(bar?.closest('.modalpin-win'), `${name}: pinned as a window`)
    const x = xOf(rowOf(bar))
    assert.ok(x, `${name}: pinned, it has the X`)
    assert.equal(rowOf(bar).at(-1), x, `${name}: last in the row`)
    await inAct(() => { x.click() }); await flush(3)
    assert.equal(isModalPinned(kind, SLUG), false, `${name}: the X closed the window`)
    const back = document.querySelector(`.attn-slot-${which} .attn-panel-${which}`)
    assert.ok(back && !back.classList.contains('modalpin-win'), `${name}: the panel is back in its slot`)
  }
})

test('§10 RED the provider dialog keeps its X visible and disabled while its save settles, matching Cancel', async t => {
  reset(); t.after(reset)
  const closes = { n: 0 }
  let setBusy: (busy: boolean) => void = () => {}
  function Host() {
    const [busy, set] = useState(true); setBusy = set
    return <ProviderDialog title="Configure Example" busy={busy} close={() => { closes.n += 1 }}><p>fields</p></ProviderDialog>
  }
  const v = await mountView(<Host />, el => el); t.after(() => v.unmount())
  await flush()
  const dialog = () => document.querySelector<HTMLElement>('.provider-dialog')
  assert.ok(dialog(), 'the dialog is open')
  const busyX = shownX(dialog())
  assert.ok(busyX, 'saving: the X stays visible (USER ma605876f7306 "Grey out the X")')
  assert.equal(busyX.disabled, true, 'saving: the X is disabled')
  assert.equal(busyX.getAttribute('aria-disabled'), 'true', 'saving: aria-disabled matches')
  await inAct(() => { busyX.click() }); await flush()
  assert.equal(closes.n, 0, 'saving: clicking the disabled X does not close the dialog')
  const css = readFileSync(path.join(__SRC_DIR__, 'styles.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
  assert.match(css, /button:disabled\s*\{[^}]*opacity:\s*\.45/, 'disabled X shares the greyed button:disabled style')
  assert.match(css, /\.modalpin-btn:not\(:disabled\):hover\s*\{/, 'hover does not light up a disabled modalpin-btn')
  assert.equal((await barMenu(dialog()!.querySelector('.modalpin-bar')!)).includes('Close'), false, 'saving: no Close in the bar menu')
  await inAct(() => setBusy(false)); await flush()
  const x = shownX(dialog())
  assert.ok(x, 'the save settled: the X is visible')
  assert.equal(x.disabled, false, 'the save settled: the X is enabled')
  assert.equal(x.getAttribute('aria-disabled'), 'false', 'the save settled: aria-disabled is false')
  await inAct(() => { x.click() }); await flush()
  assert.equal(closes.n, 1, 'and it closes the dialog')
})

test('§11 RED the add-account dialog keeps its X visible and disabled while it adds the account, matching Cancel', async t => {
  reset(); t.after(reset)
  const original = globalThis.fetch
  let answer: (r: Response) => void = () => {}
  globalThis.fetch = (() => new Promise<Response>(resolve => { answer = resolve })) as typeof fetch
  t.after(() => { globalThis.fetch = original })
  const closes = { n: 0 }
  const v = await mountView(<AddAccountDialog provider="openai" onAdded={async () => {}} close={() => { closes.n += 1 }} />, el => el)
  t.after(() => v.unmount())
  await flush()
  const dialog = () => document.querySelector<HTMLElement>('.add-account-dialog')!
  const idleX = shownX(dialog())
  assert.ok(idleX, 'idle: the X is there')
  assert.equal(idleX.disabled, false, 'idle: the X is enabled')
  assert.equal(idleX.getAttribute('aria-disabled'), 'false', 'idle: aria-disabled is false')
  const create = [...dialog().querySelectorAll('button')].find(b => b.textContent === 'Create managed account')
  assert.ok(create, 'the create control')
  await inAct(() => { create.click() }); await flush()
  const busyX = shownX(dialog())
  assert.ok(busyX, 'adding: the X stays visible (USER ma605876f7306 "Grey out the X")')
  assert.equal(busyX.disabled, true, 'adding: the X is disabled')
  assert.equal(busyX.getAttribute('aria-disabled'), 'true', 'adding: aria-disabled matches')
  await inAct(() => { busyX.click() }); await flush()
  assert.equal(closes.n, 0, 'adding: clicking the disabled X does not close the dialog')
  await inAct(async () => { answer(new Response(JSON.stringify({ detail: 'refused' }), { status: 422 })); await flush(3) })
  const x = shownX(dialog())
  assert.ok(x, 'the request settled: the X is visible')
  assert.equal(x.disabled, false, 'the request settled: the X is enabled')
  assert.equal(x.getAttribute('aria-disabled'), 'false', 'the request settled: aria-disabled is false')
  await inAct(() => { x.click() }); await flush()
  assert.equal(closes.n, 1, 'and it closes the dialog')
})

test('§12 CONTROL an inline panel whose close works in its place keeps its X there (the Agents list hides)', async t => {
  reset(); t.after(reset)
  const closes = { n: 0 }
  const v = await mountView(<PinFrame inline kind="agent-list" title="Agents" panel="tray-panel" dialogLabel="Agents"
    close={() => { closes.n += 1 }}><p>rows</p></PinFrame>, el => el)
  t.after(() => v.unmount())
  await flush()
  const bar = document.querySelector<HTMLElement>('.tray-panel > .modalpin-bar')
  assert.equal(bar?.closest('.modalpin-win') ?? null, null, 'in its place, not pinned')
  const x = xOf(rowOf(bar))
  assert.ok(x, 'its X is there')
  await inAct(() => { x.click() }); await flush()
  assert.equal(closes.n, 1, 'and it closes the list')
})
