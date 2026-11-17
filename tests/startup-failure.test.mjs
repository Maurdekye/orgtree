// startup-failure.test.mjs — A FAILED START LEAVES EVIDENCE AND STAYS FINDABLE (@coordinator-opus m1047f5ff5d1e,
// 2026-11-17, after the 4.6.1-alpha.3 packaged smoke ran 150 s with a tray and no window).
// The startup catch in main/index.ts showed a parentless native error box and waited on it. In Session 0 (or behind
// other windows, off-screen) nobody sees that box, and nothing was written anywhere. Now, before the box:
//  - a "startup-failed" record (time + the error's message, bounded) goes to diagnostics/desktop-engine-exits.jsonl
//    under the data folder, asynchronously;
//  - the tray says Orgtree could not start, and its menu has "show the error", which shows the box again.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { build } from 'esbuild'

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'orgtree-startup-failure-'))
test.after(() => fs.rmSync(temp, { recursive: true, force: true }))
const modulePath = 'apps/desktop/main/startup-failure.ts'
const load = async () => {
  const out = path.join(temp, 'startup-failure.cjs')
  await build({ entryPoints: [modulePath], outfile: out, bundle: true, platform: 'node', format: 'cjs', external: ['electron'] })
  return createRequire(import.meta.url)(out)
}

test('the failure is recorded and the tray is marked BEFORE the error box is shown', async () => {
  assert.ok(fs.existsSync(modulePath), 'main/startup-failure.ts exists')
  const { reportStartupFailure } = await load()
  const order = []
  let release
  const shown = new Promise(r => { release = r })
  const done = reportStartupFailure(new Error('The engine could not confirm the application lifecycle operation.'), {
    record: async message => { order.push(['record', message]) },
    markTray: message => { order.push(['tray', message]) },
    show: message => { order.push(['show', message]); return shown },
  })
  await new Promise(r => setImmediate(r))
  assert.deepEqual(order.map(([step]) => step), ['record', 'tray', 'show'])
  assert.ok(order.every(([, message]) => message === 'The engine could not confirm the application lifecycle operation.'))
  let settled = false
  void done.then(() => { settled = true })
  await new Promise(r => setImmediate(r))
  assert.equal(settled, false, 'it still waits for the box, as before')
  release()
  await done
})

test('a failing or hung record never keeps the box from showing; an odd error still has a message', async () => {
  const { reportStartupFailure } = await load()
  const steps = []
  await reportStartupFailure('not an Error', {
    record: () => Promise.reject(new Error('disk full')),
    markTray: message => steps.push(['tray', message]),
    show: async message => steps.push(['show', message]),
  })
  assert.deepEqual(steps, [['tray', 'Unknown startup error'], ['show', 'Unknown startup error']])
  const hung = []
  const started = Date.now()
  await reportStartupFailure(new Error('x'), { record: () => new Promise(() => {}), markTray: () => hung.push('tray'),
    show: async () => hung.push('show') }, 50)
  assert.deepEqual(hung, ['tray', 'show'])
  assert.ok(Date.now() - started < 2000, 'bounded wait for the record')
})

test('the record is one JSON line in diagnostics/desktop-engine-exits.jsonl, message bounded', async () => {
  const { recordStartupFailure, STARTUP_FAILURE_MAX } = await load()
  const root = path.join(temp, 'data')
  await recordStartupFailure(root, 'first failure', () => new Date('2026-11-17T03:29:30Z'))
  await recordStartupFailure(root, 'x'.repeat(STARTUP_FAILURE_MAX + 100))
  const lines = fs.readFileSync(path.join(root, 'diagnostics', 'desktop-engine-exits.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l))
  assert.deepEqual(lines[0], { at: '2026-11-17T03:29:30.000Z', event: 'startup-failed', message: 'first failure' })
  assert.equal(lines[1].event, 'startup-failed')
  assert.equal(lines[1].message.length, STARTUP_FAILURE_MAX)
  await recordStartupFailure(path.join(temp, 'a-file', 'nested'), 'y').catch(() => assert.fail('never rejects'))
})

test('main wires it: the startup catch reports through it, and the tray offers the error', () => {
  const main = fs.readFileSync('apps/desktop/main/index.ts', 'utf8').replace(/\r\n/g, '\n')
  const catchAt = main.indexOf("    } catch (error) {\n      await reportStartupFailure(error, {")
  assert.ok(catchAt > 0, 'the startup catch calls reportStartupFailure')
  const body = main.slice(catchAt, main.indexOf('  }).catch(', catchAt))
  assert.match(body, /record: message => recordStartupFailure\(/)
  assert.match(body, /markTray: message => \{ startupFailure = message; rebuildTray\(\) \}/)
  assert.match(body, /show: showStartupFailure/)
  assert.match(body, /if \(!coreLifecycle\) app\.quit\(\)/, 'a start failure still never quits a core member')
  assert.equal(main.includes("await dialog.showMessageBox({ type: 'error', message: 'Orgtree could not start its engine.', detail: error instanceof Error"), false,
    'the bare parentless box is gone from the catch')
  const tray = main.slice(main.indexOf('  const rebuildTray = () => {'), main.indexOf('trayMenu = Menu.buildFromTemplate(['))
  assert.match(tray, /startupFailure \? 'Orgtree could not start - right-click for the error'/)
  const menu = main.slice(main.indexOf('trayMenu = Menu.buildFromTemplate(['), main.indexOf('trayMenu = Menu.buildFromTemplate([') + 600)
  assert.match(menu, /\.\.\.\(startupFailure \? \[\{ id: 'startup-error', label: 'Orgtree could not start: show the error'/)
})
