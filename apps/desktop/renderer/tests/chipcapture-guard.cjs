// chipcapture-guard.cjs — the isolation guard the chip captures (chipalign.capture.cjs, chipicons.capture.cjs) share, in the
// order the repaired rig guard uses (team TEST WINDOW ISOLATION + SILENT TESTS): nothing of a fixture loads or runs until
// every process is in Session 0 and the page's clipboard is guarded in its MAIN world.
//
//   A. MAIN PROCESS ONLY, no page access: this process and every Chromium child (app.getAppMetrics()) must be in Windows
//      Session 0 (Get-Process SessionId), --mute-audio set and every webContents muted, the permission handlers set, the
//      guard preload registered on the window, and every main-process clipboard function (this Electron's clipboard module has
//      six: clear, has, read, readText, write, writeText) stubbed with no call yet.
//   B. PAGE, STRUCTURE ONLY (no clipboard API, no execCommand): the guard installed by the preload, in the page's main
//      world before any page script, exists; navigator.clipboard and document.execCommand are its own functions.
//   C. PAGE, PROBES: readText / writeText reject, execCommand copy and paste throw. Only reached when A and B held.
//   Then the fixture script is injected, the capture runs, and finish() re-measures: every process still in Session 0, every
//   webContents still muted, no main clipboard call, and no page clipboard attempt beyond the probes' own.
//
// Pages are loaded INERT (the capture writes an index.html with stylesheets and an empty root and NO script); load() runs
// A, B and C against the committed renderer and only then adds the fixture's script. Each failed phase throws, so no fixture
// interaction follows a failed guard. Receipts are returned for the capture's results.json.
'use strict'
const fs = require('node:fs')
const path = require('node:path')
const cp = require('node:child_process')
const assert = require('node:assert/strict')

const sessionsOf = pids => {
  const out = cp.spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `Get-Process -Id ${pids.join(',')} -ErrorAction SilentlyContinue | Select-Object Id,SessionId | ConvertTo-Json -Compress`], { encoding: 'utf8', windowsHide: true })
  let rows = []
  try { const j = JSON.parse(out.stdout); rows = Array.isArray(j) ? j : [j] } catch { /* reported by the caller as a missing session */ }
  return new Map(rows.map(r => [r.Id, r.SessionId]))
}

/** this process and every Chromium child, each with its measured Windows SessionId (null when it could not be read) */
function measureProcesses(app) {
  const metrics = app.getAppMetrics().map(m => ({ pid: m.pid, type: m.type }))
  const pids = [process.pid, ...metrics.map(m => m.pid)].filter((v, i, a) => Number.isInteger(v) && v > 0 && a.indexOf(v) === i)
  const sessions = sessionsOf(pids)
  return pids.map(pid => ({ pid, type: pid === process.pid ? 'main' : metrics.find(m => m.pid === pid)?.type ?? 'unknown', sessionId: sessions.has(pid) ? sessions.get(pid) : null }))
}

const PRELOAD = `(() => {
  const guard = window.__chipGuard = { clipboardCalls: [], execBlocked: [] }
  const deny = name => () => { guard.clipboardCalls.push(name); return Promise.reject(Object.assign(Error('Clipboard denied'), { name: 'NotAllowedError' })) }
  Object.defineProperty(navigator, 'clipboard', { configurable: false, value: Object.freeze({ read: deny('read'), readText: deny('readText'), write: deny('write'), writeText: deny('writeText') }) })
  const exec = document.execCommand.bind(document)
  document.execCommand = (cmd, ...rest) => { if (/^(copy|cut|paste)$/i.test(String(cmd))) { guard.execBlocked.push(String(cmd)); throw Error('Clipboard denied') } return exec(cmd, ...rest) }
  window.__clipboardBlocked = true
})()`

