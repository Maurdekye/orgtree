// selectkeys.test.ts — USER 2026-11-19 m6a2395ab50fb "Everywhere": every dropdown draws its option list inside the window
// (styles.css switches each single-choice select to Chromium's in-page list). That list has other keys than a native
// Windows select, and while it is open its options are ordinary elements whose events would reach the page. These tests
// pin what src/selectkeys.ts restores: the closed-control keys, Tab from the open list, and the open list owning its
// own input the way the OS pop-up did. What the BROWSER does with a key (open, close, move the highlight) is measured in
// a real window by selectinpage.capture.cjs; jsdom has no list to open, so "open" is stated by the test.
import { JSDOM } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { installSelectKeys } from '../src/selectkeys'

const HTML = `<input id="a"><select id="s" aria-label="Model">
  <option value="fable">Fable</option><option value="opus">Opus</option><option value="sonnet" disabled>Sonnet</option>
  <optgroup label="Off" disabled><option value="sol">Sol</option></optgroup>
  <optgroup label="Google"><option value="carbon">Carbon</option><option value="hydrogen">Hydrogen</option></optgroup>
</select><input id="b"><button id="hidden" style="display:none">x</button><button id="skip" tabindex="-1">y</button><button id="off" disabled>z</button><input id="c">`

interface Rig { win: Window; doc: Document; s: HTMLSelectElement; events: string[]; open: (v: boolean) => void; stop: () => void
  key: (target: Element, key: string, init?: KeyboardEventInit, type?: string) => KeyboardEvent; option: (v: string) => HTMLOptionElement; settle: () => Promise<void> }

function rig(win: Window = window, html = HTML): Rig {
  const doc = win.document
  doc.body.innerHTML = html
  const s = doc.getElementById('s') as HTMLSelectElement
  const events: string[] = []
  for (const type of ['input', 'change']) doc.addEventListener(type, e => events.push(`${type}:${(e.target as HTMLSelectElement).value}`))
  // jsdom has no in-page list: the test says when it is open, through the same question the module asks the browser
  let isOpen = false
  const matches = s.matches.bind(s)
  ;(s as unknown as { matches: (selector: string) => boolean }).matches = selector => selector === ':open' ? isOpen : matches(selector)
  const stop = installSelectKeys(win)
  const W = win as unknown as { KeyboardEvent: typeof KeyboardEvent }
  return { win, doc, s, events, stop, open: v => { isOpen = v },
    key: (target, key, init = {}, type = 'keydown') => { const e = new W.KeyboardEvent(type, { key, bubbles: true, cancelable: true, ...init }); target.dispatchEvent(e); return e },
    option: v => [...s.options].find(o => o.value === v)!,
    settle: () => new Promise(r => setTimeout(r, 15)) }
}

test('closed: Up and Down change the value, skip what cannot be chosen, and keep the list shut', () => {
  const r = rig()
  try {
    r.s.focus()
    let e = r.key(r.s, 'ArrowDown')
    assert.equal(r.s.value, 'opus'); assert.equal(e.defaultPrevented, true, 'the browser would open the list on this key')
    e = r.key(r.s, 'ArrowDown')
    assert.equal(r.s.value, 'carbon', 'the disabled option and the disabled group are passed over')
    r.key(r.s, 'ArrowDown'); assert.equal(r.s.value, 'hydrogen')
    e = r.key(r.s, 'ArrowDown')
    assert.equal(r.s.value, 'hydrogen', 'the last choice stays'); assert.equal(e.defaultPrevented, true, 'and the list still does not open')
    r.key(r.s, 'ArrowUp'); assert.equal(r.s.value, 'carbon')
    r.key(r.s, 'ArrowUp'); assert.equal(r.s.value, 'opus')
    r.key(r.s, 'ArrowUp'); r.key(r.s, 'ArrowUp'); assert.equal(r.s.value, 'fable')
    assert.deepEqual(r.events, ['input:opus', 'change:opus', 'input:carbon', 'change:carbon', 'input:hydrogen', 'change:hydrogen',
      'input:carbon', 'change:carbon', 'input:opus', 'change:opus', 'input:fable', 'change:fable'], 'one input and one change per real change, none at the ends')
  } finally { r.stop() }
})

