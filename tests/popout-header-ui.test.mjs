// The REAL components, popped out through the REAL detach path, because the
// native probe's header markup is a faithful stand-in and a stand-in cannot
// prove that the actual desk and modal render what it measures. A second JSDOM
// stands in for the popped-out window, exactly as the surface tests next door
// do it: window.open hands it back, and MovableSurface adopts the live DOM into
// it for real.
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { build } from 'esbuild'
import { JSDOM, VirtualConsole } from 'jsdom'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { createRequire } from 'node:module'

const root = path.resolve(import.meta.dirname, '..')
// Inside node_modules so the bundle's `require('react')` resolves to the SAME
// React this test uses - two copies would break every hook - and removed again
// rather than left behind.
const dir = fs.mkdtempSync(path.join(root, 'node_modules', '.popout-ui-test-'))
// KEEP_POPOUT_UI_BUNDLE leaves it behind, so a stack trace into the bundle can
// still be read after the run.
after(() => { if (!process.env.KEEP_POPOUT_UI_BUNDLE) try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* already gone */ } })

const output = path.join(dir, 'popout-ui.cjs')
await build({
  stdin: {
    contents: `export { DeskHosts, DeskSlot, DeskListControls } from './apps/desktop/renderer/src/canvas/deskhosts'
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
const { DeskHosts, DeskSlot, DeskListControls, PinFrame, CurrentOrg } = createRequire(import.meta.url)(output)

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

test('a popped-out desk offers no draft copy even once its agent identity has moved on', async () => {
  // The journey: a desk is popped out, the agent is rehired while it is out -
  // so the draft now belongs to a generation that no longer exists - and the
  // user brings it back. The draft-copy control must be absent out there and
  // present again once home.
  const s = stage()
  const current = { ...NODE, generation: 4 }
  const render = map => s.render(React.createElement(DeskHosts, { map, slug: 'org' },
    React.createElement(DeskSlot, { ...deskProps, map }),
    React.createElement(DeskListControls, { slug: 'org', node: NODE })))
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
      React.createElement(DeskListControls, { slug: 'org', node: NODE })))
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
      React.createElement(DeskListControls, { slug: 'org', node: NODE })))
    for (const control of CONTROLS) assert.ok(!labels(s.main).includes(control), `${control} must not appear on a docked desk`)

    await s.click(byLabel(s.main, "open writer's desk in a new window"))
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
      React.createElement(DeskListControls, { slug: 'org', node: NODE })))
    // only one slot can host a desk, so the other already says so; the desk
    // itself is still here, which is what the pop-out below has to change
    assert.ok(s.main.querySelector('.cc-head-top'),
      'POSITIVE CONTROL: the real desk is in the main window to start with')
    assert.equal(s.main.querySelectorAll('.popout-placeholder').length, 1,
      'and exactly one of the two slots is standing aside for it')

    await s.click(byLabel(s.main, "open writer's desk in a new window"))
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
