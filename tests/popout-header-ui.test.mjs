// The REAL components, popped out through the REAL detach path, because the
// native probe's header markup is a faithful stand-in and a stand-in cannot
// prove that the actual desk and modal render what it measures. A second JSDOM
// stands in for the popped-out window, exactly as the surface tests next door
// do it: window.open hands it back, and MovableSurface adopts the live DOM into
// it for real.
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { build } from 'esbuild'
import { JSDOM, VirtualConsole } from 'jsdom'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { createRequire } from 'node:module'
import Module from 'node:module'

const root = path.resolve(import.meta.dirname, '..')
// Inside node_modules so the bundle's `require('react')` resolves to the SAME
// React this test uses - two copies would break every hook - and removed again
// rather than left behind.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orgtree-popout-ui-test-'))
const dependencyRoot = path.dirname(path.dirname(createRequire(import.meta.url).resolve('react/package.json')))
process.env.NODE_PATH = [dependencyRoot, process.env.NODE_PATH].filter(Boolean).join(path.delimiter)
Module._initPaths()
// KEEP_POPOUT_UI_BUNDLE leaves it behind, so a stack trace into the bundle can
// still be read after the run.
after(() => { if (!process.env.KEEP_POPOUT_UI_BUNDLE) try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* already gone */ } })

const output = path.join(dir, 'popout-ui.cjs')
await build({
  stdin: {
    contents: `export { DeskHosts, DeskSlot, useDeskActionsNow } from './apps/desktop/renderer/src/canvas/deskhosts'
export { PinFrame } from './apps/desktop/renderer/src/canvas/modalpin'
export { CurrentOrg } from './apps/desktop/renderer/src/popout'`,
    loader: 'ts', resolveDir: root,
  },
  outfile: output, bundle: true, platform: 'node', format: 'cjs', jsx: 'automatic',
  sourcemap: 'inline',
  external: ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client'],
  plugins: [{
    name: 'convo-stub',
    setup(builder) {
      // The ONE thing stubbed, and it is deeper than anything under test: the
      // conversation store, which wants a live feed this test has no business
      // inventing. The desk, its header, the host, the stale notice, the
      // recovery action and the surface are all the production components.
      builder.onResolve({ filter: /^\.\.\/convo$/ }, () => ({ path: 'convo', namespace: 'convo' }))
      builder.onLoad({ filter: /.*/, namespace: 'convo' }, () => ({
        contents: `// the documented "nothing loaded yet" Convo, field for field
exports.useConvo = () => ({ chat: null, live: [], pending: [], draft: '', thinking: '', thinkSecs: null, win: 50, loadingOlder: false })
exports.CHAT_WINDOW = 50; exports.MAX_WINDOW = 200
for (const name of ['addPending','bindPendingMail','failPending','dismissPending','dropPending','loadOlder','markBusy','markGhostCommand','refreshConvo']) exports[name] = () => {}`,
        loader: 'js', resolveDir: root,
      }))
    },
  }],
})
const { DeskHosts, DeskSlot, useDeskActionsNow, PinFrame, CurrentOrg } = createRequire(import.meta.url)(output)

const CONTROLS = ['Minimize window', 'Maximize window', 'Close window']
const text = doc => [...doc.querySelectorAll('button')].map(b => b.textContent?.trim())
const labels = doc => [...doc.querySelectorAll('[aria-label]')].map(b => b.getAttribute('aria-label'))
const byLabel = (doc, label) => doc.querySelector(`[aria-label="${label}"]`)

/** A main window with a popped-out window ready to receive it. The child is a
 *  real second document, so anything adopted into it genuinely leaves the main
 *  one - which is the whole question being asked here. */
