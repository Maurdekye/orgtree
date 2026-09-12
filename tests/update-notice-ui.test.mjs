import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import Module from 'node:module'
import { build } from 'esbuild'
import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'

const root = path.resolve(import.meta.dirname, '..')
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orgtree-update-notice-ui-test-'))
const dependencyRoot = path.dirname(path.dirname(createRequire(import.meta.url).resolve('react/package.json')))
process.env.NODE_PATH = [dependencyRoot, process.env.NODE_PATH].filter(Boolean).join(path.delimiter)
Module._initPaths()
const output = path.join(dir, 'update-notice.cjs')
await build({
  entryPoints: [path.join(root, 'apps/desktop/renderer/src/update-notice.tsx')],
  outfile: output, bundle: true, platform: 'node', format: 'cjs', jsx: 'automatic',
  external: ['react', 'react/jsx-runtime'],
})
const { UpdateNotice, describeUpdateStatus } = createRequire(import.meta.url)(output)

// The hide timer fires a state update outside of any React event handler, so
// waiting for it must itself be wrapped in act() or React warns on the update.
const sleep = ms => act(async () => { await new Promise(resolve => setTimeout(resolve, ms)) })

function stage() {
  const dom = new JSDOM('<div id="app"></div>', { url: 'http://localhost' })
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const listeners = new Set()
  const target = document.getElementById('app')
  const rootNode = createRoot(target)
  const teardown = async () => { await act(async () => rootNode.unmount()); dom.window.close() }
  return { rootNode, listeners, teardown }
}

async function mount(initial, transientMs, bridge = {}) {
  const { rootNode, listeners, teardown } = stage()
  window.orgtreeDesktop = { ...bridge, getUpdateStatus: async () => initial, onEvent: listener => { listeners.add(listener); return () => listeners.delete(listener) } }
  await act(async () => rootNode.render(React.createElement(UpdateNotice, transientMs === undefined ? undefined : { transientMs })))
  return { listeners, teardown, push: async status => act(async () => { for (const listener of listeners) listener({ type: 'update', data: status }) }) }
}

test('a check that ran with an update already prepared is reported in the same line as the ready update', () => {
  // The status does not change state - the same installer is still what will
  // run - so without this the user presses Check for updates, an update is
  // already ready, and absolutely nothing on screen moves.
  assert.equal(describeUpdateStatus({ state: 'pending-idle', version: '2.0.4' }), 'Update ready to install')
  assert.equal(describeUpdateStatus({ state: 'pending-idle', version: '2.0.4', recheck: 'up-to-date' }),
    'Update ready to install — no newer release')
  assert.equal(describeUpdateStatus({ state: 'pending-idle', version: '2.0.4', recheck: 'unavailable' }),
    'Update ready to install — the update check could not reach the feed')
  // an unknown value must not reach the user as a dangling dash
  assert.equal(describeUpdateStatus({ state: 'pending-idle', recheck: 'nonsense' }), 'Update ready to install')
  // and the note belongs to pending-idle alone
  assert.equal(describeUpdateStatus({ state: 'up-to-date', recheck: 'up-to-date' }), 'You’re up to date')
})

test('idle status on mount renders nothing', async () => {
  const { teardown } = await mount({ state: 'idle' })
  assert.equal(document.querySelector('.update-notice'), null)
  await teardown()
})

// Margins here are deliberately generous (vs. an earlier 5/20/30ms version that
// was flaky under real system load - a slow act()/render pass could itself eat
// several ms, and 5ms left no room for that before the "still visible" check).
test('a downloading push shows its percent and stays visible with no timer', async () => {
  const { push, teardown } = await mount({ state: 'idle' }, 50)
  await push({ state: 'downloading', version: '2.0.0-alpha.6', percent: 42 })
  assert.equal(document.querySelector('.update-notice').textContent, 'Downloading update… 42%')
  await sleep(150)
  assert.ok(document.querySelector('.update-notice'), 'downloading is not a transient state — it must not auto-hide')
  await teardown()
})

