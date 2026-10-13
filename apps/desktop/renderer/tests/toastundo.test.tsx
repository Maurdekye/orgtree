import { inAct, mountView } from './harness'
import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import { createPortal } from 'react-dom'
import { createToast, ToastStack } from '../src/toasts'
import type { Toast } from '../src/toasts'

// jsdom has no layout. Supply visible rectangles explicitly; hidden/outside
// controls below override them to prove the on-screen gate is exercised.
const RECT = { x: 20, y: 20, left: 20, top: 20, right: 80, bottom: 40, width: 60, height: 20, toJSON: () => ({}) }
function shown(t: TestContext, doc: Document) {
  const old = Object.getOwnPropertyDescriptor(doc, 'hidden')
  Object.defineProperty(doc, 'hidden', { configurable: true, value: false })
  t.after(() => { if (old) Object.defineProperty(doc, 'hidden', old); else Reflect.deleteProperty(doc, 'hidden') })
}
function layout(doc: Document) {
  for (const button of doc.querySelectorAll('.toast-undo')) {
    button.getBoundingClientRect = () => RECT as DOMRect
    button.getClientRects = () => [RECT] as unknown as DOMRectList
  }
}
async function mount(t: TestContext, toasts: Toast[]) {
  shown(t, document)
  const view = await mountView(<ToastStack toasts={toasts} />, el => el)
  layout(document)
  t.after(() => view.unmount())
  return view.el
}
async function key(target: EventTarget, doc = document, init: KeyboardEventInit = {}) {
  const WindowEvent = (doc.defaultView as unknown as { KeyboardEvent: typeof KeyboardEvent }).KeyboardEvent
  const event = new WindowEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true, ...init })
  await inAct(() => { target.dispatchEvent(event) })
  return event
}

for (const modifier of ['ctrl', 'cmd']) test(`${modifier}+Z consumes the newest Undo and dismisses it, ignoring newer plain notices`, async t => {
  const calls: string[] = [], removed: number[] = []
  const first = createToast(['move'], () => calls.push('move'), id => removed.push(id))
  const second = createToast(['other action'], { fn: () => calls.push('other'), label: 'Restore' }, id => removed.push(id))
  await mount(t, [first, second, createToast(['notice'], null, () => {})])
  assert.equal(document.querySelectorAll('.toast-undo')[1]?.textContent, 'Restore')
  const event = await key(window, document, { ctrlKey: modifier === 'ctrl', metaKey: modifier === 'cmd' })
  assert.equal(event.defaultPrevented, true)
  assert.deepEqual(calls, ['other']); assert.deepEqual(removed, [second.id])
  assert.equal(second.available(), false)
  // Simulate the key/click arriving before a removal commit: the callback is consumed.
  await inAct(() => (document.querySelectorAll('.toast-undo')[1] as HTMLButtonElement).click())
  assert.deepEqual(calls, ['other'])
})

test('a click and shortcut share consumption; a second deliberate shortcut reaches the remaining Undo', async t => {
  const calls: string[] = []
  const toasts = [createToast(['older'], () => calls.push('older'), () => {}), createToast(['newer'], () => calls.push('newer'), () => {})]
  await mount(t, toasts)
  await inAct(() => (document.querySelectorAll('.toast-undo')[1] as HTMLButtonElement).click())
  await key(window)
  assert.deepEqual(calls, ['newer', 'older'])
  assert.equal((await key(window)).defaultPrevented, false)
})

test('dismissed and expired toasts cannot undo, even if their DOM or timer is stale', async t => {
  let now = 1000, calls = 0
  t.mock.method(Date, 'now', () => now)
  const dismissed = createToast(['dismiss me'], () => calls++, () => {})
  const expired = createToast(['expires'], () => calls++, () => {})
  await mount(t, [dismissed, expired])
  dismissed.dismiss(); now = 13000
  assert.equal((await key(window)).defaultPrevented, false)
  await inAct(() => (document.querySelectorAll('.toast-undo')[1] as HTMLButtonElement).click())
  assert.equal(calls, 0)
})

test('no Undo or no toast leaves Ctrl+Z untouched', async t => {
  await mount(t, [createToast(['notice'], null, () => {})])
  assert.equal((await key(window)).defaultPrevented, false)
})

