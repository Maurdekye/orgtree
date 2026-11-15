// tempdesk.test.tsx — the glance that rearranges nothing.
//
// The feature is "read another agent's desk without changing the workspace",
// so most of what matters is what does NOT happen: no focus change, no pin, no
// window, no second composer, and everything back where it was on dismissal.
// Those are the assertions here.
//
// §2 IS THE 4.6.1 RULE (USER 2026-11-15 mbf1f1ca2cfe9): a desk shows in every
// place at once, so the modal shows the agent's live desk AND the canvas keeps
// its own. What makes it the canonical desk rather than a divergent imitation
// is that the unsent draft is the agent's one draft, seen in both.
import './harness'
import { FakeServer, advance, flush, inAct, installFetch, mountView, realClock, useFakeClock } from './harness'
import { openBranchOf, surveyMenu } from './menuhelp'
import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { useState } from 'react'
import { JSDOM } from 'jsdom'
import { installBridge, removeBridge } from './shellbridge'
import { captureWindow, windowLayoutKey } from '../src/windowlayout'
import { resetConvos } from '../src/convo'
import { DeskHosts, DeskSlot } from '../src/canvas/deskhosts'
import { TempDeskModal } from '../src/canvas/tempdesk'
import { OrgCanvas } from '../src/canvas/OrgCanvas'
import { openSurfaces } from '../src/windowlife'
import { removePin, readPins, forgetPins, commitRect } from '../src/canvas/pins'
import type { CanvasNode, TreePayload } from '../src/canvas/shared'
import type { OpResult } from '../src/types'

const W = window as unknown as Window & typeof globalThis
const noop = () => {}
const op = () => Promise.resolve({} as OpResult)

const agent = (id: string): CanvasNode => ({
  id, tier: 'opus', state: 'live', generation: 0, parent: null, children: [],
  seat: 1, grant: 0, free: 0, scope: { tools: { mcp: [] }, add_dirs: [] },
} as unknown as CanvasNode)

const deskProps = (map: Map<string, CanvasNode>) => ({
  map, op, slug: 'org', toast: noop,
})

/** the canvas slot for an agent, plus the modal when `open` — the real shape:
 *  one ordinary destination, and a borrowing one that comes and goes */
function scene(node: CanvasNode, open: boolean, close = noop,
  canvasProps: Record<string, unknown> = {}) {
  const map = new Map([[node.id, node]])
  return (
    <DeskHosts map={map} slug="org">
      {open && <TempDeskModal node={node} close={close} desk={deskProps(map)} />}
      <div data-which="canvas">
        <DeskSlot node={node} map={map} op={op} slug="org" toast={noop}
          bare {...canvasProps} />
      </div>
    </DeskHosts>
  )
}

const canvasBox = (el: HTMLElement) =>
  el.querySelector('[data-which="canvas"]') as HTMLElement
const modal = () => document.querySelector('.tempdesk-panel') as HTMLElement | null
// the shared frame's backdrop (user 2026-11-13: the temporary desk is on PinFrame)
const backdrop = () => (modal()?.parentElement?.classList.contains('overlay') ? modal()!.parentElement : null) as HTMLElement | null
const canvasComposer = (el: HTMLElement) => canvasBox(el).querySelector('textarea') as HTMLTextAreaElement | null
const modalComposer = () => modal()?.querySelector('textarea') as HTMLTextAreaElement | null
async function type(area: HTMLTextAreaElement, value: string) {
  await inAct(() => {
    Object.getOwnPropertyDescriptor(W.HTMLTextAreaElement.prototype, 'value')!.set!.call(area, value)
    area.dispatchEvent(new W.Event('input', { bubbles: true }))
  })
  await flush()
}

const setup = () => { resetConvos(); installFetch(new FakeServer()) }

