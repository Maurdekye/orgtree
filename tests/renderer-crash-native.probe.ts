// renderer-crash-native.probe.ts — a REAL renderer, really killed, through the
// REAL handler, in a real Electron.
//
// ⚠ THIS IS THE TEST THAT MATTERS FOR THIS TICKET. The defect being fixed is
// that a whole class of failure happened in the dark, so a handler that looks
// correct and never fires would be the same defect wearing a fix. Everything
// here is the shipped code path: crashReporter.start with the shipped options,
// attachRendererFailureHandlers on a live BrowserWindow's webContents, and a
// renderer that is genuinely destroyed — once by Chromium's own crash entry
// point and once by killing its OS process from outside, which is what an
// out-of-memory kill actually looks like to this application.
import { app, BrowserWindow, crashReporter } from 'electron'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { attachRendererFailureHandlers, CRASH_REPORTER_OPTIONS, RecoveryBudget } from '../apps/desktop/main/process-failure'
import type { ProcessFailureStage } from '../apps/desktop/main/process-failure'

const root = path.join(os.tmpdir(), `orgtree-renderer-crash-${process.pid}`)
const dumps = path.join(root, 'crashes')
// The directories exist BEFORE Crashpad is pointed at them: a handler told to
// write into a path that does not exist yet fails to register.
fs.mkdirSync(dumps, { recursive: true })
app.setPath('userData', root)
app.setPath('crashDumps', dumps)
// Exactly as apps/desktop/main/index.ts starts it, and before whenReady.
crashReporter.start({ ...CRASH_REPORTER_OPTIONS, productName: 'OrgtreeCrashProbe' })

interface Line { stage: ProcessFailureStage; detail: string }
// A real file rather than a data: URL — a window created immediately after
// another one was destroyed refuses a data: URL with ERR_FAILED on this host,
// and the page being loaded is not what this probe is testing.
const PAGE = path.join(root, 'probe.html')
fs.writeFileSync(PAGE, '<!doctype html><meta charset="utf-8"><title>probe</title><body>probe</body>')

// Electron quits when the last window closes, and this probe destroys both of
// its windows before its last assertion. Without this the process exits 0 with
// the crash-reporter checks never run — a silent pass, which is the exact
// failure mode this whole ticket exists to end.
app.on('window-all-closed', () => {})

const loaded = (window: BrowserWindow) =>
  new Promise<void>(resolve => window.webContents.once('did-finish-load', () => resolve()))

const waitFor = async (what: string, predicate: () => boolean, budgetMs = 30000) => {
  const deadline = Date.now() + budgetMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert.fail(`timed out waiting for ${what}`)
}

/** A window wired with the SHIPPED handler, with the application's side
 *  effects captured instead of performed — except the reload, which is real,
 *  because "did the window actually come back?" is the question. */
function wire(window: BrowserWindow, limit?: number) {
  const lines: Line[] = [], announced: { title: string; body: string }[] = [], gaveUp: string[] = []
  let reloads = 0
  attachRendererFailureHandlers(window.webContents, {
    record: (stage, detail) => { lines.push({ stage, detail }); console.log(`  [${stage}] ${detail}`) },
    reload: () => { reloads++; if (!window.isDestroyed()) window.webContents.reload() },
    announce: (title, body) => announced.push({ title, body }),
    giveUp: detail => gaveUp.push(detail),
  }, limit === undefined ? new RecoveryBudget() : new RecoveryBudget(limit))
  return { lines, announced, gaveUp, reloads: () => reloads,
    find: (stage: ProcessFailureStage) => lines.filter(line => line.stage === stage) }
}

const open = async () => {
  const window = new BrowserWindow({ width: 600, height: 400, show: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } })
  await window.loadFile(PAGE)
  return window
}

