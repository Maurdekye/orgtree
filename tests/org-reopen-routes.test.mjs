// Synthetic lifecycle test: production shell callbacks + real placement JSON.
// No Electron app, user profile, engine, installer or provider is started.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { registerHooks, stripTypeScriptTypes } from 'node:module'

const root = path.resolve(import.meta.dirname, '..')
const out = path.resolve(process.env.ORG_REOPEN_TEST_OUT || '')
assert.match(out.replaceAll('\\', '/'), /^C:\/orgtree-build\/[^/]+\/.+/i,
  'ORG_REOPEN_TEST_OUT must name the rig assigned C artifact directory')
fs.mkdirSync(out, { recursive: true })
const rootUrl = pathToFileURL(root + path.sep).href
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('.') && context.parentURL?.startsWith(rootUrl)) {
      const target = new URL(specifier, context.parentURL)
      if (!path.extname(target.pathname) && fs.existsSync(fileURLToPath(target) + '.ts')) {
        return next(target.href + '.ts', context)
      }
    }
    return next(specifier, context)
  },
  load(url, context, next) {
    if (url.startsWith(rootUrl) && url.endsWith('.ts')) return { format: 'module', shortCircuit: true,
      source: stripTypeScriptTypes(fs.readFileSync(new URL(url), 'utf8'), { mode: 'transform', sourceUrl: url }) }
    return next(url, context)
  },
})
const { OrgPlacement, orgOfKey } = await import('../apps/desktop/main/org-placement.ts')
const { planRestore } = await import('../apps/desktop/main/org-windows.ts')
const { performClose } = await import('../apps/desktop/main/window-close.ts')
const main = fs.readFileSync(path.join(root, 'apps/desktop/main/index.ts'), 'utf8').replaceAll('\r\n', '\n')
const section = (start, end) => {
  const a = main.indexOf(start), b = main.indexOf(end, a)
  assert.ok(a >= 0 && b > a, `production source markers: ${start}`)
  return main.slice(a, b)
}
const quitCode = section("  app.on('before-quit', event => {", '  app.whenReady().then(')
const installerCode = section('  const requestInstallerUpgradeShutdown = async () => {', '  const quitAfterLastView = ')
const closeCode = section("        window.on('close', event => {", '        // ⚠ THE WINDOW IS RECOVERED')
const startupCode = section('      const openStartupWindows = async ', '      engineReady = true')
const revealCode = section("      if (!process.argv.includes('--background'))", '      // Not awaited:')
const signalCode = section("  for (const signal of ['SIGHUP'", '  /** ⚠ A GRACEFUL QUIT OWES')
const engineRestartCode = section('  const restartEngine = async () => {', '  let trayHarnesses:')
const maintenanceRestartCode = section('    restart: async () => {', '    // Unattended, though')
const updateCaptureCode = section('    if (quitting) return\n    engine.cancelLaunches()', '    if (poll) clearInterval(poll)')
// A missing native session listener is a behavioral no-op on the baseline,
// rather than an extraction/import failure masquerading as a regression.
const sessionEndCode = main.match(/        window\.on\('session-end',[\s\S]*?\n        \}\)/)?.[0] || ''
const shutdownCaptureCode = main.includes('  const captureOpenWindowsForShutdown = ')
  ? section('  const captureOpenWindowsForShutdown = ', '  let restoreWindows = ') : ''
