import { JSDOM } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { installAppShortcuts } from '../src/shell/appshortcuts'
import { installNavigationKeys } from '../src/shell/navigationkeys'

const pointer = (target: EventTarget, type: string, id: number, buttons: number, pointerType = 'mouse') => {
  const event = new window.Event(type, { bubbles: true })
  Object.assign(event, { pointerId: id, buttons, pointerType })
  target.dispatchEvent(event)
}
const arrow = (target: EventTarget = document.body, options: KeyboardEventInit = {}) => {
  const event = new window.KeyboardEvent('keydown', { key: 'ArrowRight', shiftKey: true,
    altKey: true, bubbles: true, cancelable: true, ...options })
  target.dispatchEvent(event)
  return event.defaultPrevented
}

test('navigation recovers when the mouse returns released after a missed pointerup', () => {
  let calls = 0
  const stop = installAppShortcuts(window, () => ({ nextNode: () => { calls++ } }))
  try {
    assert.equal(arrow(), true, 'positive control: navigation starts active')
    pointer(document.body, 'pointerdown', 1, 1)
    assert.equal(arrow(), false, 'a live drag keeps the chord')
    // Release outside this document: the next browser observation proves the
    // same mouse has no buttons held, without a document pointerup or blur.
    pointer(document.body, 'pointermove', 1, 0)
    assert.equal(arrow(), true, 'released mouse must not leave navigation permanently latched')
    assert.equal(calls, 2)
  } finally { window.dispatchEvent(new window.Event('blur')); stop() }
})

test('pointer entry also recovers a missed release, without cancelling another live pointer', () => {
  let calls = 0
  const stop = installAppShortcuts(window, () => ({ nextNode: () => { calls++ } }))
  try {
    pointer(document.body, 'pointerdown', 2, 1)
    pointer(document.body, 'pointerdown', 8, 1, 'touch')
    pointer(document.body, 'pointerover', 2, 0)
    assert.equal(arrow(), false, 'mouse recovery must preserve a separate touch gesture')
    pointer(document.body, 'pointerup', 8, 0, 'touch')
    assert.equal(arrow(), true)
    assert.equal(calls, 1)
  } finally { window.dispatchEvent(new window.Event('blur')); stop() }
})

test('live button movement, cancellation, blur and reinstall preserve gesture ownership', () => {
  let calls = 0
  let stop = installAppShortcuts(window, () => ({ nextNode: () => { calls++ } }))
  try {
    pointer(document.body, 'pointerdown', 3, 1)
    pointer(document.body, 'pointermove', 3, 1)
    assert.equal(arrow(), false)
    pointer(document.body, 'pointercancel', 3, 0)
    assert.equal(arrow(), true)
    pointer(document.body, 'pointerdown', 3, 2)
    window.dispatchEvent(new window.Event('blur'))
    assert.equal(arrow(), true, 'Alt-Tab/window blur already resets a held press')
    pointer(document.body, 'pointerdown', 3, 1)
    stop(); stop = installAppShortcuts(window, () => ({ nextNode: () => { calls++ } }))
    assert.equal(arrow(), true, 'new listener owns no old pointer latch')
    assert.equal(calls, 3)
  } finally { window.dispatchEvent(new window.Event('blur')); stop() }
})

test('composers and overlays yield only while active; modeless panels and released modifiers keep working', () => {
  let calls = 0
  const stop = installAppShortcuts(window, () => ({ nextNode: () => { calls++ } }))
  const host = document.createElement('div'); document.body.append(host)
  try {
    host.innerHTML = '<textarea></textarea>'
    host.querySelector('textarea')!.focus()
    assert.equal(arrow(), false, 'even a body-dispatched chord yields to the active composer')
    host.querySelector('textarea')!.blur()
    assert.equal(arrow(), true)
    for (const markup of ['<div role="menu"></div>', '<div role="dialog" aria-modal="true"></div>',
      '<div class="lb-overlay"></div>', '<div class="picker-overlay"></div>']) {
      host.innerHTML = markup; assert.equal(arrow(), false)
      host.innerHTML = ''; assert.equal(arrow(), true, 'closing the overlay restores its chord')
    }
    host.innerHTML = '<div role="dialog" class="modalpin-win"><button>panel</button></div>'
    host.querySelector('button')!.focus(); assert.equal(arrow(), true, 'pinned modeless panel keeps navigation')
    assert.equal(arrow(document.body, { ctrlKey: true }), false)
    assert.equal(arrow(document.body, { altKey: false }), false)
    assert.equal(arrow(), true, 'modifiers are read per event, not latched')
    assert.equal(calls, 7)
  } finally { host.remove(); stop() }
})

test('detached documents own local navigation listeners without poisoning the main listener', () => {
  const child = new JSDOM('<!doctype html><body><button>desk</button></body>', { url: 'http://localhost/' })
  let main = 0, local = 0
  const stopMain = installAppShortcuts(window, () => ({ nextNode: () => { main++ } }))
  const stopLocal = installNavigationKeys(child.window.document, () => { local++ })
  try {
    pointer(child.window.document.body, 'pointerdown', 4, 1)
    child.window.document.body.dispatchEvent(new child.window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    assert.equal(local, 0)
    pointer(child.window.document.body, 'pointermove', 4, 0)
    child.window.document.body.dispatchEvent(new child.window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    assert.equal(local, 1)
    assert.equal(arrow(), true); assert.equal(main, 1)
  } finally { stopLocal(); child.window.close(); stopMain() }
})