test('closed: Home, End, Page Up and Page Down go to the first and last choice', () => {
  const r = rig()
  try {
    r.s.focus()
    assert.equal(r.key(r.s, 'End').defaultPrevented, true); assert.equal(r.s.value, 'hydrogen')
    r.key(r.s, 'Home'); assert.equal(r.s.value, 'fable')
    r.key(r.s, 'PageDown'); assert.equal(r.s.value, 'hydrogen')
    r.key(r.s, 'PageUp'); assert.equal(r.s.value, 'fable')
    assert.deepEqual(r.events, ['input:hydrogen', 'change:hydrogen', 'input:fable', 'change:fable', 'input:hydrogen', 'change:hydrogen', 'input:fable', 'change:fable'])
  } finally { r.stop() }
})

test('closed: keys that are not ours are left to the browser and to the page', () => {
  const r = rig()
  try {
    r.s.focus()
    for (const init of [{ altKey: true }, { ctrlKey: true }, { metaKey: true }]) {
      const e = r.key(r.s, 'ArrowDown', init)
      assert.equal(e.defaultPrevented, false, JSON.stringify(init)); assert.equal(r.s.value, 'fable')
    }
    for (const key of ['m', ' ', 'F4', 'Escape', 'Tab']) assert.equal(r.key(r.s, key).defaultPrevented, false, key)
    // a handler before ours already took the key
    const taken = (e: Event) => e.preventDefault()
    r.win.addEventListener('keydown', taken, true); r.stop(); const stop = installSelectKeys(r.win)
    r.key(r.s, 'ArrowDown'); assert.equal(r.s.value, 'fable', 'a key someone else consumed first is not ours')
    r.win.removeEventListener('keydown', taken, true); stop()
    assert.deepEqual(r.events, [])
  } finally { r.stop() }
})

test('a list box (multiple, or sized) keeps its own keys', () => {
  for (const attr of ['multiple', 'size="4"']) {
    const r = rig(window, `<select id="s" ${attr}><option value="x">x</option><option value="y">y</option></select>`)
    try {
      r.s.focus()
      assert.equal(r.key(r.s, 'ArrowDown').defaultPrevented, false, attr)
      assert.equal(r.key(r.s, 'End').defaultPrevented, false, attr)
      assert.deepEqual(r.events, [], attr)
    } finally { r.stop() }
  }
})

test('closed: Enter opens the list, except in a form and except when the page took the key', () => {
  const r = rig()
  try {
    let shown = 0
    ;(r.s as unknown as { showPicker: () => void }).showPicker = () => { shown++ }
    r.s.focus()
    const e = r.key(r.s, 'Enter')
    assert.equal(shown, 1); assert.equal(e.defaultPrevented, true)
    // a dialog that confirms on Enter keeps it
    const confirm = (ev: Event) => { if ((ev as KeyboardEvent).key === 'Enter') ev.preventDefault() }
    r.doc.body.addEventListener('keydown', confirm)
    r.key(r.s, 'Enter'); assert.equal(shown, 1, 'Enter that the page consumed does not also open the list')
    r.doc.body.removeEventListener('keydown', confirm)
    r.key(r.s, 'Enter', { shiftKey: true }); r.key(r.s, 'Enter', { ctrlKey: true }); assert.equal(shown, 1, 'only plain Enter')
  } finally { r.stop() }
  const f = rig(window, `<form id="f"><select id="s"><option value="x">x</option><option value="y">y</option></select><button>go</button></form>`)
  try {
    let shown = 0
    ;(f.s as unknown as { showPicker: () => void }).showPicker = () => { shown++ }
    f.doc.getElementById('f')!.addEventListener('submit', e => e.preventDefault())
    f.s.focus()
    const e = f.key(f.s, 'Enter')
    assert.equal(shown, 0, 'in a form Enter stays the form\'s'); assert.equal(e.defaultPrevented, false)
  } finally { f.stop() }
})