app.whenReady().then(async () => {
  // ⚠ BOTH WINDOWS ARE OPENED AND LOADED UP FRONT. Measured on this host: a
  // BrowserWindow created after a sibling has been destroyed and its renderer
  // crashed refuses its first load with ERR_FAILED. That is a property of the
  // probe's own sequencing, not of the handler, so the probe sequences around
  // it rather than leaving a spurious failure in the record.
  const window = await open()
  const looping = await open()

  // ---------------------------------------------------------------- crash 1
  // Chromium's own crash entry point: the renderer dies the way a real crash
  // kills it, inside the sandbox, with a dump written by Crashpad.
  const observed = wire(window)
  const firstPid = window.webContents.getOSProcessId()
  assert.ok(firstPid > 0, 'the renderer has a real OS process')
  console.log(`renderer pid ${firstPid}; crashing it`)

  const reloadedOnce = loaded(window)
  window.webContents.forcefullyCrashRenderer()
  await waitFor('the crash to be recorded', () => observed.find('renderer-gone').length === 1)

  const gone = observed.find('renderer-gone')[0]!
  assert.match(gone.detail, /reason=/, 'the recorded line carries details.reason')
  assert.match(gone.detail, /exitCode=/, 'the recorded line carries details.exitCode')
  assert.equal(observed.find('renderer-recovered').length, 1, 'the failure was recovered, not reported')
  assert.equal(observed.gaveUp.length, 0, 'the user was not told to restart the application')
  assert.equal(observed.announced.length, 1, 'and was told the recovery happened')
  assert.match(observed.announced[0]!.body, /reloaded/i)

  await reloadedOnce
  assert.equal(window.isDestroyed(), false, 'the window survived')
  const secondPid = window.webContents.getOSProcessId()
  assert.ok(secondPid > 0 && secondPid !== firstPid, 'the reload produced a NEW render process')
  assert.equal(await window.webContents.executeJavaScript('document.body.textContent'), 'probe',
    'and the page is live again — this is the five-second recovery the dialog used to refuse')
  console.log(`recovered: renderer pid ${firstPid} -> ${secondPid}`)

  // ---------------------------------------------------------------- crash 2
  // The failure this ticket came from: the process is killed from OUTSIDE,
  // which is what an out-of-memory kill looks like from here. No Chromium
  // crash path is involved and no fault is raised, which is exactly why it
  // previously left no trace anywhere.
  const reloadedTwice = loaded(window)
  process.kill(secondPid)
  await waitFor('the external kill to be recorded', () => observed.find('renderer-gone').length === 2)
  const killed = observed.find('renderer-gone')[1]!
  assert.match(killed.detail, /reason=(killed|crashed|abnormal-exit)/, `externally killed renderer: ${killed.detail}`)
  assert.equal(observed.find('renderer-recovered').length, 2)
  await reloadedTwice
  const thirdPid = window.webContents.getOSProcessId()
  assert.ok(thirdPid > 0 && thirdPid !== secondPid, 'an externally killed renderer is recovered too')
  console.log(`recovered from external kill: renderer pid ${secondPid} -> ${thirdPid}`)
  window.destroy()

  // ------------------------------------------------------------ the bound
  // A renderer that keeps dying must stop being reloaded. Driven with a budget
  // of one so the fallback is reached in two real crashes rather than four.
  const bounded = wire(looping, 1)
  const reloadedAfterFirst = loaded(looping)
  looping.webContents.forcefullyCrashRenderer()
  await waitFor('the first bounded crash', () => bounded.find('renderer-recovered').length === 1)
  await reloadedAfterFirst
  looping.webContents.forcefullyCrashRenderer()
  await waitFor('the bound to be reached', () => bounded.gaveUp.length === 1)
  assert.equal(bounded.reloads(), 1, 'the second failure did NOT start another reload')
  assert.equal(bounded.find('renderer-gone').length, 2, 'but it was still recorded')
  assert.equal(bounded.find('renderer-recovery-exhausted').length, 1)
  assert.match(bounded.gaveUp[0]!, /reason=/, 'the dialog now carries the diagnosis')
  console.log('bound reached: reload stopped and the dialog took over')
  looping.destroy()

  // ------------------------------------------------------- the crash reporter
  // Crashpad writes into the directory this process nominated, and nowhere
  // else. `getUploadToServer()` is the live value, not the one we passed in.
  assert.equal(crashReporter.getUploadToServer(), false, 'nothing is uploaded')
  console.log(`crashDumps directory now holds: ${walk(dumps).map(f => path.relative(dumps, f)).join(', ') || '(nothing)'}`)
  await waitFor('a minidump to be written', () =>
    fs.existsSync(dumps) && walk(dumps).some(file => file.endsWith('.dmp')), 20000)
  const found = walk(dumps).filter(file => file.endsWith('.dmp'))
  console.log(`minidumps written locally: ${found.length} under ${dumps}`)
  assert.ok(found.length >= 1)

  console.log('renderer crash recovery probe passed')
  app.exit(0)
}).catch((error: unknown) => {
  console.error(error)
  app.exit(1)
})

function walk(dir: string): string[] {
  const out: string[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(full)); else out.push(full)
  }
  return out
}