// The expectation here used to be /installs automatically when idle/, which
// is the wording 13517e2 replaced when it made automatic installation
// OPTIONAL - the old sentence became a claim the app can no longer make, and
// this assertion has been red ever since. It follows the label again.
// (No bridge is passed, so there is no installUpdate and this renders the
// LABEL rather than the button - which is the path this test is about.)
test('pending-idle stays visible (no auto-hide) and reports the ready-to-install message', async () => {
  const { push, teardown } = await mount({ state: 'idle' }, 50)
  await push({ state: 'pending-idle', version: '2.0.0-alpha.6' })
  assert.match(document.querySelector('.update-notice').textContent, /Update ready to install/)
  assert.equal(document.querySelector('button'), null, 'no install bridge, so no button')
  await sleep(150)
  assert.ok(document.querySelector('.update-notice'))
  await teardown()
})

test('up-to-date, unavailable and failed are transient feedback that auto-hides', async () => {
  for (const state of ['up-to-date', 'unavailable', 'failed']) {
    const { push, teardown } = await mount({ state: 'idle' }, 50)
    await push({ state })
    assert.ok(document.querySelector('.update-notice'), `${state} must show immediately`)
    await sleep(200)
    assert.equal(document.querySelector('.update-notice'), null, `${state} must auto-hide after its timeout`)
    await teardown()
  }
})

test('a later push resets the hide timer instead of stacking with the earlier one', async () => {
  const { push, teardown } = await mount({ state: 'idle' }, 100)
  await push({ state: 'up-to-date' })
  await sleep(60)
  await push({ state: 'unavailable' })
  await sleep(60)
  // 120ms since the first push (> its 100ms timer) but only 60ms since the second.
  assert.equal(document.querySelector('.update-notice').textContent, 'Update check unavailable', 'the second push\'s own timer, not the first\'s, governs visibility')
  await teardown()
})

test('checking has no label text change mid-flight and clears cleanly on unmount', async () => {
  const { push, listeners, teardown } = await mount({ state: 'idle' })
  await push({ state: 'checking' })
  assert.equal(document.querySelector('.update-notice').textContent, 'Checking for updates…')
  await teardown()
  assert.equal(listeners.size, 0, 'the event subscription must be released on unmount')
})


// ── the attention glow, and what hovering it says (user 2026-09-11) ───────
//
// ANTI-VACUITY. A class name on a button proves nothing on its own: if the
// stylesheet never gives `.update-now.glow` a rule, the markup is present,
// plausible and completely inert. So the CSS assertion below is not decoration
// - it is the half that can actually fail when the glow does not exist. And
// the class must come OFF again, or "only while ready to install" is untested
// in the direction that matters.
test('a ready download glows in the theme accent, and stops the moment it is '
  + 'being installed', async () => {
  let resolveInstall
  const bridge = { installUpdate: () => new Promise(resolve => { resolveInstall = resolve }) }
  const { push, teardown } = await mount({ state: 'downloading', percent: 50 }, 20, bridge)
  // POSITIVE CONTROL: downloading is not ready, so there is no button at all
  // to carry a glow - without this, "no glow while downloading" would pass
  // against a component that rendered nothing.
  assert.equal(document.querySelector('button'), null)

  await push({ state: 'pending-idle', version: '2.0.5' })
  const button = document.querySelector('button')
  assert.ok(button, 'a ready download must offer the button')
  assert.ok(button.classList.contains('update-now'))
  assert.ok(button.classList.contains('glow'),
    'a downloaded update waiting to install must glow')

  // pressing it is no longer "ready to install"
  await act(async () => button.click())
  assert.equal(button.disabled, true)
  assert.equal(button.classList.contains('glow'), false,
    'a disabled "Restarting…" button must not keep pulsing for a click it refuses')
  await act(async () => resolveInstall())
  await teardown()
})