const run = (context, code) => new vm.Script(stripTypeScriptTypes(code, { mode: 'transform' })).runInContext(context)
const screens = [{ x: 0, y: 0, width: 1920, height: 1080 }]
const slugs = ['alpha', 'beta', 'gamma']
const placements = slugs.map((_, i) => ({ bounds: { x: 40 + i * 100, y: 60 + i * 80, width: 800, height: 600 }, maximized: i === 1 }))
let sequence = 0
class Window {
  constructor(at, visible = true) { this.at = at; this.visible = visible; this.destroyed = false; this.handlers = new Map() }
  on(name, fn) { const list = this.handlers.get(name) || []; list.push(fn); this.handlers.set(name, list) }
  isDestroyed() { return this.destroyed }
  isVisible() { return this.visible && !this.destroyed }
  isMinimized() { return false }
  isMaximized() { return this.at.maximized }
  getNormalBounds() { return this.at.bounds }
  hide() { this.visible = false }
  emit(name, event) { for (const fn of this.handlers.get(name) || []) fn(event) }
}
async function fixture() {
  const file = path.join(out, `windows-${++sequence}.json`), placement = new OrgPlacement(file)
  const records = new Map(), callbacks = new Map(), signals = new Map()
  const context = vm.createContext({ console, records, placement, performClose, planRestore, orgOfKey,
    quitting: false, quitComplete: false, quitConfirmed: true, quitPrompting: false,
    installerUpgradeShutdown: false, installerUpgradePending: false, engineReady: true,
    coreStopRequested: false, coreQuitPrepared: true, poll: undefined, trayPopupSeq: 0,
    engineRestartOptions: { synthetic: true }, engineRestartBlocked: () => false,
    resumeEngineStartup: undefined, refreshTrayEngine() {}, rebuildTray() {}, relaunches: 0,
    preferences: { get: () => ({ exitOnClose: true, startupMode: 'restore' }) },
    windows: { beginClose: () => 'close', settleClose() {} },
    updateLog: { record() {} }, coreLifecycle: { stop() {}, async transition() {}, async complete() {} },
    engine: { cancelLaunches() {}, async stopForQuit() {}, async stopGracefullyForInstaller() { return true } },
    bounded: promise => promise, UPDATE_LAYOUT_MS: 1, UPDATE_DEADLINES: { layoutMs: 1 },
    QUIT_STOP_BUDGET_MS: 1, QUIT_ENGINE_TOTAL_MS: 1, INSTALLER_UPGRADE_STOP_BUDGET_MS: 1,
    credentialBridge: { async release() {} }, tray: { destroy() {} }, closeTrayPopup() {},
    cancelProviderLogin() {}, windowEvents: { record() {} }, windowFacts() {},
    clearInterval() {}, dialog: { async showMessageBox() { return { response: 0 } } }, CREATION_DISCARD_DIALOG: {},
    process: { argv: [], on: (name, fn) => signals.set(name, fn) },
    savePlacement: record => placement.captureWindow(record.placementKey, record.window),
    async saveWindowLayout() { for (const record of records.values()) context.savePlacement(record) },
    BrowserWindow: { getAllWindows: () => [...records.values()].map(record => record.window) },
  })
  context.relaunchApp = () => { context.relaunches++ }
  let closing = false
  context.app = { on: (name, fn) => callbacks.set(name, fn), quit() {
    if (closing) return
    closing = true
    try {
      const event = { prevented: false, preventDefault() { this.prevented = true } }
      callbacks.get('before-quit')?.(event)
      if (!event.prevented) for (const record of [...records.values()]) close(record)
    } finally { closing = false }
  } }
  const close = record => {
    const event = { prevented: false, preventDefault() { this.prevented = true } }
    record.window.emit('close', event)
    if (!event.prevented) { record.window.destroyed = true; records.delete(record.id) }
  }
  for (const [i, slug] of slugs.entries()) {
    const record = { id: slug, placementKey: `org:${slug}`, window: new Window(placements[i]), owned: new Set() }
    records.set(slug, record); placement.captureWindow(record.placementKey, record.window); placement.openedWindow(record.placementKey)
    context.hostRecord = record
    run(context, `(function(record, window, id) { ${sessionEndCode}\n${closeCode} })(hostRecord, hostRecord.window, hostRecord.id)`)
  }
  run(context, shutdownCaptureCode + quitCode + installerCode + signalCode + engineRestartCode)
  return { file, context, records, close, signals,
    quit: async () => { context.app.quit(); await new Promise(setImmediate); assert.equal(context.quitComplete, true) },
    install: async () => { await run(context, 'requestInstallerUpgradeShutdown()') },
  }
}
async function startup(file, { background = false, mode = 'restore' } = {}) {
  const placement = new OrgPlacement(file), records = new Map()
  const context = vm.createContext({ console, placement, records, planRestore, orgOfKey,
    preferences: { get: () => ({ startupMode: mode }) }, process: { argv: background ? ['--background'] : [] },
    sendTo() {}, async openWindow({ kind, org }) {
      const key = org ? `org:${org}` : 'homepage'
      const record = { id: key, org, kind, placementKey: key,
        window: new Window(placement.restoreWindow(key, screens) || placements[0], false) }
      records.set(key, record); return record
    }, revealWindow: record => { record.window.visible = true },
  })
  await run(context, `(async () => { ${startupCode} ${revealCode} })()`)
  return { placement, records, visible: [...records.values()].filter(record => record.window.isVisible()) }
}
async function expectThree(file) {
  const restored = await startup(file)
  assert.deepEqual(restored.placement.sessionWindows(), slugs.map(slug => `org:${slug}`), 'shutdown retains all three memberships')
  assert.equal(restored.records.size, 3, 'startup constructs every saved org window')
  assert.deepEqual(restored.visible.map(record => record.org).sort(), [...slugs], 'all saved org windows are visible after startup')
  for (const [i, slug] of slugs.entries()) assert.deepEqual(restored.records.get(`org:${slug}`).window.at, placements[i])
}
for (const route of ['tray Quit', 'app menu Quit']) test(`${route}: all three windows reopen visibly at saved placements`, async () => {
  const f = await fixture(); await f.quit(); await expectThree(f.file)
})
test('installer control shutdown: all three windows reopen visibly at saved placements', async () => {
  const f = await fixture(); await f.install(); await expectThree(f.file)
})
test('background launch retains all three saved windows without showing them', async () => {
  const f = await fixture(); await f.quit(); const restored = await startup(f.file, { background: true })
  assert.equal(restored.records.size, 3); assert.equal(restored.visible.length, 0)
})
test('deliberate close removes only that org before Quit; both remaining windows reopen visibly', async () => {
  const f = await fixture(); f.close(f.records.get('alpha')); await f.quit(); const restored = await startup(f.file)
  assert.deepEqual(restored.placement.sessionWindows(), ['org:beta', 'org:gamma'])
  assert.deepEqual(restored.visible.map(record => record.org).sort(), ['beta', 'gamma'])
})
test('closing the last org with exitOnClose restores that last org only', async () => {
  const f = await fixture(); f.close(f.records.get('alpha')); f.close(f.records.get('beta'))
  f.close(f.records.get('gamma')); await new Promise(setImmediate)
  const restored = await startup(f.file)
  assert.deepEqual(restored.placement.sessionWindows(), ['org:gamma']); assert.equal(restored.visible[0].org, 'gamma')
})
test('a refused installer shutdown leaves deliberate-close membership behavior intact', async () => {
  const f = await fixture(); f.context.engine.stopGracefullyForInstaller = async () => false
  await f.install(); assert.equal(f.context.quitting, false); assert.equal(f.context.installerUpgradeShutdown, false)
  f.close(f.records.get('alpha')); assert.deepEqual(new OrgPlacement(f.file).sessionWindows(), ['org:beta', 'org:gamma'])
})
test('explicit Homepage startup mode opens one Homepage', async () => {
  const f = await fixture(); await f.quit(); const restored = await startup(f.file, { mode: 'homepage' })
  assert.equal(restored.visible.length, 1); assert.equal(restored.visible[0].kind, 'homepage')
})