for (const html of ['<input>', '<textarea></textarea>', '<select><option>x</option></select>',
  '<div contenteditable="true"><span tabindex="0">text</span></div>', '<div contenteditable="plaintext-only" tabindex="0">text</div>',
  '<div role="textbox" tabindex="0">text</div>', '<div class="monaco-editor"><div tabindex="0">text</div></div>',
  '<div class="cm-editor"><div tabindex="0">text</div></div>', '<div class="CodeMirror"><div tabindex="0">text</div></div>']) {
  test(`native text/editor undo stays untouched: ${html}`, async t => {
    let calls = 0
    const el = await mount(t, [createToast(['move'], () => calls++, () => {})])
    const host = document.createElement('div'); host.innerHTML = html; el.append(host)
    const focus = (host.querySelector('[tabindex]') ?? host.firstElementChild) as HTMLElement
    focus.focus()
    assert.equal((await key(focus)).defaultPrevented, false)
    // A window-dispatched event still respects the actual focused editor.
    assert.equal((await key(window)).defaultPrevented, false)
    assert.equal(calls, 0)
  })
}

test('text undo inside a shadow editor is preserved', async t => {
  let calls = 0
  const el = await mount(t, [createToast(['move'], () => calls++, () => {})])
  const host = document.createElement('div'); el.append(host)
  const shadow = host.attachShadow({ mode: 'open' }); const input = document.createElement('input'); shadow.append(input); input.focus()
  assert.equal((await key(input, document, { composed: true })).defaultPrevented, false)
  assert.equal(calls, 0)
})

test('redo, repeats, composition, Alt and handled events do not consume Undo', async t => {
  let calls = 0
  await mount(t, [createToast(['move'], () => calls++, () => {})])
  for (const init of [{ key: 'y' }, { shiftKey: true }, { repeat: true }, { isComposing: true }, { altKey: true }, { ctrlKey: false }]) {
    assert.equal((await key(window, document, init)).defaultPrevented, false)
  }
  const handled = (event: Event) => event.preventDefault()
  document.addEventListener('keydown', handled); t.after(() => document.removeEventListener('keydown', handled))
  assert.equal((await key(document.body)).defaultPrevented, true)
  assert.equal(calls, 0)
})

test('only on-screen Undo is eligible; hidden window, hidden stack and outside viewport do nothing', async t => {
  let calls = 0
  const el = await mount(t, [createToast(['move'], () => calls++, () => {})])
  el.style.display = 'none'; assert.equal((await key(window)).defaultPrevented, false); el.style.display = ''
  const button = el.querySelector('.toast-undo') as HTMLButtonElement
  button.getBoundingClientRect = () => ({ ...RECT, top: -100, bottom: -80 }) as DOMRect
  assert.equal((await key(window)).defaultPrevented, false)
  layout(document); Object.defineProperty(document, 'hidden', { configurable: true, value: true })
  assert.equal((await key(window)).defaultPrevented, false)
  assert.equal(calls, 0)
})

test('popout uses its own keyboard, visibility and focus; a toast shown only there is not undone in main', async t => {
  const child = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost/' })
  const doc = child.window.document
  shown(t, doc); shown(t, document)
  let calls = 0
  const toast = createToast(['move'], () => calls++, () => {})
  const view = await mountView(<>{createPortal(<ToastStack toasts={[toast]} />, doc.body)}</>, el => el)
  layout(doc)
  assert.equal((await key(window)).defaultPrevented, false)
  const input = doc.createElement('input'); doc.body.append(input); input.focus()
  assert.equal((await key(child.window, doc)).defaultPrevented, false)
  input.blur()
  assert.equal((await key(child.window, doc, { ctrlKey: false, metaKey: true })).defaultPrevented, true)
  assert.equal(calls, 1)
  await view.unmount(); child.window.close()
})

test('mirrors share once-only Undo and listeners are removed on unmount', async t => {
  const child = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost/' })
  const doc = child.window.document; shown(t, doc); shown(t, document)
  let calls = 0
  const toast = createToast(['move'], () => calls++, () => {})
  const view = await mountView(<><ToastStack toasts={[toast]} />{createPortal(<ToastStack toasts={[toast]} />, doc.body)}</>, el => el)
  layout(document); layout(doc)
  await inAct(() => {
    window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'z', ctrlKey: true, cancelable: true }))
    child.window.dispatchEvent(new child.window.KeyboardEvent('keydown', { key: 'z', ctrlKey: true, cancelable: true }))
  })
  assert.equal(calls, 1)
  await view.unmount()
  assert.equal((await key(window)).defaultPrevented, false)
  assert.equal((await key(child.window, doc)).defaultPrevented, false)
  child.window.close()
})
