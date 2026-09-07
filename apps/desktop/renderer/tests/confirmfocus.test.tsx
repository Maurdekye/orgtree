// confirmfocus.test.tsx — ConfirmModal's keyboard contract (incremental-UX
// item 6, 2026-09-04).
//
// The committed popup left keyboard focus on the button that opened it: the
// next Tab went to a background control, nothing announced a dialog, and
// closing it moved focus nowhere in particular. This suite drives the REAL
// component in jsdom and proves, at the DOM layer:
//   §1  the box is a role=dialog, aria-modal, NAMED by its title and
//       described by its body (and not described by nothing when there is
//       no body)
//   §2  focus moves INTO the dialog on open — onto cancel, the safe control
//   §3  Tab / Shift+Tab cycle through the dialog's buttons, wrapping, with
//       the optional alternate action in the cycle
//   §4  a button disabled while open drops out of the cycle; one a re-render
//       adds joins it — the cycle is computed at each keypress
//   §5  closing returns focus to the opener when it still exists; not when
//       it was removed; and NOT when the action focused something itself
//   §6  the document Tab handler is gone after unmount (no stale trap)
//   §7  Escape still closes, exactly once
//
// WHAT jsdom CANNOT PROVE, and where that lives instead. jsdom has no
// sequential focus navigation: a Tab keydown here moves focus ONLY if our
// handler moves it, which is what makes §3 a measurement rather than theatre
// — but it also means jsdom can never show that focus would have LEFT the
// dialog without the handler. Real Tab presses in a real browser, against the
// real stylesheet, are `confirmfocus_probe.py`'s job; it is red on the
// committed component and green on this one, and rejects nine mutants.
//
// Run:  cd frontend && node tests/run.mjs confirmfocus

import { mountView, realClock } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { act } from 'react'
import { ConfirmModal } from '../src/canvas/modals'

realClock()

const doc = () => document
const body = () => document.body

const box = () => document.querySelector<HTMLElement>('.confirm-box')
const buttons = () => Array.from(box()!.querySelectorAll('button'))
const button = (label: string) =>
  buttons().find((b) => b.textContent === label) as HTMLButtonElement
const active = () => document.activeElement
const name = () => {
  const el = active()
  if (!el || el === body()) return 'body'
  if (el.id) return '#' + el.id
  return (box()?.contains(el) ? 'dialog>' : '') + el.tagName.toLowerCase()
    + (el.textContent ? ':' + el.textContent : '')
}

/** a Tab keydown at the document, the way one bubbles up from the focused
 *  element in a browser. Returns whether the dialog consumed it. */
const tab = async (shift = false) => {
  const e = new KeyboardEvent('keydown', { key: 'Tab', shiftKey: shift,
    bubbles: true, cancelable: true })
  await act(async () => { (active() ?? body()).dispatchEvent(e) })
  return e.defaultPrevented
}
const escape = async () => {
  await act(async () => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
  })
}

/** an opener button on the page, focused — what the component sees on mount */
function opener(): HTMLButtonElement {
  document.querySelectorAll('#opener, #elsewhere').forEach((n) => n.remove())
  const b = document.createElement('button')
  b.id = 'opener'
  b.textContent = 'open'
  body().appendChild(b)
  const other = document.createElement('button')
  other.id = 'elsewhere'
  body().appendChild(other)
  b.focus()
  assert.equal(name(), '#opener', 'precondition: the opener holds focus')
  return b
}

interface Calls { close: number; confirm: number; alt: number; order: string[] }
const calls = (): Calls => ({ close: 0, confirm: 0, alt: 0, order: [] })

function modal(c: Calls, opts: { body?: string; alt?: boolean; onConfirm?: () => void } = {}) {
  return <ConfirmModal title="delete it?" body={opts.body}
    confirmLabel="delete"
    onConfirm={() => { c.confirm++; c.order.push('confirm'); opts.onConfirm?.() }}
    close={() => { c.close++; c.order.push('close') }}
    {...(opts.alt ? { altLabel: 'alternate',
      onAlt: () => { c.alt++; c.order.push('alt') } } : {})} />
}

test('§1 the box is a labelled, described, modal dialog', async () => {
  opener()
  const c = calls()
  const v = await mountView(modal(c, { body: 'gone for good' }), () => box())
  const d = box()!
  assert.equal(d.getAttribute('role'), 'dialog')
  assert.equal(d.getAttribute('aria-modal'), 'true')
  assert.equal(doc().querySelectorAll('[role=dialog]').length, 1)
  const labelId = d.getAttribute('aria-labelledby')
  assert.ok(labelId, 'aria-labelledby is set')
  const label = doc().getElementById(labelId!)
  assert.equal(label?.tagName, 'H3')
  assert.equal(label?.textContent, 'delete it?')
  const descId = d.getAttribute('aria-describedby')
  assert.ok(descId, 'aria-describedby is set when there is a body')
  assert.equal(doc().getElementById(descId!)?.textContent, 'gone for good')
  await v.unmount()

  // no body → no describedby pointing at nothing
  opener()
  const v2 = await mountView(modal(c), () => box())
  assert.equal(box()!.hasAttribute('aria-describedby'), false)
  assert.equal(box()!.getAttribute('role'), 'dialog')
  await v2.unmount()
})

