// Production PinFrame/DeskHost closure paths with a second document. This is
// DOM/bridge evidence; it does not claim installed Electron/OS key handling.
import { flush, inAct, mountView } from './harness'
import { installBridge, removeBridge } from './shellbridge'
import test from 'node:test'
import assert from 'node:assert/strict'
import { useState } from 'react'
import { JSDOM } from 'jsdom'
import { CurrentOrg, MovableSurface, PopoutButton } from '../src/popout'
import { PinFrame, forgetModalPins, forgetModalOpenCache } from '../src/canvas/modalpin'
import { DeskHosts, DeskSlot } from '../src/canvas/deskhosts'
import type { CanvasNode } from '../src/canvas/shared'
import { beginWindowExit, endWindowExit, savedWindows } from '../src/windowlayout'
import { openSurfaces, resetActionDocument, returnWindows } from '../src/windowlife'

function stage() {
  localStorage.clear(); forgetModalPins(); forgetModalOpenCache(); resetActionDocument(); endWindowExit()
  const dom = new JSDOM('<html><head></head><body></body></html>', { url: 'http://localhost/' })
  const w = dom.window as unknown as Window
  Object.defineProperties(w, { screenX: { value: 200 }, screenY: { value: 180 }, outerWidth: { value: 830 }, outerHeight: { value: 700 }, closed: { value: false, writable: true } })
  w.focus = () => {}; w.requestAnimationFrame = () => 1; w.cancelAnimationFrame = () => {}
  const nativeClose = () => { (w as unknown as { closed: boolean }).closed = true; w.dispatchEvent(new dom.window.Event('pagehide')) }
  const originalClose = w.close.bind(w)
  w.close = nativeClose
  const originalOpen = window.open
  window.open = (() => w) as typeof window.open
  const originalObserver = globalThis.MutationObserver
  globalThis.MutationObserver = dom.window.MutationObserver
  installBridge({ minimizePopout: async () => {}, toggleMaximizePopout: async () => {}, closePopout: async () => nativeClose() })
  return { w, nativeClose, tidy: () => {
    removeBridge(); window.open = originalOpen; globalThis.MutationObserver = originalObserver
    originalClose(); localStorage.clear(); endWindowExit(); resetActionDocument()
  } }
}
async function click(el: Element | null) {
  assert.ok(el, 'positive control: the actual action exists')
  await inAct(async () => { (el as HTMLElement).click(); await flush(5) })
}
const button = (doc: Document | HTMLElement, label: string) => doc.querySelector(`button[aria-label="${label}"]`)
const row = (kind: string) => savedWindows().find(r => r.kind === kind)
const noWindows = () => assert.equal(openSurfaces().length, 0, 'all native registrations cleaned')

for (const route of ['header', 'pagehide', 'poll'] as const) {
  test(`modal ${route} Close dismisses once, saves closed geometry and keeps the draft`, async () => {
    const s = stage(); let closes = 0
    function Modal() {
      const [visible, setVisible] = useState(true)
      return <CurrentOrg.Provider value="org">{visible && <PinFrame kind="close-fixture" title="Fixture" panel="settings"
        close={() => { closes++; setVisible(false) }}><input aria-label="draft" defaultValue="kept draft" /></PinFrame>}</CurrentOrg.Provider>
    }
    const v = await mountView(<Modal />, el => el)
    try {
      await click(button(v.el, 'Open in new window'))
      const input = s.w.document.querySelector<HTMLInputElement>('input')!
      assert.equal(input.value, 'kept draft'); assert.equal(row('close-fixture')?.open, true)
      if (route === 'header') await click(button(s.w.document, 'Close window'))
      else await inAct(async () => {
        if (route === 'pagehide') s.nativeClose()
        else (s.w as unknown as { closed: boolean }).closed = true
        await new Promise(resolve => setTimeout(resolve, 300)); await flush(5)
      })
      assert.equal(closes, 1, 'owner close called once')
      assert.equal(v.el.querySelector('input'), null, 'modal never returns to main')
      assert.equal(document.querySelector('.popout-recovery'), null)
      assert.equal(input.value, 'kept draft', 'dismissal does not erase content')
      assert.equal(row('close-fixture')?.open, false)
      assert.deepEqual(row('close-fixture')?.rect, { x: 200, y: 180, width: 830, height: 700 })
      noWindows()
    } finally { await v.unmount(); s.tidy() }
  })
}

