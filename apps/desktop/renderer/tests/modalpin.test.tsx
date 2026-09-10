// modalpin.test.tsx — MODALS PINNED TO THE WINDOW (canvas/modalpin.tsx).
//
// The user's spec (2026-09-06): "most openable modals in the app should be
// able to be pinned to the window and dragged around, like pinned agent
// windows. this goes for inboxes, usage, presentations, the docket, etc."
//
// WHAT THIS SUITE OWNS, AND WHAT IT CANNOT. jsdom does no layout, so nothing
// here is a claim about pixels: `getBoundingClientRect` is 0×0, which is
// exactly why `measureRect` has a declared fallback and why the fallback is
// what the component tests below place a fresh window at. But the WINDOW is
// measured — `window.innerWidth/innerHeight` are real numbers in jsdom
// (1024×768) — so the clamp, the drag arithmetic and the resize floor ARE
// exercised here against explicit coordinates rather than deferred to the
// browser. What jsdom cannot answer, and `modalpin_probe.py` therefore does:
// whether a pinned window is really draggable with a pointer in a browser,
// whether the backdrop really stops intercepting clicks, whether the title
// bar really stays put while the panel scrolls, and whether the panel's
// scroll position and text selection really survive a pin.
//
// THE CENTRAL CLAIM IS §3: pinning must not REMOUNT the surface. That is what
// preserves an open row, a half-typed reply and a scroll position, and it is
// invisible in a screenshot — a wrapper that nests the children one level
// deeper when pinned looks identical and silently throws all of it away. §3
// holds the panel element's identity across the toggle and watches a child's
// own state survive it.
//
// Each check was watched fail (mutants, in the order of the sections):
//   store     drop the localStorage write in `write`  → §1 finds nothing after
//             forgetModalPins(); return the raw z from `renorm` → §1 z band
//   frame     render children inside an extra <div> when pinned → §3 remount
//             (both halves: element identity AND the child's counter)
//   escape    call `esc()` unconditionally → §4 Escape closes a pinned window
//   backdrop  keep the overlay's onClick when pinned → §4 backdrop close
//   nav       make closeIfCentred always close → §6
//   drag      commit on every pointermove instead of at pointerup → §5 writes
//             mid-gesture; drop the 3px threshold → §5 a click repositions
//
// Run:  cd frontend && node tests/run.mjs modalpin