test('the glow is the SAME treatment as the unread-ask bell, in the active '
  + 'provider theme - not a second animation beside it', async () => {
  const css = fs.readFileSync(path.join(root, 'apps/desktop/renderer/src/styles.css'), 'utf8')
  const rule = css.match(/\.update-notice button\.update-now\.glow\s*\{([^}]*)\}/)
  assert.ok(rule, 'the glow class has no rule in styles.css - the markup is inert')
  assert.match(rule[1], /animation:\s*askbell /,
    'it must reuse the ask-bell keyframes, not declare its own')
  assert.match(rule[1], /var\(--accent\)/,
    'the colour must be the theme accent, which follows the active provider')
  // …and the keyframes it names really exist, so the animation is not a
  // reference to nothing
  assert.match(css, /@keyframes askbell\s*\{/)
  // the treatment it claims to match is still there and still uses them
  const bell = css.match(/\.ask-bell\.glow\s*\{([^}]*)\}/)
  assert.ok(bell, 'the ask-bell glow this is modelled on has gone')
  assert.match(bell[1], /animation:\s*askbell /)
})

// jsdom does not evaluate media queries, so the stylesheet source IS the
// instrument here - the same one this file already uses for the glow rule.
// ⚠ THE SECOND ASSERTION IS THE POINT. `animation: none` alone would satisfy
// "reduced motion respected" while deleting the signal outright, leaving that
// reader a button indistinguishable from an ordinary one - which is the exact
// state this change exists to fix. The static halo is what must survive.
test('reduced motion drops the pulse but keeps the signal', async () => {
  const css = fs.readFileSync(path.join(root, 'apps/desktop/renderer/src/styles.css'), 'utf8')
  const blocks = [...css.matchAll(/@media \(prefers-reduced-motion: reduce\)\s*\{([\s\S]*?)^\}/gm)]
    .map(m => m[1])
  const mine = blocks.find(b => b.includes('.update-notice button.update-now.glow'))
  assert.ok(mine, 'the update glow has no reduced-motion treatment at all')
  assert.match(mine, /animation:\s*none/, 'the pulse must stop')
  assert.match(mine, /box-shadow:[^;]*var\(--accent\)/,
    'a static accent halo must remain, or reduced motion loses the signal '
    + 'entirely rather than losing the movement')
})

test('hovering Update now names the DOWNLOADED target version, and says less '
  + 'rather than guessing when there is none', async () => {
  const bridge = { installUpdate: () => new Promise(() => {}) }
  const { push, teardown } = await mount({ state: 'idle' }, 20, bridge)
  await push({ state: 'pending-idle', version: '2.0.5' })
  const title = document.querySelector('button').title
  assert.match(title, /Update to Orgtree 2\.0\.5/,
    'the tooltip must name the version that was downloaded')
  await teardown()

  // THE ZERO EDGE: main/updater.ts carries `version` as optional and there is
  // a real path that leaves it unset (a cached autoDownload that fires
  // update-downloaded before the check records a downloading status). The
  // tooltip must not invent a number, and must never fall back to the
  // RUNNING version - the one thing the user said it must not show.
  const second = await mount({ state: 'idle' }, 20, bridge)
  await second.push({ state: 'pending-idle' })
  const bare = document.querySelector('button').title
  assert.equal(bare, 'Install the downloaded update and restart Orgtree')
  assert.doesNotMatch(bare, /\d+\.\d+/, 'no version may be invented')
  await second.teardown()
})

test('ready update offers one explicit restart action, while downloading does not', async () => {
  let calls = 0
  let rejectInstall
  const bridge = { installUpdate: () => { calls++; return new Promise((_, reject) => { rejectInstall = reject }) } }
  const { push, teardown } = await mount({ state: 'downloading', percent: 50 }, 20, bridge)
  assert.equal(document.querySelector('button'), null)
  await push({ state: 'pending-idle', version: '2.0.0-alpha.9' })
  const button = document.querySelector('button')
  assert.equal(button.textContent, 'Update now')
  await act(async () => button.click())
  assert.equal(calls, 1)
  assert.equal(button.disabled, true)
  await act(async () => button.click())
  assert.equal(calls, 1, 'repeated clicks cannot initiate another installation')
  await act(async () => rejectInstall(new Error('Engine could not stop')))
  assert.equal(document.querySelector('[role="alert"]').textContent, 'Engine could not stop')
  assert.equal(button.disabled, false, 'failure permits a retry')
  await teardown()
})
