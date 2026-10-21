// Install the DOM before react-dom detects native input-event support.
import { flush, inAct, JSDOM, mountView } from './harness'
import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { createPortal } from 'react-dom'
import { RegisterMenu } from '../src/canvas/registermenu'
import { projectListenerState } from '../src/canvas/listeners'
import { SurfaceDocumentOwner } from '../src/popout'
import type { CanvasNode, OpRequest } from '../src/canvas/shared'

async function popupMenu(t: TestContext) {
  // React creates new portal controls in this document, just as it does after
  // MovableSurface adopts the surface/overlay into a popped-out window.
  const popup = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' })
  const doc = popup.window.document
  const requests: OpRequest[] = []
  const node = { id: 'sync', kind: 'project', tier: 'project', state: 'live', children: [] } as unknown as CanvasNode
  const view = await mountView(<SurfaceDocumentOwner owner={doc}>{createPortal(
    <RegisterMenu node={node} state={projectListenerState('sync', [])}
      op={async req => { requests.push(req); return {} }} />, doc.body,
  )}</SurfaceDocumentOwner>, el => el)
  t.after(async () => { await view.unmount(); popup.window.close() })
  const trigger = doc.querySelector<HTMLButtonElement>('[data-action="register-menu"]')!
  assert.ok(trigger, 'positive control: trigger mounted in popup')
  assert.equal(trigger.ownerDocument === doc, true)
  assert.equal(trigger instanceof Node, false, 'fixture has a different DOM realm from the opener')
  assert.equal(trigger instanceof popup.window.Node, true)
  const down = async (el: Element) => inAct(async () => {
    el.dispatchEvent(new popup.window.MouseEvent('pointerdown', { bubbles: true, button: 0 }))
    await flush(1)
  })
  const click = async (el: HTMLButtonElement) => {
    await down(el)
    await inAct(async () => {
      if (el.isConnected) {
        el.dispatchEvent(new popup.window.MouseEvent('pointerup', { bubbles: true, button: 0 }))
        el.click()
      }
      await flush(2)
    })
  }
  const panel = () => doc.querySelector<HTMLElement>('.register-panel')
  await click(trigger)
  assert.ok(panel(), 'positive control: Register opened in popup')
  assert.equal(panel()!.ownerDocument === doc, true)
  return { popup, doc, requests, trigger, panel, down, click }
}

for (const once of [true, false]) test(`popup Register ${once ? 'one-time' : 'continuous'} action survives pointerdown before click`, async t => {
  const p = await popupMenu(t)
  const button = p.panel()!.querySelector<HTMLButtonElement>(`[data-action="register-${once ? 'once' : 'continuous'}"]`)!
  await p.click(button)
  assert.deepEqual(p.requests, [{ op: 'user_listener_register', node: 'sync', once }])
  assert.equal(p.panel() === null, true, 'an accepted action closes the menu')
})

test('popup Register count input and inside wheel stay open, then register the chosen watch', async t => {
  const p = await popupMenu(t)
  const input = p.panel()!.querySelector<HTMLInputElement>('input[type="number"]')!
  await p.down(input)
  assert.equal(input.isConnected, true, 'pointerdown on its input must not unmount the menu')
  await inAct(async () => {
    input.focus()
    Object.getOwnPropertyDescriptor(p.popup.window.HTMLInputElement.prototype, 'value')!.set!.call(input, '7')
    input.dispatchEvent(new p.popup.window.Event('input', { bubbles: true }))
    input.dispatchEvent(new p.popup.window.WheelEvent('wheel', { bubbles: true }))
    await flush(1)
  })
  assert.equal(p.panel() !== null, true, 'wheel on an inside control stays inside')
  assert.equal(input.value, '7')
  await p.click(p.panel()!.querySelector<HTMLButtonElement>('[data-action="register-watch"]')!)
  assert.deepEqual(p.requests, [{ op: 'user_watch_register', node: 'sync', count: 7 }])
})

test('popup Register trigger closes on its second complete pointer gesture', async t => {
  const p = await popupMenu(t)
  await p.click(p.trigger)
  assert.equal(p.panel() === null, true, 'pointerdown must not close then let click reopen the menu')
  assert.deepEqual(p.requests, [])
})

test('popup Register still closes on outside pointer, outside wheel and Escape', async t => {
  const p = await popupMenu(t)
  await p.down(p.doc.body)
  assert.equal(p.panel() === null, true)
  await p.click(p.trigger)
  await inAct(() => { p.doc.body.dispatchEvent(new p.popup.window.WheelEvent('wheel', { bubbles: true })) })
  assert.equal(p.panel() === null, true)
  await p.click(p.trigger)
  await inAct(() => { p.doc.dispatchEvent(new p.popup.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
  assert.equal(p.panel() === null, true)
  assert.equal(p.doc.activeElement === p.trigger, true, 'Escape returns focus to the popup trigger')
  assert.deepEqual(p.requests, [])
})