test('open: the list owns its keys, wheel and presses, as the OS pop-up did, and the browser still acts on them', () => {
  const r = rig()
  try {
    const seen: string[] = []
    const note = (where: string) => (e: Event) => seen.push(`${where}:${e.type}:${(e as KeyboardEvent).key ?? ''}`)
    const types = ['keydown', 'keyup', 'keypress', 'wheel', 'pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'dblclick', 'auxclick', 'contextmenu']
    for (const type of types) { r.win.addEventListener(type, note('window-capture'), true); r.doc.addEventListener(type, note('document')); r.doc.body.addEventListener(type, note('ancestor')) }
    const opus = r.option('opus')
    const fire = (target: Element, type: string, key?: string) => {
      const W = r.win as unknown as { KeyboardEvent: typeof KeyboardEvent; MouseEvent: typeof MouseEvent }
      const e = key !== undefined ? new W.KeyboardEvent(type, { key, bubbles: true, cancelable: true }) : new W.MouseEvent(type, { bubbles: true, cancelable: true })
      target.dispatchEvent(e); return e
    }
    r.open(true)
    for (const key of ['Escape', 'ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter', ' ', 'm']) {
      assert.equal(fire(opus, 'keydown', key).defaultPrevented, false, `${key}: the browser must still act`)
      fire(opus, 'keyup', key)
    }
    assert.equal(fire(r.s, 'keydown', 'Escape').defaultPrevented, false, 'also when the control itself has focus under an open list')
    for (const type of types.slice(3)) assert.equal(fire(opus, type).defaultPrevented, false, type)
    fire(r.s, 'wheel')
    assert.deepEqual(seen, [], 'nothing of an open list reaches the page')
    assert.deepEqual(r.events, [], 'and none of these keys chose anything by itself')
    // a press on the control itself (which closes the list) is the page's as before
    fire(r.s, 'click')
    assert.deepEqual(seen, ['window-capture:click:', 'ancestor:click:', 'document:click:'])
    // closed: everything reaches the page again
    seen.length = 0; r.open(false)
    fire(opus, 'keydown', 'Escape'); fire(opus, 'click'); fire(r.s, 'wheel')
    assert.deepEqual(seen, ['window-capture:keydown:Escape', 'ancestor:keydown:Escape', 'document:keydown:Escape',
      'window-capture:click:', 'ancestor:click:', 'document:click:', 'window-capture:wheel:', 'ancestor:wheel:', 'document:wheel:'])
  } finally { r.stop() }
})

test('open: Tab takes the highlighted choice and moves on; Shift+Tab moves back', async () => {
  const r = rig()
  try {
    const seen: string[] = []
    r.doc.addEventListener('keydown', e => seen.push(`${(e.target as Element).id || (e.target as Element).localName}:${e.key}:${e.isTrusted}`))
    // what the browser does on Tab in an open list: it closes the list and leaves focus on the control
    const browserActs = () => { r.open(false); r.s.focus() }
    r.s.focus(); r.open(true)
    let e = r.key(r.option('carbon'), 'Tab')
    assert.equal(e.defaultPrevented, false, 'the browser closes the list itself')
    assert.equal(r.s.value, 'carbon'); assert.deepEqual(r.events, ['input:carbon', 'change:carbon'])
    assert.deepEqual(seen, [], 'the press itself stays the list\'s')
    browserActs(); await r.settle()
    assert.equal(r.doc.activeElement?.id, 'b', 'focus moved to the next field')
    assert.deepEqual(seen, ['s:Tab:false'], 'the page is offered the Tab once, from the control, so a focus trap can take it')

    r.events.length = 0; r.s.focus(); r.open(true)
    e = r.key(r.option('opus'), 'Tab', { shiftKey: true })
    browserActs(); await r.settle()
    assert.equal(r.s.value, 'opus'); assert.equal(r.doc.activeElement?.id, 'a', 'Shift+Tab moved back')
    assert.deepEqual(r.events, ['input:opus', 'change:opus'])

    // the highlight on a choice that cannot be taken, or on the current one: nothing changes, focus still moves on
    r.events.length = 0; r.s.focus(); r.open(true)
    r.key(r.option('sonnet'), 'Tab'); browserActs(); await r.settle()
    assert.equal(r.s.value, 'opus'); assert.deepEqual(r.events, []); assert.equal(r.doc.activeElement?.id, 'b')
    r.s.focus(); r.open(true)
    r.key(r.option('opus'), 'Tab'); browserActs(); await r.settle()
    assert.deepEqual(r.events, []); assert.equal(r.doc.activeElement?.id, 'b')
  } finally { r.stop() }
})

test('open: Tab moves past what cannot take focus, wraps, and yields to a focus trap', async () => {
  const r = rig()
  try {
    const browserActs = () => { r.open(false); r.s.focus() }
    // from the last field's neighbour: hidden, tabindex -1 and disabled controls are not stops
    const c = r.doc.getElementById('c')!, b = r.doc.getElementById('b')!
    b.remove()
    r.s.focus(); r.open(true); r.key(r.option('opus'), 'Tab'); browserActs(); await r.settle()
    assert.equal(r.doc.activeElement?.id, 'c', 'the hidden, the tabindex -1 and the disabled button are skipped')
    // wrap: backwards from the first stop goes to the last
    r.doc.getElementById('a')!.remove()
    r.s.focus(); r.open(true); r.key(r.option('opus'), 'Tab', { shiftKey: true }); browserActs(); await r.settle()
    assert.equal(r.doc.activeElement?.id, 'c', 'Shift+Tab from the first stop wraps to the last')
    // a focus trap that handles Tab itself decides where focus goes
    const trap = (e: KeyboardEvent) => { if (e.key === 'Tab') { e.preventDefault(); r.s.blur(); (r.doc.getElementById('skip') as HTMLElement).focus() } }
    r.doc.body.addEventListener('keydown', trap)
    r.s.focus(); r.open(true); r.key(r.option('opus'), 'Tab'); browserActs(); await r.settle()
    assert.equal(r.doc.activeElement?.id, 'skip', 'the trap\'s choice stands')
    r.doc.body.removeEventListener('keydown', trap)
    // focus that went elsewhere meanwhile is left alone
    r.s.focus(); r.open(true); r.key(r.option('opus'), 'Tab'); r.open(false); c.focus(); await r.settle()
    assert.equal(r.doc.activeElement?.id, 'c')
  } finally { r.stop() }
})

test('each window is installed by itself, once, and uninstalls cleanly', () => {
  const child = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost/' })
  const r = rig(child.window as unknown as Window)
  try {
    const again = installSelectKeys(r.win)   // a second install on the same window must not double the handling
    r.s.focus()
    r.key(r.s, 'ArrowDown')
    assert.equal(r.s.value, 'opus'); assert.deepEqual(r.events, ['input:opus', 'change:opus'])
    again()
    r.key(r.s, 'ArrowDown'); assert.equal(r.s.value, 'carbon', 'the first install still stands after the second is undone')
    r.stop()
    const e = r.key(r.s, 'ArrowDown')
    assert.equal(e.defaultPrevented, false); assert.equal(r.s.value, 'carbon', 'uninstalled: the keys are the browser\'s again')
    // the main window was never installed by this test
    document.body.innerHTML = '<select id="m"><option value="x">x</option><option value="y">y</option></select>'
    const m = document.getElementById('m') as HTMLSelectElement
    const ev = new window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }); m.dispatchEvent(ev)
    assert.equal(ev.defaultPrevented, false); assert.equal(m.value, 'x')
  } finally { r.stop(); child.window.close() }
})