function stage() {
  // Nothing may throw or report an error unnoticed: a green test that printed
  // an uncaught TypeError is how the import order above came to light.
  const problems = []
  const watch = () => {
    const console_ = new VirtualConsole()
    console_.on('jsdomError', error => problems.push('uncaught: ' + error.message))
    console_.on('error', (...args) => problems.push('console.error: ' + args.map(String).join(' ')))
    return console_
  }
  const dom = new JSDOM('<div id="app"></div>', { url: 'http://localhost/', virtualConsole: watch() })
  const child = new JSDOM('<html><head></head><body></body></html>', { url: 'http://localhost/', virtualConsole: watch() })
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  globalThis.localStorage = dom.window.localStorage
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  globalThis.MutationObserver = child.window.MutationObserver
  const cw = child.window
  Object.defineProperties(cw, { screenX: { value: 120 }, screenY: { value: 80 }, outerWidth: { value: 800 }, outerHeight: { value: 600 } })
  cw.focus = () => {}; cw.requestAnimationFrame = () => 1; cw.cancelAnimationFrame = () => {}
  for (const view of [dom.window, cw]) {
    view.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} }
    view.matchMedia ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} })
    // react-dom decides once, when it is imported, whether this environment
    // supports input events; imported before any document exists - which is
    // what an ESM test file does - it concludes not, and watches a focused
    // field the IE way instead. jsdom has no attachEvent, so that path threw on
    // every composer focus while the suite still went green. These are the
    // compatibility methods it expects, doing what the modern path does here:
    // nothing this test observes.
    view.Element.prototype.attachEvent ??= function () {}
    view.Element.prototype.detachEvent ??= function () {}
  }
  globalThis.ResizeObserver = dom.window.ResizeObserver
  dom.window.open = () => cw
  dom.window.orgtreeDesktop = {
    onEvent: () => () => {},
    getPopoutState: async name => ({ name, present: true, maximized: false }),
    minimizePopout: async () => {}, toggleMaximizePopout: async () => {}, closePopout: async () => {},
  }
  const rootNode = createRoot(dom.window.document.getElementById('app'))
  return {
    main: dom.window.document,
    // A GETTER: adopting the surface runs document.open()/write() in the child,
    // so a document captured up front can be the wrong one by the time it is
    // read. This cost an hour of blaming the production code.
    get child() { return cw.document },
    render: element => act(async () => { rootNode.render(element) }),
    click: async element => { assert.ok(element, 'nothing to click'); await act(async () => { element.click() }) },
    /** Adopting a surface back home re-parents real DOM and then re-renders;
     *  one more flushed tick lets that second pass land. */
    settle: () => act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) }),
    teardown: async () => {
      await act(async () => rootNode.unmount())
      child.window.close(); dom.window.close()
      assert.deepEqual(problems, [], 'the run must not leave errors behind, reported or uncaught')
    },
  }
}

const NODE = { id: 'writer', generation: 3, tier: 'opus', charter: 'write', state: 'live',
  children: [], turns: [], seat: 1, grant: 0, tasks: 0 }
const deskProps = { node: NODE, map: new Map(), op: async () => {}, slug: 'org', toast: () => {}, pub: false }

/** THE POPOUT ASKED FOR FROM OUTSIDE THE DESK, which is the journey most cases
 *  below need: something that is not the desk's own header tells the registry
 *  to pop it out, and the desk leaves the main window on its own.
 *
 *  This was `DeskListControls` — the ⌖/↗ buttons at the end of an Agents List
 *  row — until the user had those buttons removed on 2026-09-12 and the action
 *  moved into the row's context menu. There is no component to borrow any
 *  more, so the fixture makes the call the menu entry makes
 *  (canvas/agentmenu.tsx's "Open desk in a new window") and gives it a handle
 *  to click. The production path under it — `requestPopout`, the retained
 *  request, the host's own popout — is untouched and is what these tests are
 *  actually about. */
function PopoutTrigger() {
  const deskNow = useDeskActionsNow('org')
  return React.createElement('button', {
    'aria-label': 'Open desk in a new window',
    onClick: () => deskNow(NODE).requestPopout(),
  }, '↗')
}

test('a popped-out desk offers no draft copy even once its agent identity has moved on', async () => {
  // The journey: a desk is popped out, the agent is rehired while it is out -
  // so the draft now belongs to a generation that no longer exists - and the
  // user brings it back. The draft-copy control must be absent out there and
  // present again once home.
  const s = stage()
  const current = { ...NODE, generation: 4 }
  const render = map => s.render(React.createElement(DeskHosts, { map, slug: 'org' },
    React.createElement(DeskSlot, { ...deskProps, map }),
    React.createElement(PopoutTrigger)))
  try {
    await render(new Map([[NODE.id, NODE]]))
    assert.ok(!text(s.main).includes('Copy unsent draft'), 'nothing to recover from while the identity still matches')

    await s.click(byLabel(s.main, 'Open in new window'))
    assert.ok(s.child.querySelector('.cc-head-top'), 'the desk really moved into the popped-out window')

    await render(new Map([[NODE.id, current]]))
    assert.match(s.child.body.textContent, /This agent's identity changed/,
      'POSITIVE CONTROL: the popped-out desk knows its identity moved on')
    assert.ok(!text(s.child).includes('Copy unsent draft'), 'yet offers no draft copy out there')
    assert.ok(!text(s.main).includes('Copy unsent draft'), 'and none is left behind in the main window')
    assert.match(s.child.body.textContent, /Return this desk to the main window to copy it/,
      'the notice must name an action that exists where it is read')
    assert.doesNotMatch(s.child.body.textContent, /Copy your draft before returning/)

    assert.ok(byLabel(s.child, 'Return to main window'), 'and the way home is right there in its header')
  } finally { await s.teardown() }
})

