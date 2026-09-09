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
const dir = fs.mkdtempSync(path.join(root, 'node_modules', '.window-controls-ui-test-'))
const output = path.join(dir, 'window-controls.cjs')
await build({
  entryPoints: [path.join(root, 'apps/desktop/renderer/src/window-controls.tsx')],
  outfile: output, bundle: true, platform: 'node', format: 'cjs', jsx: 'automatic',
  external: ['react', 'react/jsx-runtime'],
  plugins: [{ name: 'test-icons', setup(build) {
    build.onResolve({ filter: /^\.\/icons$/ }, () => ({ path: 'icons', namespace: 'window-controls-test' }))
    build.onLoad({ filter: /.*/, namespace: 'window-controls-test' }, () => ({
      contents: `import React from 'react'
        const Icon = props => React.createElement('span', props)
        export const CloseIcon = Icon
        export const MaximizeIcon = Icon
        export const MinimizeIcon = Icon
        export const RestoreIcon = Icon`,
      loader: 'tsx',
    }))
  }}],
})

test('mounted window controls invoke the scoped bridge and track maximize events', async () => {
  const dom = new JSDOM('<div id="app"></div>', { url: 'http://localhost' })
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const listeners = new Set()
  const calls = []
  window.orgtreeDesktop = {
    getWindowControlsState: async () => ({ visible: true, restoreWindows: true, minimized: false, maximized: false }),
    onEvent: listener => { listeners.add(listener); return () => listeners.delete(listener) },
    minimizeWindow: async () => { calls.push('minimize') },
    toggleMaximizeWindow: async () => { calls.push('toggle-maximize') },
    closeWindow: async () => { calls.push('close') },
  }
  const { WindowControls } = createRequire(import.meta.url)(output)
  const target = document.getElementById('app')
  const rootNode = createRoot(target)
  await act(async () => rootNode.render(React.createElement(WindowControls)))
  assert.equal(document.querySelectorAll('.window-control').length, 3)
  assert.equal(document.querySelector('[aria-label="Window controls"]').getAttribute('role'), 'group')
  await act(async () => document.querySelector('[aria-label="Minimize window"]').click())
  await act(async () => document.querySelector('[aria-label="Maximize window"]').click())
  await act(async () => document.querySelector('[aria-label="Close window"]').click())
  assert.deepEqual(calls, ['minimize', 'toggle-maximize', 'close'])
  await act(async () => { for (const listener of listeners) listener({ type: 'window-state', data: { visible: true, restoreWindows: true, minimized: false, maximized: true } }) })
  assert.ok(document.querySelector('[aria-label="Restore window"]'))
  await act(async () => rootNode.unmount())
  assert.equal(listeners.size, 0)
  dom.window.close()
})