test('modal explicit Pop in returns the SAME input once without dismissing', async () => {
  const s = stage(); let closes = 0
  const v = await mountView(<CurrentOrg.Provider value="org"><PinFrame kind="close-fixture" title="Fixture" panel="settings"
    close={() => closes++}><input defaultValue="kept draft" /></PinFrame></CurrentOrg.Provider>, el => el)
  try {
    await click(button(v.el, 'Open in new window'))
    const input = s.w.document.querySelector('input')!
    await click(button(s.w.document, 'Return to main window'))
    assert.ok(v.el.contains(input)); assert.equal(closes, 0); assert.equal(row('close-fixture')?.open, false); noWindows()
  } finally { await v.unmount(); s.tidy() }
})

test('returnWindows and main-window exit preserve restoration instead of dismissing the modal', async () => {
  for (const exit of [false, true]) {
    const s = stage(); let closes = 0
    const v = await mountView(<CurrentOrg.Provider value="org"><PinFrame kind="close-fixture" title="Fixture" panel="settings"
      close={() => closes++}><input defaultValue="draft" /></PinFrame></CurrentOrg.Provider>, el => el)
    try {
      await click(button(v.el, 'Open in new window')); const input = s.w.document.querySelector('input')!
      await inAct(async () => { if (exit) { beginWindowExit(); s.nativeClose() } else returnWindows('org'); await flush(5) })
      assert.ok(v.el.contains(input)); assert.equal(closes, 0)
      assert.equal(row('close-fixture')?.open, exit, 'exit preserves the open arrangement'); noWindows()
    } finally { await v.unmount(); s.tidy() }
  }
})

test('temporary borrow still preserves the open row and restores the same content', async () => {
  const s = stage(); let closes = 0
  const v = await mountView(<MovableSurface kind="borrow-fixture" title="Borrow" org="org" onDismiss={() => closes++}>
    <input defaultValue="draft" /><PopoutButton /></MovableSurface>, el => el)
  try {
    await click(button(v.el, 'Open in new window')); const input = s.w.document.querySelector('input')!
    const borrowed = openSurfaces()[0].borrow!()
    await inAct(async () => { await flush(5) })
    assert.ok(v.el.contains(input)); assert.equal(row('borrow-fixture')?.open, true); assert.equal(closes, 0)
    ;(s.w as unknown as { closed: boolean }).closed = false
    await inAct(async () => { borrowed.restore(); await flush(5) })
    assert.equal(s.w.document.querySelector('input'), input); assert.equal(closes, 0)
  } finally { await v.unmount(); s.tidy() }
})

for (const explicit of [false, true]) {
  test(`production DeskHost with no slot: ${explicit ? 'Pop in activates its destination' : 'native Close does not activate or create a main surface'}`, async () => {
    const s = stage(); let jumps = 0
    const node = { id: 'writer', generation: 3, tier: 'opus', charter: 'write', state: 'live', children: [], turns: [], seat: 1, grant: 0, free: 0, tasks: 0 } as unknown as CanvasNode
    const map = new Map([[node.id, node]])
    const view = (slot: boolean) => <DeskHosts map={map} slug="org">{slot && <DeskSlot node={node} map={map} slug="org"
      op={async () => ({})} toast={() => {}} pub={false} onJump={() => jumps++} />}</DeskHosts>
    const v = await mountView(view(true), el => el)
    try {
      await click(button(v.el, 'Open in new window'))
      const composer = s.w.document.querySelector('textarea')!
      assert.ok(composer, 'the real desk composer is mounted')
      await v.render(view(false)); await inAct(async () => { await flush(5) })
      assert.equal(openSurfaces().length, 1, 'no-slot desk remains in its window')
      if (explicit) await click(button(s.w.document, 'Return to main window'))
      else await inAct(async () => { s.nativeClose(); await flush(5) })
      assert.equal(jumps, explicit ? 1 : 0)
      assert.equal(!!document.querySelector('.popout-recovery'), explicit)
      noWindows()
      if (!explicit) {
        await v.render(view(true)); await inAct(async () => { await flush(5) })
        assert.equal(v.el.querySelector('textarea'), composer, 'registered destination receives SAME retained composer')
      }
    } finally { await v.unmount(); s.tidy() }
  })
}