test('the same stale desk, docked, does offer the draft copy', async () => {
  // The other half of the rule, and the state a redocked desk is in. Driven as
  // its own render rather than by clicking Return inside the popped-out
  // document: a click dispatched in the second JSDOM does not reach React's
  // listeners, which is a limit of this harness rather than of the app.
  const s = stage()
  try {
    const map = new Map([[NODE.id, { ...NODE, generation: 4 }]])
    await s.render(React.createElement(DeskHosts, { map, slug: 'org' },
      React.createElement(DeskSlot, { ...deskProps, map }),
      React.createElement(PopoutTrigger)))
    assert.match(s.main.body.textContent, /This agent's identity changed/, 'POSITIVE CONTROL: it is the stale desk')
    assert.ok(text(s.main).includes('Copy unsent draft'), 'docked, the recovery is offered')
    assert.match(s.main.body.textContent, /Copy your draft before returning/,
      'and the notice names the action that is available here')
    for (const control of CONTROLS) assert.ok(!labels(s.main).includes(control), `${control} belongs to a popped-out window only`)
  } finally { await s.teardown() }
})

test('a popped-out desk carries window controls in its header; an ordinary one has none', async () => {
  const s = stage()
  try {
    const map = new Map([[NODE.id, NODE]])
    await s.render(React.createElement(DeskHosts, { map, slug: 'org' },
      React.createElement(DeskSlot, { ...deskProps, map }),
      React.createElement(PopoutTrigger)))
    for (const control of CONTROLS) assert.ok(!labels(s.main).includes(control), `${control} must not appear on a docked desk`)

    await s.click(byLabel(s.main, 'Open desk in a new window'))
    const header = s.child.querySelector('.cc-head-top')
    assert.ok(header, 'the production desk header really moved into the popped-out window')
    for (const control of CONTROLS) {
      const button = byLabel(s.child, control)
      assert.ok(button, `${control} must be in the popped-out desk's header`)
      assert.ok(header.contains(button), `${control} must be IN the header, not loose in the document`)
    }
    for (const control of CONTROLS) assert.ok(!labels(s.main).includes(control), `${control} must not also be in the main window`)
    assert.ok(byLabel(s.child, 'Return to main window'), 'and returning stays available there')
  } finally { await s.teardown() }
})

test('a popped-out modal carries window controls in its title bar; an ordinary one has none', async () => {
  const s = stage()
  try {
    await s.render(React.createElement(CurrentOrg.Provider, { value: 'org' },
      React.createElement(PinFrame, { kind: 'docket', title: 'Docket', panel: 'settings', close: () => {} },
        React.createElement('h3', null, 'Docket'))))
    for (const control of CONTROLS) assert.ok(!labels(s.main).includes(control), `${control} must not appear on a docked modal`)
    assert.ok(byLabel(s.main, 'Open in new window'), 'POSITIVE CONTROL: this modal can be popped out at all')

    await s.click(byLabel(s.main, 'Open in new window'))
    const bar = s.child.querySelector('.modalpin-bar')
    assert.ok(bar, 'the modal really moved into the popped-out window')
    for (const control of CONTROLS) {
      const button = byLabel(s.child, control)
      assert.ok(button, `${control} must be in the popped-out modal's title bar`)
      assert.ok(bar.contains(button), `${control} must be IN the bar, not loose in the document`)
    }
    for (const control of CONTROLS) assert.ok(!labels(s.main).includes(control), `${control} must not also be in the main window`)
  } finally { await s.teardown() }
})

// The notice a popped-out desk leaves behind is not one size everywhere: on a
// CANVAS CARD it stands where the desk's counter-scaled body was, so it has to
// be counter-scaled too or it renders at the camera's scale - 7.5x oversized,
// with its buttons outside the card (user report 2026-09-11). A `bare` host -
// a switchboard panel, a pinned window's body - shows the desk at 1:1 and must
// keep the plain notice.
//
// ⚠ WHAT THIS CANNOT SEE: jsdom does no layout, so this proves only that the
// markup asks for the right treatment. `tools/test-placeholder-scale.mjs`
// measures the resulting SIZE in a real browser against the pinned-desk
// placeholder, and is what fails if the stylesheet half goes missing.
test('a popped-out desk leaves a card-scaled notice on a card and a plain one in a bare host', async () => {
  const s = stage()
  try {
    const map = new Map([[NODE.id, NODE]])
    await s.render(React.createElement(DeskHosts, { map, slug: 'org' },
      React.createElement('div', { className: 'sq', id: 'card' },
        React.createElement(DeskSlot, { ...deskProps, map })),
      React.createElement('div', { className: 'sq', id: 'bare' },
        React.createElement(DeskSlot, { ...deskProps, map, bare: true })),
      React.createElement(PopoutTrigger)))
    // only one slot can host a desk, so the other already says so; the desk
    // itself is still here, which is what the pop-out below has to change
    assert.ok(s.main.querySelector('.cc-head-top'),
      'POSITIVE CONTROL: the real desk is in the main window to start with')
    assert.equal(s.main.querySelectorAll('.popout-placeholder').length, 1,
      'and exactly one of the two slots is standing aside for it')

    await s.click(byLabel(s.main, 'Open desk in a new window'))
    assert.ok(!s.main.querySelector('.cc-head-top'), 'the desk really left the main window')
    const onCard = s.main.querySelector('#card .popout-placeholder')
    const inBare = s.main.querySelector('#bare .popout-placeholder')
    assert.ok(onCard && inBare, 'both hosts show the desk is elsewhere')
    assert.match(onCard.textContent, /desk is open elsewhere/)

    assert.ok(onCard.classList.contains('desk-elsewhere'),
      'the card notice asks for the desk-scaled treatment')
    assert.ok(onCard.closest('.desk-elsewhere-holder'),
      'and sits in the holder that gives it the desk box and its clip')
    assert.ok(!inBare.classList.contains('desk-elsewhere'),
      'a bare host keeps the plain notice')
    assert.ok(!inBare.closest('.desk-elsewhere-holder'),
      'and is not boxed into a card interior it does not have')
  } finally { await s.teardown() }
})

// The two actions on that notice, which the user reported as doing nothing at
// all (2026-09-11, uploads/image-78.png).
//
// ⚠ WHAT THESE CANNOT SEE, AND IT IS THE SYMPTOM ITSELF. jsdom implements no
// pointer capture and no click retargeting, so the actual failure — the
// viewport captures the pointer on pointerdown and Chromium then fires the
// `click` at the viewport instead of at the button — is invisible here.
// `tools/test-placeholder-actions.mjs` reproduces it in a real window, with
// the real OrgCanvas and real input events, and records where each click was
// delivered. What jsdom CAN hold is the wiring that prevents it: that a press
// on either action never reaches the canvas underneath, and that returning
// the desk lands it in the host that asked.
test('a press on either notice action is kept off the canvas underneath it', async () => {
  const s = stage()
  const seen = []
  try {
    const map = new Map([[NODE.id, NODE]])
    // The recorder is a REACT handler, deliberately. React delegates at the
    // ROOT CONTAINER, so a NATIVE listener on an ancestor hears the press
    // whatever any component does about it — a native probe here would be
    // green against a completely unprotected button.
    await s.render(React.createElement(DeskHosts, { map, slug: 'org' },
      React.createElement('div', { id: 'canvas', onPointerDown: e => seen.push(e.target.tagName) },
        React.createElement('div', { className: 'sq', id: 'card' },
          React.createElement(DeskSlot, { ...deskProps, map }))),
      React.createElement(PopoutTrigger)))
    await s.click(byLabel(s.main, 'Open desk in a new window'))
    const notice = s.main.querySelector('#card .popout-placeholder')
    assert.ok(notice, 'the desk left a notice behind to press')
    const press = el => act(async () => {
      el.dispatchEvent(new s.main.defaultView.Event('pointerdown', { bubbles: true }))
    })

    // POSITIVE CONTROL: an unguarded press inside the same notice DOES reach
    // the canvas. Without this the check below passes for a notice that is
    // not rendered at all.
    await press(notice.querySelector('span'))
    assert.deepEqual(seen, ['SPAN'], 'the recorder can see a press that nobody stops')

    seen.length = 0
    const buttons = [...notice.querySelectorAll('button')]
    assert.deepEqual(buttons.map(b => b.textContent), ['Show desk', 'Return here'],
      'both actions are on offer')
    for (const button of buttons) await press(button)
    assert.deepEqual(seen, [],
      'neither action lets its press through to the canvas, which would take the click with it')
  } finally { await s.teardown() }
})

test('Return here brings the desk to the host that was asked, not to the one it left', async () => {
  const s = stage()
  try {
    const map = new Map([[NODE.id, NODE]])
    await s.render(React.createElement(DeskHosts, { map, slug: 'org' },
      React.createElement('div', { className: 'sq', id: 'card' },
        React.createElement(DeskSlot, { ...deskProps, map })),
      React.createElement('div', { className: 'sq', id: 'second' },
        React.createElement(DeskSlot, { ...deskProps, map })),
      React.createElement(PopoutTrigger)))
    // One desk, two slots: the one already showing a notice is the one the
    // desk is NOT in, so asking THAT one to take it back is the case where
    // returning to `entry.last` would land in the wrong place. Reading it off
    // the DOM rather than assuming an order keeps the test non-vacuous.
    const waiting = s.main.querySelector('.popout-placeholder')?.closest('.sq')?.id
    assert.ok(waiting === 'card' || waiting === 'second', 'one slot stands aside for the other')
    const holder = waiting === 'card' ? 'second' : 'card'
    assert.ok(s.main.querySelector(`#${holder} .cc-head-top`), 'POSITIVE CONTROL: the desk starts in the other slot')

    await s.click(byLabel(s.main, 'Open desk in a new window'))
    assert.ok(!s.main.querySelector('.cc-head-top'), 'the desk really left the main window')
    const notice = s.main.querySelector(`#${waiting} .popout-placeholder`)
    await s.click([...notice.querySelectorAll('button')].find(b => b.textContent === 'Return here'))
    await s.settle()

    assert.ok(s.main.querySelector(`#${waiting} .cc-head-top`),
      `Return here was pressed in #${waiting}, so the desk belongs in #${waiting}`)
    assert.ok(!s.main.querySelector(`#${holder} .cc-head-top`),
      'and must not have gone back to the slot it was popped out of')
  } finally { await s.teardown() }
})

test('Show desk aims the camera at the host the desk is actually in', async () => {
  // The other half of that button. With two slots for one desk, the slot
  // standing aside is where a reader looks for a desk that is somewhere else
  // in the SAME window — so its "Show desk" has to go to the desk, which is
  // the canvas jump the card already owns.
  // Unlike the two tests above this one is a LOCK, not a reproduction: it is
  // green on 2.0.8 as well, because jsdom dispatches the click straight at
  // the button and the user's symptom needs a real capturing viewport. It is
  // here so the jump cannot be quietly dropped later.
  const s = stage()
  const jumped = []
  try {
    const map = new Map([[NODE.id, NODE]])
    // jsdom has no scroller, so `scrollIntoView` is absent; the app calls it
    // on the host's anchor. Supplying it keeps this test about the jump.
    s.main.defaultView.Element.prototype.scrollIntoView ??= function () {}
    const props = { ...deskProps, map, onJump: id => jumped.push(id) }
    await s.render(React.createElement(DeskHosts, { map, slug: 'org' },
      React.createElement('div', { className: 'sq', id: 'card' },
        React.createElement(DeskSlot, props)),
      React.createElement('div', { className: 'sq', id: 'second' },
        React.createElement(DeskSlot, props))))
    const notice = s.main.querySelector('.popout-placeholder')
    assert.ok(notice, 'POSITIVE CONTROL: one slot stands aside, so there is a Show desk to press')
    assert.deepEqual(jumped, [], 'and nothing has been asked for yet')

    await s.click([...notice.querySelectorAll('button')].find(b => b.textContent === 'Show desk'))
    assert.deepEqual(jumped, [NODE.id], 'Show desk asks the canvas for the agent whose desk it is')
    assert.deepEqual([...notice.querySelectorAll('button')].map(b => b.textContent), ['Show desk'],
      'a desk that never left this window offers no way to return it')
  } finally { await s.teardown() }
})