// The temporary desk had no close control from 2026-10-19 (9238df5) until USER 2026-10-29 m6c5594110094 gave
// every closable panel an X and me188f67b3944 ("Yes, add the X") extended it to centred desks: the X ends the
// title bar, and Escape and the backdrop still dismiss the desk.
test('temporary desks end their title bar with an X, and Escape still dismisses them', async (t) => {
  setup()
  const n = agent('dismissal')
  let closed = 0
  const view = await mountView(scene(n, true, () => { closed++ }), (el) => el)
  t.after(() => view.unmount())
  await flush()
  const x = document.querySelector<HTMLButtonElement>('.tempdesk-panel > .modalpin-bar .modalpin-x')
  assert.ok(x, 'the title bar has the X')
  assert.ok([...document.querySelectorAll('.tempdesk-panel > .modalpin-bar button')].at(-1) === x, 'the X is last in its row')
  assert.equal(x!.title, 'Close (Esc)')
  const event = new W.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
  await inAct(() => { document.dispatchEvent(event) })
  assert.equal(closed, 1, 'Escape still dismisses the temporary desk')
  await inAct(() => { x!.click() })
  assert.equal(closed, 2, 'and so does its X')
})

test('Tab stays in the temporary Desk, respects nested dialogs, and releases on close', async (t) => {
  setup()
  const n = agent('keyboard')
  const view = await mountView(scene(n, true), (el) => el)
  t.after(() => view.unmount())
  await flush()
  const box = modal()!
  const firstControl = box.querySelector<HTMLButtonElement>('button')!
  const tab = async (shiftKey = false) => {
    const event = new W.KeyboardEvent('keydown', {key:'Tab', shiftKey, bubbles:true, cancelable:true})
    await inAct(() => { (document.activeElement ?? document.body).dispatchEvent(event) })
    return event.defaultPrevented
  }
  const last = document.createElement('button')
  last.textContent = 'last control'
  box.appendChild(last)
  const hidden = document.createElement('div')
  hidden.style.display = 'none'
  hidden.innerHTML = '<button>hidden control</button>'
  const disabled = document.createElement('button')
  disabled.disabled = true
  box.append(hidden, disabled)
  last.focus()
  assert.equal(await tab(), true, 'Tab is contained instead of leaving the modal')
  assert.equal(document.activeElement, firstControl, 'last control wraps to first')
  assert.equal(await tab(true), true)
  assert.equal(document.activeElement, last, 'Shift+Tab wraps back')
  last.remove()
  assert.equal(await tab(), true, 'a removed active control still returns focus inside')
  assert.equal(document.activeElement, firstControl)
  const consumed = (event: KeyboardEvent) => event.preventDefault()
  firstControl.addEventListener('keydown', consumed)
  assert.equal(await tab(), true)
  assert.equal(document.activeElement, firstControl, 'a Desk control can consume Tab before the trap')
  firstControl.removeEventListener('keydown', consumed)

  const nested = document.createElement('div')
  nested.setAttribute('role','dialog'); nested.setAttribute('aria-modal','true')
  const nestedButton = document.createElement('button')
  nested.appendChild(nestedButton); document.body.appendChild(nested)
  nestedButton.focus()
  assert.equal(await tab(), false, 'a nested modal keeps control of its own focus')
  assert.equal(document.activeElement, nestedButton)
  nested.remove()
  await view.render(scene(n, false)); await flush()
  assert.equal(await tab(), false, 'unmount removes the focus trap')
})

test('dismissal restores an adopted opener and preserves focus claimed by another action', async (t) => {
  setup()
  const frame = document.createElement('iframe')
  document.body.appendChild(frame)
  const opener = frame.contentDocument!.createElement('button')
  document.body.appendChild(document.adoptNode(opener))
  assert.equal(opener instanceof HTMLElement, false, 'the opener retains its other document realm')
  const elsewhere = document.createElement('button')
  document.body.appendChild(elsewhere)
  const n = agent('foreign-opener')
  const view = await mountView(scene(n, false), (el) => el)
  t.after(async () => { await view.unmount(); opener.remove(); elsewhere.remove(); frame.remove() })
  opener.focus()
  await view.render(scene(n, true)); await flush()
  await view.render(scene(n, false)); await flush()
  assert.equal(document.activeElement, opener, 'closing returns focus regardless of the opener constructor realm')
  await view.render(scene(n, true)); await flush()
  elsewhere.focus()
  await view.render(scene(n, false)); await flush()
  assert.equal(document.activeElement, elsewhere, 'an explicit action owns focus when it moved outside the closing modal')
})

