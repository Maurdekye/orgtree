import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { build } from 'esbuild'
import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'

const root = path.resolve(import.meta.dirname, '..')
const dir = fs.mkdtempSync(path.join(root, 'node_modules', '.update-notice-ui-test-'))
const output = path.join(dir, 'update-notice.cjs')
await build({
  entryPoints: [path.join(root, 'apps/desktop/renderer/src/update-notice.tsx')],
  outfile: output, bundle: true, platform: 'node', format: 'cjs', jsx: 'automatic',
  external: ['react', 'react/jsx-runtime'],
})
const { UpdateNotice } = createRequire(import.meta.url)(output)

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

test('pending-idle stays visible (no auto-hide) and reports the ready-to-install message', async () => {
  const { push, teardown } = await mount({ state: 'idle' }, 50)
  await push({ state: 'pending-idle', version: '2.0.0-alpha.6' })
  assert.match(document.querySelector('.update-notice').textContent, /installs automatically when idle/)
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