test('§2 focus moves into the dialog, onto cancel', async () => {
  opener()
  const c = calls()
  const v = await mountView(modal(c), () => box())
  assert.equal(name(), 'dialog>button:cancel')
  assert.equal(active(), button('cancel'))
  assert.notEqual(active()?.id, 'opener', 'the opener no longer holds focus')
  await v.unmount()
})

test('§3 Tab and Shift+Tab cycle inside the dialog, alternate included', async () => {
  opener()
  const c = calls()
  const v = await mountView(modal(c), () => box())
  // two buttons: cancel -> delete -> cancel, and back
  assert.equal(await tab(), true, 'the dialog consumed the Tab')
  assert.equal(name(), 'dialog>button:delete')
  await tab(); assert.equal(name(), 'dialog>button:cancel')
  await tab(true); assert.equal(name(), 'dialog>button:delete')
  await tab(true); assert.equal(name(), 'dialog>button:cancel')
  await v.unmount()

  // three buttons: delete -> alternate -> cancel -> delete
  opener()
  const v3 = await mountView(modal(c, { alt: true }), () => box())
  const walk: string[] = []
  for (let i = 0; i < 4; i++) { await tab(); walk.push(name()) }
  assert.deepEqual(walk, ['dialog>button:delete', 'dialog>button:alternate',
    'dialog>button:cancel', 'dialog>button:delete'])
  const back: string[] = []
  for (let i = 0; i < 2; i++) { await tab(true); back.push(name()) }
  assert.deepEqual(back, ['dialog>button:cancel', 'dialog>button:alternate'])
  await v3.unmount()
})

test('§3b a Tab with focus outside the dialog lands in it', async () => {
  opener()
  const c = calls()
  const v = await mountView(modal(c), () => box())
  // focus fell to <body> (the control it sat on vanished, say)
  ;(active() as HTMLElement).blur()
  assert.equal(name(), 'body')
  await tab(); assert.equal(name(), 'dialog>button:delete', 'Tab: first control')
  ;(active() as HTMLElement).blur()
  await tab(true); assert.equal(name(), 'dialog>button:cancel', 'Shift+Tab: last control')
  await v.unmount()
})

test('§4 the cycle is computed per keypress: disabled and re-rendered controls', async () => {
  opener()
  const c = calls()
  const v = await mountView(modal(c, { alt: true }), () => box())
  // disable the first button: Tab from cancel must skip it, not stick on it
  button('delete').disabled = true
  await tab(); assert.equal(name(), 'dialog>button:alternate')
  await tab(true); assert.equal(name(), 'dialog>button:cancel')
  button('delete').disabled = false
  await tab(); assert.equal(name(), 'dialog>button:delete')
  // a re-render REMOVES the alternate: from delete, Tab goes straight to cancel
  await v.render(modal(c))
  assert.equal(buttons().length, 2)
  await tab(); assert.equal(name(), 'dialog>button:cancel')
  // ...and ADDS it back: from cancel, Shift+Tab finds the new button
  await v.render(modal(c, { alt: true }))
  assert.equal(buttons().length, 3)
  await tab(true); assert.equal(name(), 'dialog>button:alternate')
  await v.unmount()
})

test('§5 focus returns to the opener — when it exists and nothing else took it', async () => {
  // a) the opener is still there: it gets focus back
  const op = opener()
  const c = calls()
  const v = await mountView(modal(c), () => box())
  assert.equal(name(), 'dialog>button:cancel')
  await v.unmount()
  assert.equal(active(), op, 'focus returned to the opener')

  // b) the opener was removed while the dialog was open: nothing is thrown
  //    at a detached node, focus rests on body
  const op2 = opener()
  const v2 = await mountView(modal(c), () => box())
  op2.remove()
  assert.equal(op2.isConnected, false)
  await tab(); assert.equal(name(), 'dialog>button:delete', 'trap still works')
  await v2.unmount()
  assert.equal(name(), 'body')

  // c) the confirmed action moved focus itself: that wins
  const op3 = opener()
  const elsewhere = document.getElementById('elsewhere') as HTMLButtonElement
  const v3 = await mountView(modal(c, { onConfirm: () => elsewhere.focus() }),
    () => box())
  await act(async () => { button('delete').click() })
  assert.deepEqual(c.order.slice(-2), ['close', 'confirm'], 'close-then-act')
  assert.equal(name(), '#elsewhere', 'still on the action\'s own target')
  await v3.unmount()
  assert.equal(name(), '#elsewhere', 'unmount did not yank it back')
  assert.notEqual(active(), op3)
})

test('§6 no stale document handler after unmount', async () => {
  opener()
  const c = calls()
  const v = await mountView(modal(c), () => box())
  assert.equal(await tab(), true, 'positive control: while open, Tab is consumed')
  await v.unmount()
  assert.equal(name(), '#opener')
  assert.equal(await tab(), false, 'after unmount, a Tab is not consumed')
  assert.equal(name(), '#opener', 'and focus was not moved by a leaked handler')
})

test('§7 Escape still closes, once', async () => {
  opener()
  const c = calls()
  const v = await mountView(modal(c), () => box())
  await escape()
  assert.equal(c.close, 1)
  assert.equal(c.confirm, 0)
  await v.unmount()
  await escape()
  assert.equal(c.close, 1, 'a closed dialog no longer listens for Escape')
})