test('§1 it is a real modal dialog, named for the agent it is showing',
  async (t: TestContext) => {
    setup()
    const n = agent('alpha')
    const view = await mountView(scene(n, true), (el) => el)
    t.after(() => view.unmount())
    await flush()
    const m = modal()
    assert.ok(m, 'the modal did not render')
    assert.equal(m!.getAttribute('role'), 'dialog')
    assert.equal(m!.getAttribute('aria-modal'), 'true')
    assert.match(m!.getAttribute('aria-label') ?? '', /alpha/,
      'a screen reader is not told whose desk this is')
  })

test('§2 the modal shows the agent\'s live desk and the canvas keeps its own',
  async (t: TestContext) => {
    setup()
    const n = agent('beta')
    const view = await mountView(scene(n, false), (el) => el)
    t.after(() => view.unmount())
    await flush()
    const canvas = canvasComposer(view.el)
    assert.ok(canvas, 'control: the canvas shows the desk')
    await view.render(scene(n, true))
    await flush()
    assert.ok(modal(), 'the modal did not open')
    assert.ok(modalComposer(), 'the modal shows a live desk')
    assert.equal(canvasComposer(view.el) === canvas, true, 'the canvas kept its own desk while the modal was open')
    assert.doesNotMatch(document.body.textContent ?? '', /desk is open elsewhere/, 'no place shows the old notice')
    await view.render(scene(n, false))
    await flush()
    assert.equal(modal(), null, 'the modal did not close')
    assert.equal(canvasComposer(view.el) === canvas, true, 'closing the modal left the canvas desk alone')
  })

test('§2b canvas re-renders under the modal disturb neither desk',
  async (t: TestContext) => {
    setup()
    const n = agent('eta')
    const view = await mountView(scene(n, true), (el) => el)
    t.after(() => view.unmount())
    await flush()
    const inModal = modalComposer(), canvas = canvasComposer(view.el)
    assert.ok(inModal && canvas)
    for (const compactAt of [0.4, 0.5, 0.6]) {
      await view.render(scene(n, true, noop, { compactAt }))
      await flush()
      assert.equal(modalComposer() === inModal, true, `the modal's desk was remounted (compactAt ${compactAt})`)
      assert.equal(canvasComposer(view.el) === canvas, true, `the canvas desk was remounted (compactAt ${compactAt})`)
    }
  })

test('§2c the draft is the agent\'s one draft: typed on the canvas, it is in the modal, and back',
  async (t: TestContext) => {
    setup()
    const n = agent('theta')
    const view = await mountView(scene(n, false), (el) => el)
    t.after(() => view.unmount())
    await flush()
    await type(canvasComposer(view.el)!, 'half a sentence')
    await view.render(scene(n, true))
    await flush()
    assert.equal(modalComposer()!.value, 'half a sentence', 'the modal shows the draft typed on the canvas')
    await type(modalComposer()!, 'half a sentence, finished in the modal')
    assert.equal(canvasComposer(view.el)!.value, 'half a sentence, finished in the modal', 'the canvas shows it live')
    await view.render(scene(n, false))
    await flush()
    assert.equal(canvasComposer(view.el)!.value, 'half a sentence, finished in the modal', 'the draft survived the modal')
  })