import { flush, inAct, mountView as rawMountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { useState } from 'react'
import {
  closeIfCentred, forgetModalPins, isModalPinned, MODAL_FALLBACK_RECT,
  MODAL_PINS_KEY, MODAL_Z_BASE, MODAL_Z_TOP, modalZIndex, PinFrame, pinModal,
  raiseModal, readModalPins, unpinModal, commitModalRect, measureRect,
  MODAL_OPEN_KEY, readModalOpen, rememberModalOpen, forgetModalOpen, forgetModalOpenCache, usePersistedModalOpen,
} from '../src/canvas/modalpin'
import { PIN_MIN_H, PIN_MIN_W } from '../src/canvas/pins'
import { DocReader } from '../src/canvas/docs'
import { WatchdogPanel } from '../src/canvas/modals'
import type { Watchdog } from '../src/types'
import { restoredAgent } from '../src/windowlayout'
import { CurrentOrg } from '../src/popout'
import type { ReactNode } from 'react'

// Pin controls now belong only to org surfaces. Give this gesture suite a
// measured org canvas, and follow the SAME adopted container outside its host.
async function mountView<T>(node: ReactNode, select: (el: HTMLElement) => T) {
  const canvases = ['probe', 'a', 'b'].map(org => {
    const el = document.createElement('div'); el.dataset.pinOrg = org
    el.style.border = '0px solid transparent'
    el.getBoundingClientRect = () => ({x:0,y:0,left:0,top:0,width:window.innerWidth,height:window.innerHeight,right:window.innerWidth,bottom:window.innerHeight,toJSON(){}})
    document.body.appendChild(el); return el
  })
  const existing = new Set(document.querySelectorAll('.movable-surface'))
  const v = await rawMountView(<CurrentOrg.Provider value="probe">{node}</CurrentOrg.Provider>, select)
  const surfaces = [...document.querySelectorAll<HTMLElement>('.movable-surface')].filter(el => !existing.has(el))
  const one = v.el.querySelector.bind(v.el), all = v.el.querySelectorAll.bind(v.el)
  v.el.querySelector = ((q: string) => {
    for (const el of all<HTMLElement>('.movable-surface')) if (!surfaces.includes(el)) surfaces.push(el)
    return one(q) ?? surfaces.map(el => el.querySelector(q)).find(Boolean) ?? null
  }) as typeof v.el.querySelector
  v.el.querySelectorAll = ((q: string) => [...new Set([...all(q), ...surfaces.flatMap(el => [...el.querySelectorAll(q)])])]) as unknown as typeof v.el.querySelectorAll
  const unmount = v.unmount
  v.unmount = async () => {await unmount(); canvases.forEach(el => el.remove())}
  return v
}

const noop = () => {}
const reset = () => { localStorage.clear(); forgetModalPins(); forgetModalOpenCache() }

// ------------------------------------------------------------------ events
function stubPointerCapture(): () => void {
  const proto = (globalThis as unknown as {
    HTMLElement: { prototype: Record<string, unknown> } }).HTMLElement.prototype
  const had = { s: proto.setPointerCapture, r: proto.releasePointerCapture }
  proto.setPointerCapture = noop
  proto.releasePointerCapture = noop
  return () => { proto.setPointerCapture = had.s; proto.releasePointerCapture = had.r }
}
function pointer(type: string, x: number, y: number): Event {
  const Ctor = (globalThis as unknown as {
    window: { PointerEvent: typeof PointerEvent } }).window.PointerEvent
  return new Ctor(type, {
    bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse',
    isPrimary: true, button: type === 'pointermove' ? -1 : 0, buttons: 1,
    clientX: x, clientY: y,
  })
}
const key = (k: string) => {
  const Ctor = (globalThis as unknown as {
    window: { KeyboardEvent: typeof KeyboardEvent } }).window.KeyboardEvent
  window.dispatchEvent(new Ctor('keydown', { key: k, bubbles: true, cancelable: true }))
}
const click = (el: Element) => {
  const Ctor = (globalThis as unknown as {
    window: { MouseEvent: typeof MouseEvent } }).window.MouseEvent
  el.dispatchEvent(new Ctor('click', { bubbles: true, cancelable: true }))
}

// -------------------------------------------------------------------- rig
interface Shot {
  overlay: HTMLElement | null
  panel: HTMLElement | null
  pinned: boolean
  rect: { left: string; top: string; width: string; height: string } | null
  z: string
  bar: HTMLElement | null
  handles: number
  /** the counter a child owns — the state a remount would throw away */
  count: string
  closes: number
}
/** a child with STATE of its own: if pinning remounts the subtree, this goes
 *  back to 0 and §3 says so. A stateless child could not tell the difference. */
function Counter() {
  const [n, setN] = useState(0)
  return <button className="counter" onClick={() => setN((v) => v + 1)}>{n}</button>
}

const closes = { n: 0 }
const shot = (host: HTMLElement): Shot => {
  const overlay = host.querySelector<HTMLElement>('.overlay')
  const panel = host.querySelector<HTMLElement>('.overlay > div')
  return {
    overlay,
    panel,
    pinned: Boolean(overlay?.classList.contains('overlay-pinned')),
    rect: panel ? {
      left: panel.style.left, top: panel.style.top,
      width: panel.style.width, height: panel.style.height,
    } : null,
    z: overlay?.style.zIndex ?? '',
    bar: host.querySelector<HTMLElement>('.modalpin-bar'),
    handles: host.querySelectorAll('.modalpin-rs').length,
    count: host.querySelector('.counter')?.textContent ?? '',
    closes: closes.n,
  }
}
function RestartHarness() {
  const [open, setOpen] = useState(() => readModalOpen('probe').some(r => r.kind === 'org-inbox' && isModalPinned('org-inbox')))
  usePersistedModalOpen('org-inbox', 'probe', open)
  return open
    ? <PinFrame kind="org-inbox" title="usage limits" panel="settings usage-modal" close={() => setOpen(false)}>
        <button className="child-close" onClick={() => setOpen(false)}>close</button>
      </PinFrame>
    : <button className="open-modal" onClick={() => setOpen(true)}>open</button>
}
function OrgSwitchHarness({ initial = 'a' }: { initial?: string }) {
  const [org, setOrg] = useState(initial)
  const [open, setOpen] = useState(() => readModalOpen(initial).some(r => r.kind === 'node-config' && isModalPinned('node-config')))
  usePersistedModalOpen('node-config', org, open, open ? { agent: org === 'a' ? 'alice' : 'bob', generation: org === 'a' ? 1 : 2 } : undefined)
  return <CurrentOrg.Provider value={org}>
    <button className="switch-org" onClick={() => setOrg(org === 'a' ? 'b' : 'a')}>switch</button>
    {open
      ? <PinFrame kind="node-config" title="settings" panel="settings" restore={{ agent: org === 'a' ? 'alice' : 'bob', generation: org === 'a' ? 1 : 2 }} close={() => setOpen(false)}>
          <button className="child-close" onClick={() => setOpen(false)}>close</button>
        </PinFrame>
      : <button className="open-modal" onClick={() => setOpen(true)}>open</button>}
  </CurrentOrg.Provider>
}const frame = (kind = 'org-inbox') => (
  <PinFrame kind={kind} title="usage limits" panel="settings usage-modal"
    close={() => { closes.n += 1 }}>
    <h3>usage limits</h3>
    <Counter />
  </PinFrame>
)
const mount = async (kind = 'org-inbox') => {
  closes.n = 0
  return mountView(frame(kind), shot)
}
const toggle = async (host: HTMLElement) => {
  await inAct(() => { click(host.querySelector('.modalpin-btn')!) })
  await flush()
}

// ============================================================== §1 the store
test('§1 the store: pin, raise, unpin, the z band, and what garbage reads as', () => {
  reset()
  assert.deepEqual(readModalPins(), {}, 'a fresh browser holds no pinned modals')
  assert.equal(isModalPinned('org-inbox'), false)

  pinModal('org-inbox', { x: 10, y: 20, w: 700, h: 400 })
  pinModal('docket', { x: 30, y: 40, w: 500, h: 300 })
  assert.equal(isModalPinned('org-inbox'), true)
  assert.equal(isModalPinned('docket'), true)
  // ordinals are 0..n-1 in pin order, newest on top
  assert.deepEqual(
    Object.fromEntries(Object.entries(readModalPins()).map(([k, v]) => [k, v.z])),
    { 'org-inbox': 0, docket: 1 })

  raiseModal('org-inbox')
  assert.deepEqual(
    Object.fromEntries(Object.entries(readModalPins()).map(([k, v]) => [k, v.z])),
    { 'org-inbox': 1, docket: 0 }, 'raising renormalises: the raised one is last')

  // the band is HARD-clamped — 50 pinned windows must never reach the modal
  // layer (20) from below or climb past the disk browser (55) above
  assert.equal(modalZIndex(0), MODAL_Z_BASE)
  assert.equal(modalZIndex(-5), MODAL_Z_BASE, 'a negative ordinal cannot sink under the band')
  assert.equal(modalZIndex(999), MODAL_Z_TOP)
  assert.ok(MODAL_Z_BASE >= 10 && MODAL_Z_TOP < 17,
    'the band sits below canvas controls and centred overlays')

  // pinning something already pinned is a no-op, not a duplicate or a move
  pinModal('org-inbox', { x: 999, y: 999, w: 400, h: 400 })
  assert.equal(readModalPins()['org-inbox']!.rect.x, 10)

  // it PERSISTS: drop the cache and it comes back from localStorage
  forgetModalPins()
  assert.equal(isModalPinned('org-inbox'), true, 'a pinned modal survives a reload')
  assert.equal(readModalPins()['org-inbox']!.rect.w, 700)

  unpinModal('org-inbox')
  unpinModal('docket')
  assert.deepEqual(readModalPins(), {})
  assert.equal(localStorage.getItem(MODAL_PINS_KEY), null,
    'the last unpin removes the key rather than leaving {}')

  // a hand-edited or foreign value reads as NO pins — never as a throw
  localStorage.setItem(MODAL_PINS_KEY, '{"org-inbox":{"rect":{"x":"left"},"z":0},"ok":')
  forgetModalPins()
  assert.deepEqual(readModalPins(), {})
  localStorage.setItem(MODAL_PINS_KEY,
    '{"org-inbox":{"rect":{"x":1,"y":2,"w":3,"h":4},"z":0},"bad":{"rect":null,"z":1}}')
  forgetModalPins()
  assert.deepEqual(Object.keys(readModalPins()), ['org-inbox'],
    'a bad entry is dropped; the good ones beside it are kept')
  reset()
})

test('§1d pinned modal open state survives storage reload and is scoped by org', () => {
  reset()
  rememberModalOpen('node-config', 'acme', { agent: 'worker', generation: 2 })
  rememberModalOpen('org-inbox', null)
  assert.deepEqual(readModalOpen('acme'), [
    { kind: 'node-config', org: 'acme', restore: { agent: 'worker', generation: 2 } },
    { kind: 'org-inbox', org: null },
  ])
  assert.deepEqual(readModalOpen('other'), [{ kind: 'org-inbox', org: null }])
  forgetModalOpenCache()
  assert.equal(localStorage.getItem(MODAL_OPEN_KEY)?.includes('node-config'), true)
  assert.deepEqual(readModalOpen('acme'), [
    { kind: 'node-config', org: 'acme', restore: { agent: 'worker', generation: 2 } },
    { kind: 'org-inbox', org: null },
  ])
  forgetModalOpen('node-config', 'acme')
  assert.deepEqual(readModalOpen('acme'), [{ kind: 'org-inbox', org: null }])
  reset()
})
test('§1b the clamp and the size floor are the agent window\'s, not a second set', () => {
  reset()
  // window is 1024×768 in jsdom; a window dragged off the right edge comes back
  pinModal('org-inbox', { x: 900, y: 700, w: 600, h: 400 })
  const r = readModalPins()['org-inbox']!.rect
  assert.equal(r.x + r.w <= 1024, true, `x=${r.x} w=${r.w} must fit the window`)
  assert.equal(r.y + r.h <= 768, true, `y=${r.y} h=${r.h} must fit the window`)
  commitModalRect('org-inbox', { x: 10, y: 10, w: 10, h: 10 })
  assert.deepEqual(readModalPins()['org-inbox']!.rect,
    { x: 10, y: 10, w: PIN_MIN_W, h: PIN_MIN_H },
    'a window smaller than the shared floor is grown, not accepted')
  // commit for something that is not pinned writes nothing
  commitModalRect('nothing', { x: 1, y: 1, w: 400, h: 400 })
  assert.deepEqual(Object.keys(readModalPins()), ['org-inbox'])
  reset()
})

test('§1c measureRect: an unmeasurable panel falls back rather than to 0×0', () => {
  // jsdom reports every box as 0×0 — the same answer a panel gives before its
  // first paint. A window placed at 0×0 would be invisible and unresizable.
  const el = document.createElement('div')
  assert.deepEqual(measureRect(el), MODAL_FALLBACK_RECT)
  assert.deepEqual(measureRect(null), MODAL_FALLBACK_RECT)
  assert.ok(MODAL_FALLBACK_RECT.w >= PIN_MIN_W && MODAL_FALLBACK_RECT.h >= PIN_MIN_H)
})

// ========================================================== §2 the two modes
test('§1e pinned agent restore accepts only the current generation', () => {
  const nodes = new Map([['worker', { generation: 4 }]])
  const base = { key: 'saved', kind: 'node-config', org: 'acme', open: true, rect: { x: 0, y: 0, width: 200, height: 150 } }
  assert.equal(restoredAgent({ ...base, restore: { agent: 'worker', generation: 3 } }, nodes), null)
  assert.equal(restoredAgent({ ...base, restore: { agent: 'worker', generation: 4 } }, nodes), 'worker')
})

test('org switch does not copy pinned open state', async () => {
  reset()
  let v = await mountView(<OrgSwitchHarness />, shot)
  await inAct(() => { click(v.el.querySelector('.open-modal')!) })
  await flush()
  await inAct(() => { click(v.el.querySelector('.modalpin-btn')!) })
  await flush()
  assert.ok(readModalOpen('a').some(r => r.kind === 'node-config' && r.org === 'a' && r.restore?.agent === 'alice'))
  rememberModalOpen('node-config', 'b', { agent: 'bob', generation: 2 })
  await inAct(() => { click(v.el.querySelector('.switch-org')!) })
  await flush()
  assert.equal(readModalOpen('b').find(r => r.kind === 'node-config' && r.org === 'b')?.restore?.agent, 'bob', 'B keeps its own restore target')
  assert.ok(readModalOpen('a').some(r => r.kind === 'node-config' && r.org === 'a' && r.restore?.agent === 'alice'))
  forgetModalOpen('node-config', 'b')
  assert.equal(readModalOpen('b').some(r => r.kind === 'node-config' && r.org === 'b'), false, 'a closed B stays closed')
  await v.unmount()
  forgetModalPins(); forgetModalOpenCache()
  v = await mountView(<OrgSwitchHarness initial="b" />, shot)
  assert.equal(v.last().overlay, null, 'B does not inherit A open state after restart')
  await v.unmount()
  forgetModalOpenCache()
  v = await mountView(<OrgSwitchHarness initial="a" />, shot)
  assert.ok(v.last().overlay, 'A retains its own pinned open state after restart')
  await v.unmount()
  reset()
})
test('§2b a pinned modal reopens after remount, while close and unpin stay closed', async () => {
  reset()
  let v = await mountView(<RestartHarness />, shot)
  await inAct(() => { click(v.el.querySelector('.open-modal')!) })
  await flush()
  await inAct(() => { click(v.el.querySelector('.modalpin-btn')!) })
  await flush()
  assert.equal(v.last().pinned, true)
  assert.ok(readModalOpen('probe').some(r => r.kind === 'org-inbox'))

  await v.unmount()
  forgetModalPins(); forgetModalOpenCache()
  v = await mountView(<RestartHarness />, shot)
  assert.equal(v.last().pinned, true, 'a fresh mount restores the pinned open surface')

  await inAct(() => { click(v.el.querySelector('.child-close')!) })
  await flush()
  assert.equal(localStorage.getItem(MODAL_OPEN_KEY), null, 'a child close clears its open marker')
  await v.unmount()
  forgetModalPins(); forgetModalOpenCache()
  v = await mountView(<RestartHarness />, shot)
  assert.equal(v.last().overlay, null, 'a child-closed modal is not resurrected after remount')
  await v.unmount()
  reset()

  // The bar-close path is independently checked after a fresh pin.
  v = await mountView(<RestartHarness />, shot)
  await inAct(() => { click(v.el.querySelector('.open-modal')!) })
  await flush()
  await inAct(() => { click(v.el.querySelector('.modalpin-btn')!) })
  await flush()
  await inAct(() => { click(v.el.querySelector('.modalpin-x')!) })
  await flush()
  assert.equal(localStorage.getItem(MODAL_OPEN_KEY), null, 'closing the pinned bar clears its open marker')
  await inAct(() => { click(v.el.querySelector('.open-modal')!) })
  await flush()
  assert.ok(readModalOpen('probe').some(r => r.kind === 'org-inbox'), 'normal reopen restores the marker')
  await v.unmount()
  forgetModalPins(); forgetModalOpenCache()
  v = await mountView(<RestartHarness />, shot)
  assert.equal(v.last().overlay?.className, 'overlay overlay-pinned', 'a normally reopened modal returns after remount')
  await v.unmount()
  reset()

  // Re-open, pin, then unpin without closing: unpinning removes the restart
  // marker even though the centred surface remains visible in this session.
  v = await mountView(<RestartHarness />, shot)
  await inAct(() => { click(v.el.querySelector('.open-modal')!) })
  await flush()
  await inAct(() => { click(v.el.querySelector('.modalpin-btn')!) })
  await flush()
  await inAct(() => { click(v.el.querySelector('.modalpin-btn')!) })
  await flush()
  assert.equal(localStorage.getItem(MODAL_OPEN_KEY), null)
  await v.unmount()
  forgetModalPins(); forgetModalOpenCache()
  v = await mountView(<RestartHarness />, shot)
  assert.equal(v.last().overlay, null, 'unpinning does not cause a later remount to reopen it')
  await v.unmount()
  reset()
})
test('§2 centred is exactly what it was; pinned is a window', async () => {
  reset()
  const v = await mount()
  let s = v.last()
  assert.equal(s.pinned, false)
  assert.equal(s.overlay!.className, 'overlay', 'a centred surface keeps the bare overlay class')
  assert.equal(s.panel!.className, 'settings usage-modal',
    'and the panel keeps exactly the classes it had before it was wrapped')
  assert.equal(s.z, '', 'a centred overlay takes no inline z-index: the stylesheet owns it')
  assert.deepEqual(s.rect, { left: '', top: '', width: '', height: '' })
  assert.equal(s.handles, 0, 'nothing to resize while centred')
  assert.ok(s.bar, 'the bar is present in BOTH modes — see §3')

  await toggle(v.el)
  s = v.last()
  assert.equal(s.pinned, true)
  assert.equal(s.panel!.className, 'settings usage-modal modalpin-win',
    'pinned ADDS a class; it never replaces the panel\'s own')
  assert.deepEqual(s.rect, {
    left: `${MODAL_FALLBACK_RECT.x}px`, top: `${MODAL_FALLBACK_RECT.y}px`,
    width: `${MODAL_FALLBACK_RECT.w}px`, height: `${MODAL_FALLBACK_RECT.h}px`,
  }, 'a fresh pin lands where the panel was measured (here: the fallback)')
  assert.equal(s.z, String(MODAL_Z_BASE))
  assert.equal(s.handles, 8, 'eight resize edges, like an agent window')
  await v.unmount()
  reset()
})

// ================================================ §3 THE CLAIM: no remount
test('§3 pinning re-dresses the panel — it never rebuilds it', async () => {
  reset()
  const v = await mount()
  const panelBefore = v.last().panel
  // give the subtree some state to lose
  await inAct(() => { click(v.el.querySelector('.counter')!) })
  await inAct(() => { click(v.el.querySelector('.counter')!) })
  assert.equal(v.last().count, '2')

  await toggle(v.el)
  assert.equal(v.last().pinned, true)
  assert.equal(v.last().panel, panelBefore,
    'the SAME DOM element carries the pinned window — a new one means React '
    + 'unmounted the surface and every scroll position went with it')
  assert.equal(v.last().count, '2', 'and the children kept their own state')

  await toggle(v.el)
  assert.equal(v.last().pinned, false)
  assert.equal(v.last().panel, panelBefore, 'unpinning is the same move backwards')
  assert.equal(v.last().count, '2')

  // the bar is the FIRST child in both modes, and the handles come LAST —
  // that ordering is what keeps every child's position in the element list
  // unchanged when the handles appear
  await toggle(v.el)
  const kids = [...v.last().panel!.children].map((c) => c.className.split(' ')[0])
  assert.equal(kids[0], 'modalpin-bar')
  assert.equal(v.last().panel!.querySelectorAll('.modalpin-rs').length, 0)
  assert.equal(v.last().panel!.nextElementSibling?.className, 'modalpin-resize-frame')
  assert.equal(kids.indexOf('counter'), 2, 'h3 then the counter, where they always were')
  await v.unmount()
  reset()
})

// ================================================= §4 the modal rules change
test('§4 Escape and the backdrop close a centred modal, never a pinned window', async () => {
  reset()
  const v = await mount()
  await inAct(() => { key('Escape') })
  assert.equal(v.last().closes, 1, 'Escape closes a centred modal (unchanged)')
  await inAct(() => { click(v.last().overlay!) })
  assert.equal(v.last().closes, 2, 'and so does a click on the backdrop (unchanged)')

  await toggle(v.el)
  await inAct(() => { key('Escape') })
  assert.equal(v.last().closes, 2,
    'a PINNED window ignores Escape — it is a window, not an interruption')
  await inAct(() => { click(v.last().overlay!) })
  assert.equal(v.last().closes, 2, 'and it has no backdrop left to click')
  // its own close button still closes it
  await inAct(() => { click(v.el.querySelector('.modalpin-x')!) })
  assert.equal(v.last().closes, 3)
  // ...and closing does NOT unpin: the window remembers where it was put
  assert.equal(isModalPinned('org-inbox'), true)
  await v.unmount()
  reset()
})

test('§4b a click inside the panel never reaches the backdrop', async () => {
  reset()
  const v = await mount()
  await inAct(() => { click(v.el.querySelector('.counter')!) })
  assert.equal(v.last().closes, 0, 'the stopPropagation every panel had is kept')
  assert.equal(v.last().count, '1', 'and the click still did its own job')
  await v.unmount()
  reset()
})

// ======================================================= §5 drag and resize
test('§5 dragging the title bar moves the window, and commits ONCE', async () => {
  reset()
  const restore = stubPointerCapture()
  const v = await mount()
  await toggle(v.el)
  const bar = v.el.querySelector('.modalpin-bar')!
  const start = readModalPins()['org-inbox']!.rect

  await inAct(() => { bar.dispatchEvent(pointer('pointerdown', 300, 300)) })
  await inAct(() => { bar.dispatchEvent(pointer('pointermove', 380, 350)) })
  assert.equal(readModalPins()['org-inbox']!.rect.x, start.x,
    'nothing is written to storage mid-gesture — one commit per gesture')
  assert.equal(v.last().rect!.left, `${start.x + 80}px`,
    'but the window follows the pointer live, 1:1, with no zoom to divide out')
  await inAct(() => { bar.dispatchEvent(pointer('pointerup', 380, 350)) })
  await flush()
  assert.deepEqual(readModalPins()['org-inbox']!.rect,
    { ...start, x: start.x + 80, y: start.y + 50 }, 'and commits at pointer-up')

  // a CLICK on the bar (no movement past the 3px threshold) is not a move
  const held = readModalPins()['org-inbox']!.rect
  await inAct(() => { bar.dispatchEvent(pointer('pointerdown', 100, 100)) })
  await inAct(() => { bar.dispatchEvent(pointer('pointermove', 101, 101)) })
  await inAct(() => { bar.dispatchEvent(pointer('pointerup', 101, 101)) })
  await flush()
  assert.deepEqual(readModalPins()['org-inbox']!.rect, held,
    'a click on the title bar raises; it never repositions the window')

  // Escape CANCELS a drag instead of closing anything
  await inAct(() => { bar.dispatchEvent(pointer('pointerdown', 200, 200)) })
  await inAct(() => { bar.dispatchEvent(pointer('pointermove', 260, 240)) })
  await inAct(() => { key('Escape') })
  await flush()
  assert.deepEqual(readModalPins()['org-inbox']!.rect, held, 'the cancelled drag wrote nothing')
  assert.equal(v.last().rect!.left, `${held.x}px`, 'and the window snapped back')
  assert.equal(v.last().closes, 0, 'the Escape that cancelled a drag closed nothing')
  restore()
  await v.unmount()
  reset()
})

test('§5b resizing from the west edge pins the east one', async () => {
  reset()
  const restore = stubPointerCapture()
  const v = await mount()
  await toggle(v.el)
  const r0 = readModalPins()['org-inbox']!.rect
  const w = v.el.querySelector('.modalpin-rs.w')!
  // drag the west edge far past the minimum width: the east edge must not move
  await inAct(() => { w.dispatchEvent(pointer('pointerdown', 100, 400)) })
  await inAct(() => { w.dispatchEvent(pointer('pointermove', 900, 400)) })
  await inAct(() => { w.dispatchEvent(pointer('pointerup', 900, 400)) })
  await flush()
  const r1 = readModalPins()['org-inbox']!.rect
  assert.equal(r1.w, PIN_MIN_W, 'the floor holds')
  assert.equal(r1.x + r1.w, r0.x + r0.w,
    'and the window did not walk east across the screen while shrinking')
  restore()
  await v.unmount()
  reset()
})

// ==================================================== §6 living beside others
test('§6 two pinned surfaces coexist, and raising one puts it on top', async () => {
  reset()
  const a = await mountView(frame('org-inbox'), shot)
  const b = await mountView(frame('docket'), shot)
  await inAct(() => { click(a.el.querySelector('.modalpin-btn')!) })
  await inAct(() => { click(b.el.querySelector('.modalpin-btn')!) })
  await flush()
  assert.equal(a.last().pinned && b.last().pinned, true)
  assert.equal(a.last().z, String(MODAL_Z_BASE))
  assert.equal(b.last().z, String(MODAL_Z_BASE + 3), 'the newer window is on top')
  // a pointerdown anywhere in the older window raises it
  await inAct(() => { a.last().panel!.dispatchEvent(pointer('pointerdown', 90, 90)) })
  await flush()
  assert.equal(a.last().z, String(MODAL_Z_BASE + 3))
  assert.equal(b.last().z, String(MODAL_Z_BASE), 'and the other one drops back')
  await a.unmount(); await b.unmount()
  reset()
})

test('§6b closeIfCentred: a jump closes a centred panel and spares a pinned one', () => {
  reset()
  let n = 0
  closeIfCentred('docket', () => { n += 1 })
  assert.equal(n, 1, 'centred, the panel gets out of the way of what it opened')
  pinModal('docket', { x: 0, y: 0, w: 500, h: 400 })
  closeIfCentred('docket', () => { n += 1 })
  assert.equal(n, 1, 'pinned, it stays — it covers nothing and the user placed it')
  // and it is per-surface, not a global switch
  closeIfCentred('gallery', () => { n += 1 })
  assert.equal(n, 2)
  reset()
})

// ============================== §7 two mount sites, two windows, one component
// ⚠ THE ONE SURFACE IN THIS APP WITH TWO MOUNT SITES. DocReader is opened by
// the canvas AND by the docket, and both can be on screen at once — so a pin
// identity that came from the COMPONENT rather than the MOUNT SITE made the
// two readers one window: same rect, same z, neither movable, raisable or
// resizable apart from the other. Found by codex-delivery in a real browser
// with two real readers, 2026-09-06; this is the identity half of it, which is
// where the bug actually lived. The geometry half is the browser's to answer.
test('§7 two readers open at once are two windows, not one', async () => {
  reset()
  // ⚠ THE REAL DocReader, TWICE, exactly as its two mount sites render it:
  // the canvas passes no `pinKind` at all (its identity stays the original
  // `doc`, so pins stored before this fix still open where they were left) and
  // the docket passes its own. Mounting PinFrame directly with two literal
  // kinds would only prove the STORE can hold two keys, which was never in
  // doubt — the defect was one component handing both windows one identity.
  const reader = (pinKind?: string) => (
    <DocReader slug="probe" docId="d1" toast={noop} pinKind={pinKind}
      close={() => { closes.n += 1 }} />
  )
  const a = await mountView(reader(), shot)
  const b = await mountView(reader('doc-docket'), shot)
  await inAct(() => { click(a.el.querySelector('.modalpin-btn')!) })
  await inAct(() => { click(b.el.querySelector('.modalpin-btn')!) })
  await flush()

  // CONTROL FIRST: this check is worthless unless BOTH are really pinned.
  assert.equal(a.last().pinned, true, 'the canvas reader pinned')
  assert.equal(b.last().pinned, true, 'the docket reader pinned')

  const pins = readModalPins()
  assert.deepEqual(Object.keys(pins).sort(), ['doc', 'doc-docket'],
    'two windows in the store, not one shared entry')

  // independent geometry: moving one leaves the other exactly where it was
  const before = { ...pins['doc-docket']!.rect }
  commitModalRect('doc', { x: 111, y: 222, w: 640, h: 480 })
  await flush()
  const after = readModalPins()
  assert.deepEqual(after['doc']!.rect, { x: 111, y: 222, w: 640, h: 480 })
  assert.deepEqual(after['doc-docket']!.rect, before,
    'the docket reader did not move when the canvas reader did')

  // independent stacking: raising one puts it above the other, both ways
  assert.equal(b.last().z, String(MODAL_Z_BASE + 3), 'the newer one starts on top')
  await inAct(() => { a.last().panel!.dispatchEvent(pointer('pointerdown', 90, 90)) })
  await flush()
  assert.equal(a.last().z, String(MODAL_Z_BASE + 3), 'and the older one can be raised')
  assert.equal(b.last().z, String(MODAL_Z_BASE))

  // independent persistence: closing one leaves the other's window on record
  unpinModal('doc')
  await flush()
  assert.equal(isModalPinned('doc'), false)
  assert.equal(isModalPinned('doc-docket'), true,
    'unpinning one reader did not unpin the other')
  await a.unmount(); await b.unmount()
  reset()
})

// ================= §8 what is NOT a title had to leave the heading first
// Pinned, a panel's own title <h3> is hidden — the window's title bar says the
// same words. So anything that was ALSO living in that h3 and is not a title
// would have vanished with it: the default settings' scope line, the watchdog's
// live state and one-shot label, the agent config's process lifecycle mark, the
// disk browser's mode tabs and close button. Astra 2026-09-06 required those to
// stay visible in BOTH modes, so they moved out of the heading.
//
// ⚠ WHAT THIS CHECK IS AND IS NOT. jsdom applies no stylesheet, so it cannot
// see `display: none` and cannot tell you a thing about what is on screen. What
// it CAN answer is the question the fix actually turns on — whether the text is
// still INSIDE the element that stands down — and it goes red the moment
// anybody puts it back. The visible half is the browser probe's `title` check.
test('§8 a panel\'s live state is not inside the heading that hides when pinned', async () => {
  reset()
  const dog: Watchdog = {
    id: 'w1', owner: 'agent', name: 'build-watch', kind: 'file',
    target: 'C:/x/build.log', interval_s: 30, state: 'armed',
    at: '2026-09-06T09:00:00Z', fired: 0, once: true,
  } as Watchdog
  const v = await mountView(
    <WatchdogPanel slug="probe" dog={dog} toast={noop} close={noop} />,
    (host: HTMLElement) => ({
      h3: host.querySelector('.overlay > div > h3'),
      panel: host.querySelector<HTMLElement>('.overlay > div'),
    }))
  await flush()
  const { h3, panel } = v.last()
  // CONTROL: the panel and its heading are really there, and the heading is
  // really the one the CSS hides (the panel's own first h3). Without this the
  // assertions below would pass on an empty render.
  assert.ok(panel, 'the watchdog panel rendered')
  assert.ok(h3, 'it has the title h3 the pinned mode hides')
  assert.match(h3!.textContent ?? '', /build-watch/, 'which names the dog')

  const text = panel!.textContent ?? ''
  for (const s of ['armed', 'one-shot dog']) {
    assert.ok(text.includes(s), `the panel still shows ${s!}`)
    assert.equal((h3!.textContent ?? '').includes(s), false,
      `${s} is NOT inside the heading that hides when pinned`)
  }
  await v.unmount()
  reset()
})