/** electron: require('electron'); out: the run's output dir; returns the guarded window and its helpers */
function createGuard({ electron, out, width = 1100, height = 1500, partition = 'chip-capture' }) {
  const { app, BrowserWindow, session, clipboard } = electron
  const problems = []
  // the main-process clipboard: every function stubbed before any window exists
  const main = { stubbed: [], failed: [], calls: [] }
  for (const key of Object.keys(clipboard)) {
    if (typeof clipboard[key] !== 'function') continue
    try { clipboard[key] = () => { main.calls.push(key); return key === 'availableFormats' ? [] : key === 'has' ? false : '' }; main.stubbed.push(key) } catch { main.failed.push(key) }
  }
  const preloadPath = path.join(out, 'clipboard.preload.cjs')
  fs.writeFileSync(preloadPath, PRELOAD)
  const permissions = { checks: [], requests: [], handlerSet: false, checkSet: false }
  const blocked = []
  const ses = session.fromPartition(partition + '-' + process.pid)
  ses.setPermissionCheckHandler((_w, permission) => { permissions.checks.push(permission); return false }); permissions.checkSet = true
  ses.setPermissionRequestHandler((_w, permission, done) => { permissions.requests.push(permission); done(false) }); permissions.handlerSet = true
  ses.webRequest.onBeforeRequest((d, done) => { const ok = /^(file:|data:|blob:|about:)/.test(d.url); if (!ok) blocked.push(d.url); done({ cancel: !ok }) })
  // the page's main world has to be reachable for the guard, so no context isolation; the page has no Node (nodeIntegration off)
  const win = new BrowserWindow({ width, height, show: false, frame: false,
    webPreferences: { session: ses, offscreen: true, backgroundThrottling: false, nodeIntegration: false, sandbox: false, contextIsolation: false, preload: preloadPath } })
  const wc = win.webContents
  wc.setAudioMuted(true); wc.setWindowOpenHandler(() => ({ action: 'deny' }))
  wc.on('will-navigate', (e, url) => { if (!/^file:/.test(url)) { blocked.push(url); e.preventDefault() } })
  for (const k of ['copy', 'cut', 'paste', 'pasteAndMatchStyle']) wc[k] = () => { throw Error('Clipboard denied') }
  const nativeDenied = ['copy', 'cut', 'paste', 'pasteAndMatchStyle'].every(k => { try { wc[k](); return false } catch { return true } })
  const js = s => wc.executeJavaScript(s)
  const within = async (p, ms, what) => { let t; try { return await Promise.race([p, new Promise((_r, j) => { t = setTimeout(() => j(Error('Deadline: ' + what)), ms) })]) } finally { clearTimeout(t) } }
  const pages = []

  /** phases A, B and C against the committed (inert) page; throws on the first failure, before anything of the fixture runs */
  async function attest(what) {
    const rec = { what, at: new Date().toISOString() }
    // A. main process only
    rec.processes = measureProcesses(app)
    rec.muteSwitch = app.commandLine.hasSwitch('mute-audio')
    rec.webContentsMuted = require('electron').webContents.getAllWebContents().map(w => ({ id: w.id, muted: w.isAudioMuted() }))
    rec.permissionHandlers = { request: permissions.handlerSet, check: permissions.checkSet }
    rec.preload = path.basename(preloadPath)
    rec.mainClipboard = { stubbed: main.stubbed.length, failed: main.failed, calls: main.calls.length }
    const a = []
    if (!rec.processes.length || !rec.processes.every(p => p.sessionId === 0)) a.push('a process is not in Session 0: ' + JSON.stringify(rec.processes))
    if (!rec.muteSwitch) a.push('--mute-audio is not set')
    if (!rec.webContentsMuted.length || !rec.webContentsMuted.every(w => w.muted)) a.push('a webContents is not muted')
    if (!permissions.handlerSet || !permissions.checkSet) a.push('the permission handlers are not set')
    const need = ['clear', 'has', 'read', 'readText', 'write', 'writeText'].filter(k => !main.stubbed.includes(k))
    if (main.failed.length || need.length || main.stubbed.length !== Object.keys(electron.clipboard).filter(k => typeof electron.clipboard[k] === 'function').length)
      a.push('main clipboard stubs: ' + main.stubbed.length + ' stubbed (' + main.stubbed.join(',') + '), failed ' + JSON.stringify(main.failed) + ', missing ' + JSON.stringify(need))
    if (main.calls.length) a.push('the main clipboard was already called ' + main.calls.length + ' time(s)')
    if (!nativeDenied) a.push('native clipboard commands do not refuse')
    if (a.length) { rec.problems = a; pages.push(rec); throw Error('capture guard failed in phase A (main process), before any page access: ' + a.join(' | ')) }
    // B. page structure, no clipboard API and no execCommand
    rec.structure = await js(`(() => { const g = window.__chipGuard, own = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
      const native = fn => typeof fn !== 'function' || /\\[native code\\]/.test(Function.prototype.toString.call(fn))
      return { hasGuard: !!g, blocked: window.__clipboardBlocked === true, clipboardIsGuards: !!(own && own.value && !native(own.value.readText)), execCommandIsGuards: !native(document.execCommand),
        guardCallsAtStart: g ? g.clipboardCalls.length + g.execBlocked.length : null, fixtureScriptRan: typeof window.chipFixture + '/' + typeof window.deliveredFixture } })()`)
    const b = []
    const s = rec.structure
    if (!s.hasGuard || !s.blocked) b.push('the page clipboard guard is absent')
    if (!s.clipboardIsGuards) b.push('navigator.clipboard is not the guard stub')
    if (!s.execCommandIsGuards) b.push('document.execCommand is not the guard override')
    if (s.guardCallsAtStart !== 0) b.push('the guard already counted ' + s.guardCallsAtStart + ' clipboard attempt(s)')
    if (s.fixtureScriptRan !== 'undefined/undefined') b.push('a fixture script already ran: ' + s.fixtureScriptRan)
    if (b.length) { rec.problems = b; pages.push(rec); throw Error('capture guard failed in phase B (page structure), before any clipboard operation: ' + b.join(' | ')) }
    // C. probes, only against the guard's stubs
    rec.probes = await js(`(async () => { const attempt = async fn => { try { await fn(); return 'resolved' } catch (e) { return String((e && e.name) || e) } }
      const exec = c => { try { return String(document.execCommand(c)) } catch { return 'threw' } }
      return { readText: await attempt(() => navigator.clipboard.readText()), writeText: await attempt(() => navigator.clipboard.writeText('x')), execCopy: exec('copy'), execPaste: exec('paste') } })()`)
    const c = []
    if (rec.probes.readText !== 'NotAllowedError' || rec.probes.writeText !== 'NotAllowedError' || rec.probes.execCopy !== 'threw' || rec.probes.execPaste !== 'threw')
      c.push('the page clipboard guard did not refuse: ' + JSON.stringify(rec.probes))
    if (c.length) { rec.problems = c; pages.push(rec); throw Error('capture guard failed in phase C (clipboard probes): ' + c.join(' | ')) }
    rec.problems = []
    pages.push(rec)
    return rec
  }

  /** load an INERT page, attest it, then add the fixture's script (a path relative to the page) and wait for it */
  async function load(htmlFile, scriptName, name) {
    await within(win.loadFile(htmlFile), 15000, 'load ' + name)
    await attest(name + ', inert, before its script')
    await js(`new Promise((resolve, reject) => { const s = document.createElement('script'); s.src = ${JSON.stringify(scriptName)}; s.onload = resolve; s.onerror = () => reject(Error('fixture script did not load')); document.body.appendChild(s) })`)
  }

  /** after the run: sessions, mute and counters again; any breach fails the run */
  async function finish() {
    const processes = measureProcesses(app)
    const muted = require('electron').webContents.getAllWebContents().map(w => ({ id: w.id, muted: w.isAudioMuted() }))
    const page = await js('({ clipboardCalls: window.__chipGuard.clipboardCalls.length, execBlocked: window.__chipGuard.execBlocked.length })')
    const post = { processes, muted, mainClipboardCalls: main.calls.length, page }
    const p = []
    if (!processes.every(x => x.sessionId === 0)) p.push('a process is not in Session 0 after the run: ' + JSON.stringify(processes))
    if (!muted.every(x => x.muted)) p.push('a webContents is not muted after the run')
    if (main.calls.length) p.push('the main clipboard was called ' + main.calls.length + ' time(s) during the run')
    // the counters belong to the page on screen (a new document starts them again): its own probes are the only clipboard
    // attempts allowed, 2 API calls and 2 execCommands, all refused
    if (page.clipboardCalls > 2 || page.execBlocked > 2) p.push('the page attempted the clipboard during the run: ' + JSON.stringify(page))
    post.problems = p
    if (p.length) throw Error('capture guard failed after the run: ' + p.join(' | '))
    return { pages, post, deniedPermissions: [...permissions.checks.map(x => 'check:' + x), ...permissions.requests.map(x => 'request:' + x)], blockedRequests: blocked, nativeClipboardDenied: nativeDenied,
      mainClipboard: { stubbed: main.stubbed.length, calls: main.calls.length } }
  }

  return { ses, win, wc, js, within, load, attest, finish, clipboardCalls: () => main.calls.length, problems }
}

module.exports = { createGuard, measureProcesses }