test('§3 Escape dismisses it, through the shared escape stack',
  async (t: TestContext) => {
    setup()
    const n = agent('gamma')
    let closed = 0
    const view = await mountView(scene(n, true, () => { closed++ }), (el) => el)
    t.after(() => view.unmount())
    await flush()
    await inAct(() => {
      W.dispatchEvent(new W.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    await flush()
    assert.equal(closed, 1, 'Escape did not dismiss the temporary desk')
  })

test('§4 the BACKDROP dismisses it and the panel does not', async (t: TestContext) => {
    setup()
    const n = agent('delta')
    let closed = 0
    const view = await mountView(scene(n, true, () => { closed++ }), (el) => el)
    t.after(() => view.unmount())
    await flush()
    const press = (el: Element) => inAct(() => {
      el.dispatchEvent(new W.MouseEvent('pointerdown',
        { bubbles: true, cancelable: true, button: 0 }))
      // the shared frame dismisses on the click a backdrop press ends in
      el.dispatchEvent(new W.MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }))
    })
    await press(modal()!)
    await flush()
    assert.equal(closed, 0, 'a press INSIDE the panel dismissed it')
    await press(backdrop()!)
    await flush()
    assert.equal(closed, 1, 'a press on the backdrop did not dismiss it')
  })

test('§5 focus goes into the panel, and comes back to the opener',
  async (t: TestContext) => {
    // "closing puts everything back" includes the keyboard: leaving the user on
    // document.body sends their next keystroke nowhere.
    setup()
    const n = agent('zeta')
    const opener = document.createElement('button')
    opener.id = 'opener'
    document.body.appendChild(opener)
    t.after(() => opener.remove())
    const view = await mountView(scene(n, false), (el) => el)
    t.after(() => view.unmount())
    await flush()
    await inAct(() => { opener.focus() })
    assert.equal(document.activeElement, opener)
    await view.render(scene(n, true))
    await flush()
    assert.ok(modal()!.contains(document.activeElement),
      'focus stayed outside the modal — a keyboard user is not in it')
    await view.render(scene(n, false))
    await flush()
    assert.equal(document.activeElement, opener,
      'focus did not return to the control that opened the modal')
  })

/* ─── and what it must NOT do, through the real canvas ────────────────────── */

const asTree = (v: unknown) => v as TreePayload
function mkNode(id: string, extra: Record<string, unknown> = {}): unknown {
  return {
    id, title: id, tier: 'haiku', model_id: 'haiku', state: 'live',
    seat: 1, grant: 0, free: 0, ui_order: 0, cost_usd: 0, occupancy: null,
    context_window: null, charter: null, mail_pending: 0, limit_locked: false,
    last_status: null, prev_status: null, inflight_at: null, last_denials: [],
    turns: [], frozen: null, audiences_held: [], bearer_state: null,
    generation: 0, children: [], lineage: [],
    scope: { permission_mode: 'default', add_dirs: [], tools: {}, org_visibility: 'team' },
    ...extra,
  }
}
function tree(roots: unknown[]): TreePayload {
  return asTree({
    slug: 'mine', name: 'mine', workspace: null, dirs: [], max_top_grant: 1000,
    default_top_grant: 50, compact_at: 0, default_tools: null,
    default_visibility: 'team', default_effort: '', credit_requests: [],
    tiers: { haiku: 1, sonnet: 3, opus: 5, fable: 10 }, audiences: [],
    roots, cost_usd_total: 0,
    audit: { live_nodes: roots.length, top_level_holds: 0, no_overdraft: true, problems: [] },
    user_inbox_count: 0, user_inbox_newest: null, fable_lock: null,
    auto_resume: false,
    fable_limit_policy: 'freeze', fable_filter_policy: 'halt',
    cascade_hire: false, cascade_alloc: true,
    audience_requests: [], org_inbox: null, net: null,
  })
}
type Cap = { setPointerCapture?: unknown; releasePointerCapture?: unknown; hasPointerCapture?: unknown }
function stubPointerCapture(): () => void {
  const proto = (globalThis as unknown as { HTMLElement: { prototype: Cap } }).HTMLElement.prototype
  const had = { s: proto.setPointerCapture, r: proto.releasePointerCapture, h: proto.hasPointerCapture }
  proto.setPointerCapture = () => {}; proto.releasePointerCapture = () => {}; proto.hasPointerCapture = () => false
  return () => { proto.setPointerCapture = had.s; proto.releasePointerCapture = had.r; proto.hasPointerCapture = had.h }
}

test('§7 picking the entry changes no focus, pins nothing and opens no window',
  async (t: TestContext) => {
    // ⚠ THE THREE THINGS THE FEATURE EXISTS TO AVOID, checked through the real
    // canvas rather than through my handler in isolation: the camera must not
    // move, no pinned window may appear, and no native surface may be opened.
    t.after(stubPointerCapture())
    useFakeClock()
    t.after(realClock)
    setup()
    const v = await mountView(
      <OrgCanvas tree={tree([mkNode('worker')])} slug="mine"
        op={() => Promise.resolve({})} toast={noop} mailEvt={null}
        onOpenAgentGallery={noop} />, (h) => h)
    t.after(() => v.unmount())
    await flush(); await advance(400, 50); await flush()
    const space = () => (v.el.querySelector('.space') as HTMLElement).style.transform
    const cameraBefore = space()
    const surfacesBefore = openSurfaces().length
    const card = v.el.querySelector('[data-copy-agent-name="worker"]')
      ?? v.el.querySelector('.sq')
    assert.ok(card, 'no agent card to open the menu on')
    await inAct(() => {
      card!.dispatchEvent(new W.MouseEvent('contextmenu',
        { bubbles: true, cancelable: true, button: 2, clientX: 40, clientY: 30 }))
    })
    await flush(2)
    await surveyMenu(); await openBranchOf('Desk')
    const entry = [...document.querySelectorAll('button, [role="menuitem"]')]
      .find((b) => (b.textContent ?? '').trim() === 'Desk')
    assert.ok(entry, 'the agent menu does not offer "Desk"')
    await inAct(() => { (entry as HTMLElement).click() })
    await flush(2)
    assert.ok(modal(), 'picking the entry did not open the temporary desk')
    // …and none of the three things happened
    assert.equal(space(), cameraBefore,
      'the camera moved — a glance is not supposed to walk the tree')
    assert.equal(openSurfaces().length, surfacesBefore,
      'a native window was opened')
    assert.equal(v.el.querySelector('.pinwin'), null,
      'a pinned desk window appeared')
  })

test('§8 the Pin button pins the desk and closes the modal; a pinned agent gets none',
  async (t: TestContext) => {
    // docket `v3-a-temporarily-opened-desk-gets-a-pin-button`: the glance can
    // be turned into a placement in one click, through the canvas's own pin
    // action — and the borrowed desk lands in the pinned window, not left
    // behind as the "open elsewhere" placeholder.
    t.after(stubPointerCapture())
    useFakeClock()
    t.after(realClock)
    setup()
    t.after(() => removePin('mine', 'worker'))
    const v = await mountView(
      <OrgCanvas tree={tree([mkNode('worker')])} slug="mine"
        op={() => Promise.resolve({})} toast={noop} mailEvt={null}
        onOpenAgentGallery={noop} />, (h) => h)
    t.after(() => v.unmount())
    await flush(); await advance(400, 50); await flush()
    const openTemporarily = async () => {
      const card = v.el.querySelector('.space [data-copy-agent-name="worker"]')
      assert.ok(card, 'no agent card to open the menu on')
      await inAct(() => {
        card!.dispatchEvent(new W.MouseEvent('contextmenu',
          { bubbles: true, cancelable: true, button: 2, clientX: 40, clientY: 30 }))
      })
      await flush(2)
      await surveyMenu(); await openBranchOf('Desk')
      const entry = [...document.querySelectorAll('button, [role="menuitem"]')]
        .find((b) => (b.textContent ?? '').trim() === 'Desk')
      assert.ok(entry, 'the agent menu does not offer "Desk"')
      await inAct(() => { (entry as HTMLElement).click() })
      await flush(2)
      assert.ok(modal(), 'picking the entry did not open the temporary desk')
    }
    await openTemporarily()
    // user 2026-10-01: no visible "opened temporarily" label (the aria-label keeps it)
    assert.equal(/opened temporarily/.test(modal()!.textContent ?? ''), false,
      'the temporary desk still shows the "opened temporarily" label')
    assert.equal(Boolean(modal()!.querySelector('.tempdesk-note')), false, 'the note span is back')
    assert.equal(Boolean(modal()!.querySelector(':scope > .modalpin-bar .pinwin-name')), true,
      'control failed: the title bar lost the agent name')
    assert.equal(Boolean(v.el.querySelector('.pinwin')), false, 'pinned before the click')
    const pin = document.querySelector<HTMLButtonElement>('.tempdesk-panel > .modalpin-bar .modalpin-btn:not(.modalpin-x)')
    assert.ok(pin, 'the temporary desk has no Pin button')
    assert.equal(pin!.getAttribute('aria-label'), 'pin this to the window',
      'the Pin button is not the pin of the shared frame')
    const frame = { x: 51.25, y: 42.5, w: 921.5, h: 633.25 }
    const measured = (r: typeof frame) => ({ ...r, left: r.x, top: r.y,
      width: r.w, height: r.h, right: r.x + r.w, bottom: r.y + r.h, toJSON() {} })
    modal()!.getBoundingClientRect = () => measured(frame)
    const viewport = v.el.querySelector<HTMLElement>('[data-pin-org="mine"]')!
    viewport.getBoundingClientRect = () => measured({ x: 17, y: 95, w: 1000, h: 580 })
    await inAct(() => { pin!.click() })
    await flush(2); await advance(100, 20); await flush(2)
    assert.equal(Boolean(modal()), false, 'the temporary modal did not close')
    const win = document.querySelector('.pinwin') as HTMLElement | null
    assert.ok(win, 'no pinned desk window appeared')
    assert.deepEqual(['left', 'top', 'width', 'height'].map(k => parseFloat(win!.style[k as 'left'])),
      [frame.x, frame.y, frame.w, frame.h], 'PIN keeps the whole modal rectangle, including above the canvas')
    assert.equal(win!.style.position, 'fixed', 'canvas clipping must not cut off the original modal frame')
    const borders = window.getComputedStyle(viewport)
    assert.deepEqual(readPins('mine')[0]!.rect, { ...frame,
      x: frame.x - 17 - (parseFloat(borders.borderLeftWidth) || 0),
      y: frame.y - 95 - (parseFloat(borders.borderTopWidth) || 0) },
      'the stored desk geometry is still canvas-local for subsequent gestures')
    assert.equal(win!.querySelector('.pinwin-title .pinwin-name')?.textContent?.includes('worker'), true,
      'the pinned window is not for this agent')
    assert.ok(win!.querySelector('.pinwin-body .desk-slot, .pinwin-body .cc-head'),
      'the pinned window holds no desk')
    assert.ok(!/desk is open elsewhere/.test(win!.textContent ?? ''),
      'the pinned window shows the placeholder — the desk stayed borrowed')
    await inAct(() => forgetPins('mine'))
    assert.deepEqual(readPins('mine')[0]!.initialPlacement?.client, frame, 'reload retains the measured placement')
    // ⚠ BOOLEANS, NOT ELEMENTS, IN THESE ASSERTS: a failing assert.equal on
    // a jsdom element makes node's reporter run out of memory.
    // opened temporarily again, an already-pinned agent is offered no Pin
    await openTemporarily()
    assert.equal(Boolean(document.querySelector('.tempdesk-panel > .modalpin-bar .modalpin-btn:not(.modalpin-x)')), false,
      'an already-pinned agent still shows a Pin button')
    await inAct(() => { commitRect('mine', 'worker', {x: 30, y: 40, w: 600, h: 400}, {w: 1000, h: 580}) })
    assert.equal(readPins('mine')[0]!.initialPlacement, undefined, 'later gestures return to ordinary pin placement')
  })

for (const ratio of [1, 1.25, 1.5, 2]) test(`temporary pop-out preserves the frame at ${ratio} DPR and closes the modal`, async t => {
  setup()
  installBridge({})
  const child = new JSDOM('<!doctype html><html><head></head><body></body></html>', { url: 'http://localhost/' })
  const cw = child.window as unknown as Window
  cw.focus = noop; cw.requestAnimationFrame = () => 1; cw.cancelAnimationFrame = noop
  const oldOpen = window.open
  const oldObserver = globalThis.MutationObserver
  const oldRatio = Object.getOwnPropertyDescriptor(window, 'devicePixelRatio')!
  const oldX = Object.getOwnPropertyDescriptor(window, 'screenX')!
  const oldY = Object.getOwnPropertyDescriptor(window, 'screenY')!
  Object.defineProperties(window, { devicePixelRatio: {value: ratio, configurable: true},
    screenX: {value: -1440, configurable: true}, screenY: {value: 80, configurable: true} })
  globalThis.MutationObserver = W.MutationObserver
  let features = '', opens = 0
  window.open = ((_url, _name, options) => { features = options ?? ''; opens++; return cw }) as typeof window.open
  const n = agent(`geometry-${ratio}`)
  function Scene() {
    const [opened, setOpened] = useState(true)
    return scene(n, opened, () => setOpened(false))
  }
  const view = await mountView(<Scene />, el => el)
  t.after(async () => {
    await view.unmount(); window.open = oldOpen; globalThis.MutationObserver = oldObserver
    Object.defineProperties(window, { devicePixelRatio: oldRatio, screenX: oldX, screenY: oldY })
    child.window.close(); removeBridge(); localStorage.clear()
  })
  await flush()
  const frame = { x: 41.25, y: 52.75, width: 903.25, height: 633.5 }
  modal()!.getBoundingClientRect = () => ({ ...frame, left: frame.x, top: frame.y,
    right: frame.x + frame.width, bottom: frame.y + frame.height, toJSON() {} })
  // A borrowed native desk can leave an open saved row behind. It must not
  // override the explicit geometry of this new user placement.
  const kind = `desk:${JSON.stringify(['org', n.id, 0])}`
  captureWindow(windowLayoutKey(kind, 'org'), kind, 'org', cw, true)
  const composer = modal()!.querySelector('textarea')!
  assert.ok(composer, 'control: a real composer is mounted')
  const button = modal()!.querySelector<HTMLButtonElement>('[aria-label="Open in new window"]')!
  assert.ok(button, 'control: the canonical desk offers pop-out')
  await inAct(() => button.click()); await flush()
  assert.equal(opens, 1)
  const actual = Object.fromEntries(features.split(',').filter(p => p.includes('=')).map(p => {
    const [k, v] = p.split('='); return [k, Number(v)]
  }))
  const expected = {left: -1440 + frame.x, top: 80 + frame.y, width: frame.width, height: frame.height}
  for (const k of Object.keys(expected) as (keyof typeof expected)[]) {
    assert.ok(Math.abs(actual[k]! - expected[k]) * ratio <= 1, `${k} drifted by more than one physical pixel: ${features}`)
  }
  assert.equal(Boolean(modal()), false, 'successful pop-out closes its temporary modal')
  assert.equal(Boolean(backdrop()), false, 'no modal backdrop remains')
  assert.equal(Boolean(cw.document.querySelector('textarea')), true, 'the window shows a live desk')
  assert.equal(document.querySelectorAll('textarea').length, 1, 'the canvas keeps its own desk; the modal\'s is gone')
})

test('blocked temporary pop-out keeps the modal and its composer', async t => {
  setup()
  const oldOpen = window.open
  window.open = () => null
  const n = agent('blocked-popout')
  function Scene() {
    const [opened, setOpened] = useState(true)
    return scene(n, opened, () => setOpened(false))
  }
  const view = await mountView(<Scene />, el => el)
  t.after(async () => { await view.unmount(); window.open = oldOpen })
  await flush()
  const composer = modal()!.querySelector('textarea')
  await inAct(() => modal()!.querySelector<HTMLButtonElement>('[aria-label="Open in new window"]')!.click())
  await flush()
  assert.ok(modal(), 'a failed pop-out must not dismiss the source')
  assert.equal(modal()!.querySelector('textarea') === composer, true)
})
