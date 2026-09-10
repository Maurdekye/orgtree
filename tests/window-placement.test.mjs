import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { build } from 'esbuild'
import { createRequire } from 'node:module'
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'orgtree-placement-'))
const output = path.join(temp, 'placement.cjs')
await build({ entryPoints: ['apps/desktop/main/window-placement.ts'], outfile: output, bundle: true, platform: 'node', format: 'cjs' })
const { WindowPlacement, fitWindow } = createRequire(import.meta.url)(output)
const area = { x: 0, y: 0, width: 1920, height: 1040 }

test('normal bounds and maximization survive a new store instance; minimization does not erase them', () => {
  const file = path.join(temp, 'state.json')
  const bounds = { x: 85, y: 45, width: 1100, height: 800 }
  let minimized = false, maximized = true
  const window = { isDestroyed: () => false, isMinimized: () => minimized,
    isMaximized: () => maximized, getNormalBounds: () => bounds }
  const first = new WindowPlacement(file)
  first.capture(window)
  assert.deepEqual(new WindowPlacement(file).restore([area]), { bounds, maximized: true })
  minimized = true; maximized = false
  first.capture(window)
  assert.equal(new WindowPlacement(file).restore([area]).maximized, true)
  minimized = false
  bounds.x = 120; bounds.width = 990
  first.capture(window)
  assert.deepEqual(new WindowPlacement(file).restore([area]), { bounds, maximized: false })
})

test('a removed monitor is recovered; a still-present negative-coordinate monitor stays exact', () => {
  const left = { x: -1920, y: 0, width: 1920, height: 1040 }
  const saved = { x: -1600, y: 120, width: 1200, height: 700 }
  assert.deepEqual(fitWindow(saved, [area, left]), saved)
  assert.deepEqual(fitWindow(saved, [area]), { ...saved, x: 0 })
  assert.deepEqual(fitWindow({ x: 0, y: 0, width: 4000, height: 2000 }, [area]), area)
})

test('malformed persisted geometry is ignored', () => {
  const file = path.join(temp, 'bad.json')
  fs.writeFileSync(file, JSON.stringify({ bounds: { x: null, y: 0, width: 900, height: 700 }, maximized: true }))
  assert.equal(new WindowPlacement(file).restore([area]), undefined)
})
