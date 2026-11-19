// The in-app "Quit Orgtree" and the tray's "Quit Orgtree" are ONE path (USER 2026-11-19 m8b45545c043f; coordinator
// design call 1: no second shutdown implementation). Both call `quitOrgtree`, which is app.quit(): the before-quit
// handler then confirms, stops the engine, mail hub and database exactly as it always did for the tray.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'

const main = fs.readFileSync('apps/desktop/main/index.ts', 'utf8')
const preload = fs.readFileSync('apps/desktop/preload/index.ts', 'utf8')
const contracts = fs.readFileSync('packages/contracts/index.ts', 'utf8')
const app = fs.readFileSync('apps/desktop/renderer/src/App.tsx', 'utf8')

test('one quit function: the tray entry and the window command both call it, and it is app.quit()', () => {
  const defs = [...main.matchAll(/^\s*const quitOrgtree = (.+)$/gm)]
  assert.equal(defs.length, 1, 'quitOrgtree is defined once')
  let calls = 0
  const quitOrgtree = vm.runInNewContext(`(${defs[0][1]})`, { app: { quit: () => { calls++ } } })
  quitOrgtree()
  assert.equal(calls, 1, 'it asks Electron to quit, once, and does nothing else')
  assert.match(main, /\{ label: 'Quit Orgtree', click: \(\) => quitOrgtree\(\) \}/, 'the tray entry')
  assert.match(main, /handleApp\('desktop:quit', \(\) => \{ quitOrgtree\(\) \}\)/, 'the window command')
  assert.equal([...main.matchAll(/label: 'Quit Orgtree'/g)].length, 1)
})

test('the command is registered and bridged on every platform', () => {
  const at = main.indexOf("handleApp('desktop:quit'"), line = main.slice(main.lastIndexOf('\n', at) + 1, main.indexOf('\n', at))
  assert.doesNotMatch(line, /platform|darwin|win32|linux/, 'no platform condition on the registration')
  assert.equal([...main.matchAll(/'desktop:quit'/g)].length, 1, 'one registration')
  assert.equal([...preload.matchAll(/'desktop:quit'/g)].length, 1, 'one bridge method, the existing quit()')
  assert.match(preload, /^\s*quit: \(\) => ipcRenderer\.invoke\('desktop:quit'\),$/m)
  assert.match(contracts, /^\s*quit\(\): Promise<void>$/m)
})

test('the app menu offers Quit whenever the desktop bridge has it, with no platform test', () => {
  const m = app.match(/onQuit=\{([^}]+)\}/)
  assert.ok(m, 'the shell menu gets onQuit')
  assert.equal(m[1].trim(), 'desktop() ? quitOrgtree : undefined')
  assert.match(app, /const quitOrgtree = useCallback\(\(\) => \{\s*void desktop\(\)\?\.quit\(\)/)
  assert.doesNotMatch(m[1], /platform|isMac|isLinux|isWindows/)
})