for (const signal of ['SIGHUP', 'SIGINT', 'SIGBREAK']) test(`${signal}: shutdown preserves the full reopen set before close callbacks`, async () => {
  const f = await fixture(); f.signals.get(signal)()
  assert.deepEqual(new OrgPlacement(f.file).sessionWindows(), slugs.map(slug => `org:${slug}`), 'signal teardown must not remove any org')
  await expectThree(f.file)
})

for (const reason of ['shutdown', 'logoff']) test(`Windows ${reason}: session-end preserves all orgs and latest placements without before-quit`, async () => {
  const f = await fixture()
  const latest = { bounds: { x: 555, y: 333, width: 850, height: 650 }, maximized: false }
  f.records.get('alpha').window.at = latest
  // Windows does not emit app.before-quit for this route. Exercise the final,
  // noncancelable event, followed by teardown callbacks in arbitrary order.
  f.records.get('alpha').window.emit('session-end', { reasons: [reason] })
  for (const record of [...f.records.values()]) f.close(record)
  const store = new OrgPlacement(f.file)
  assert.deepEqual(store.sessionWindows(), slugs.map(slug => `org:${slug}`), 'session end must retain every open org')
  assert.deepEqual(store.restoreWindow('org:alpha', screens), latest, 'final session event captures latest geometry synchronously')
  const restored = await startup(f.file)
  assert.deepEqual(restored.visible.map(record => record.org).sort(), [...slugs])
})

test('a queried but cancelled Windows session leaves deliberate-close behavior intact', async () => {
  const f = await fixture()
  f.records.get('alpha').window.emit('query-session-end', { reasons: ['logoff'] })
  f.close(f.records.get('alpha'))
  assert.equal(f.context.quitting, false)
  assert.deepEqual(new OrgPlacement(f.file).sessionWindows(), ['org:beta', 'org:gamma'])
})

test('engine restart keeps all three existing org windows and their placements', async () => {
  const f = await fixture(); const before = [...f.records.values()]
  let restarted = 0
  f.context.coreLifecycle.restart = async fn => { await fn() }
  f.context.engine.restart = async options => { assert.equal(options.synthetic, true); restarted++ }
  await run(f.context, 'restartEngine()')
  assert.equal(restarted, 1); assert.equal(f.context.quitting, false)
  assert.deepEqual([...f.records.values()], before)
  assert.equal(before.every(record => record.window.isVisible()), true)
  assert.deepEqual(new OrgPlacement(f.file).sessionWindows(), slugs.map(slug => `org:${slug}`))
  for (const [i, record] of before.entries()) assert.deepEqual(record.window.at, placements[i])
})

test('engine-requested app restart reopens every saved org visibly', async () => {
  const f = await fixture()
  await run(f.context, `({ ${maintenanceRestartCode} }).restart()`)
  await new Promise(setImmediate)
  assert.equal(f.context.relaunches, 1); assert.equal(f.context.quitComplete, true)
  await expectThree(f.file)
})

test('updater pre-handoff snapshot preserves all three orgs through completed quit', async () => {
  const f = await fixture()
  run(f.context, `(function() { ${updateCaptureCode} })()`)
  f.context.quitComplete = true; f.context.app.quit()
  await expectThree(f.file)
})
