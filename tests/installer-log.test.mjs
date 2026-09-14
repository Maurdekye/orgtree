// installer-log.test.mjs — DOES THE INSTALLER'S OWN LOG SURVIVE AN INSTALLER
// THAT DIES PARTWAY?
//
// WHY THIS IS THE QUESTION. A 2.1.3 → 2.1.4 update failed twice on one machine.
// The application's log proved what the APPLICATION did and then stopped,
// because everything after the handoff happens inside the installer and the
// installer left nothing behind: the one diagnostic it had was written by a
// helper the silent path never calls. The investigation therefore could not say
// which internal branch ended the run, and the leading hypothesis was later
// refuted by measurement — so the incident is unexplained and this log is the
// instrument that would answer it. A log that only exists on paths where the
// installer got far enough to write it would be empty in exactly those
// incidents, which is why the property measured here is SURVIVAL OF AN ABORT
// rather than "the log can be written".
//
// ⚠ THE CODE UNDER TEST IS THE SHIPPED CODE. The `OrgLog` macro, the
// `orgtreeInstallerLog` function and the size bound are extracted from
// build/installer.nsh at test time and compiled by the real makensis from
// electron-builder's cache. Edit the installer and this test follows; copy the
// function in here and it would only ever agree with a snapshot.
//
// ⚠ AND WHAT IT DOES NOT PROVE, stated here rather than left to be inferred:
// this drives the LOGGING PATH, not a real installation. It does not build or
// run an electron-builder installer, does not install anything, and does not
// touch a real installed release. Compiling an installer locally would not be
// publishing and is not forbidden — what is declined is RUNNING a real Orgtree
// installer, because this machine hosts the organisation and everyone's
// in-flight work. So the full end-to-end integration stays unexercised, and
// that limit is recorded on the ticket rather than papered over here.
//
// Run: node --test tests/installer-log.test.mjs

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile, spawn } from 'node:child_process'

const root = path.resolve(import.meta.dirname, '..')
const installerNsh = path.join(root, 'build', 'installer.nsh')

/** electron-builder's cached toolchain — the compiler the published installer
 *  is built with, rather than any makensis on PATH. */
const cache = path.join(process.env.LOCALAPPDATA || '', 'electron-builder', 'Cache')
const underVersionDir = (parent, ...tail) => {
  try {
    for (const entry of fs.readdirSync(parent)) {
      const candidate = path.join(parent, entry, ...tail)
      if (fs.existsSync(candidate)) return candidate
    }
  } catch { /* nothing cached */ }
  return ''
}
const makensis = underVersionDir(path.join(cache, 'nsis-3.0.4.1'), 'makensis.exe')

/** Lift a region out of the shipped installer script. */
const shipped = (startsWith, endsWith) => {
  const source = fs.readFileSync(installerNsh, 'utf8')
  const begin = source.indexOf(startsWith)
  assert.ok(begin >= 0, `build/installer.nsh must still contain ${JSON.stringify(startsWith)}`)
  const end = source.indexOf(endsWith, begin)
  assert.ok(end > begin, `and its ${JSON.stringify(endsWith)}`)
  return source.slice(begin, end + endsWith.length).replace(/\r\n/g, '\n')
}
const logMacro = () => shipped('!macro OrgLog stage detail', '!macroend')
const logFunction = () => shipped('Function orgtreeInstallerLog', 'FunctionEnd')
const sizeBound = () => {
  const found = /!define ORGTREE_LOG_MAX_BYTES (\d+)/.exec(fs.readFileSync(installerNsh, 'utf8'))
  assert.ok(found, 'the size bound must still be defined in build/installer.nsh')
  return Number(found[1])
}

const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'orgtree-installer-log-'))
/** ⚠ ASSEMBLED FROM CHAR CODES, not written as an escape in this file. A shell
 *  heredoc turned `\r` into a real carriage return once already and makensis
 *  reported "unterminated string"; keeping the backslash out of the source
 *  removes the whole class of problem. */
const BS = String.fromCharCode(92)

/** Build a probe around the shipped logger. `body` is NSIS run inside its
 *  section, so a test can abort partway, log nothing at all, or run to the end. */
const probeSource = (exe, body) => [
  'Unicode true',
  'Name "orgtree-installer-log-probe"',
  `OutFile "${exe}"`,
  'RequestExecutionLevel user',
  'SilentInstall silent',
  '!include LogicLib.nsh',
  '!include FileFunc.nsh',
  `!define ORGTREE_LOG_MAX_BYTES ${sizeBound()}`,
  'Var OrgLogPath',
  'Var OrgLogStage',
  'Var OrgLogDetail',
  logFunction(),
  logMacro(),
  '',
  'Section "probe"',
  body,
  'SectionEnd',
  '',
].join('\n')

/** ⚠ THE PROBE IS COMPILED INTO THE DIRECTORY IT WILL RUN IN. The log goes to
 *  $EXEDIR, which is where the EXECUTABLE sits - not the working directory. A
 *  first version compiled every probe into one shared folder and ran it with a
 *  cwd, so all of them wrote to the same shared log and every assertion about a
 *  per-test file failed while the logger itself was working perfectly. */
const compile = (name, body, dir) => new Promise((resolve, reject) => {
  const exe = path.join(dir, `${name}.exe`)
  const script = path.join(dir, `${name}.nsi`)
  // UTF-8 with a BOM: makensis reads an unmarked file as the ANSI codepage, and
  // the shipped script's comments are not all ASCII.
  fs.writeFileSync(script, '﻿' + probeSource(exe, body), 'utf8')
  execFile(makensis, [script], { windowsHide: true, timeout: 120000, maxBuffer: 8 << 20 },
    (error, stdout, stderr) => error
      ? reject(new Error(`makensis failed for ${name}: ${String(stderr || stdout).slice(-2000)}`))
      : resolve(exe))
})

/** Run a compiled probe from its own directory, so $EXEDIR — where the log is
 *  written — is a directory this test owns. */
const run = (exe, dir) => new Promise((resolve, reject) => {
  const child = spawn(exe, [], { cwd: dir, windowsHide: true, stdio: 'ignore' })
  child.on('error', reject)
  child.on('exit', code => resolve(code))
})

const logIn = (dir) => path.join(dir, 'orgtree-installer.log')
const readLog = (file) => { try { return fs.readFileSync(file, 'utf8') } catch { return '' } }
const stages = (text) => [...text.matchAll(/\[([a-z-]+)\]/g)].map(match => match[1])

const freshDir = (name) => {
  const dir = path.join(workdir, name)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

test.after(() => { try { fs.rmSync(workdir, { recursive: true, force: true }) } catch { /* temp */ } })

test('the shipped logger and the real compiler are both present', () => {
  assert.ok(makensis, `makensis must be available (looked under ${cache})`)
  assert.match(logFunction(), /FileWrite \$0/, 'the shipped function must still write to a file')
  assert.match(logFunction(), /FileClose \$0/,
    'and CLOSE it on every line — that is what makes an aborted run readable')
  assert.match(logMacro(), /Call orgtreeInstallerLog/, 'and the macro must still call it')
})

test('§1 THE PROPERTY THAT MATTERS: an installer that dies partway leaves its earlier stages on disk', async () => {
  // Three stages, then Quit before the fourth. Quit is how every refusal path
  // in the installer ends, including the declined-elevation one.
  const dir = freshDir('aborted')
  const exe = await compile('aborted', [
    '  !insertmacro OrgLog "init" "setup=probe"',
    '  !insertmacro OrgLog "elevation-requested" "a prompt is now in front of the user"',
    '  !insertmacro OrgLog "elevation-declined" "the prompt was DISMISSED by the user (1223)"',
    '  SetErrorLevel 2',
    '  Quit',
    '  !insertmacro OrgLog "install-complete" "this line must never be written"',
  ].join('\n'), dir)
  const code = await run(exe, dir)
  assert.equal(code, 2, 'the probe really did exit through a refusal path')

  const text = readLog(logIn(dir))
  assert.notEqual(text, '', 'THE LOG EXISTS AFTER AN ABORT. This is the whole point: the '
    + 'previous diagnostic did not, which is why the field incident could not be explained')
  assert.deepEqual(stages(text), ['init', 'elevation-requested', 'elevation-declined'],
    'every stage that COMPLETED is present, in order, and the one after the abort is not — '
    + 'so "last completed stage" is readable off the end of the file')
  assert.doesNotMatch(text, /install-complete/, 'nothing after the Quit was written')
  // The exact refusal is durable, which is the field r6 said nothing survived to carry.
  assert.match(text, /DISMISSED by the user \(1223\)/)
  // Each line is timestamped, or ordering across two runs is guesswork.
  assert.match(text, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \[init\] /m)
})

test('§2 CONTROL: the harness detects the log NOT being written', async () => {
  // Without this, §1's "the log exists" is unfalsifiable — a harness that
  // reported a log for every run would pass §1 no matter what the code did.
  const dir = freshDir('silent')
  const exe = await compile('silent', '  DetailPrint "this probe never logs anything"', dir)
  await run(exe, dir)
  assert.equal(fs.existsSync(logIn(dir)), false,
    'CONTROL: a probe built from the same fixture that makes no log calls leaves '
    + 'NO file, so §1 is measuring the logging rather than the harness')
  assert.equal(readLog(logIn(dir)), '')
})

test('§3 CONTROL: the missing stage in §1 is the abort, not a broken write', async () => {
  // §1 asserts install-complete is ABSENT. That absence has two possible
  // causes, and they mean opposite things: the abort worked, or the writer
  // cannot write that line at all. Same stage, no abort, must appear.
  const dir = freshDir('complete')
  const exe = await compile('complete', [
    '  !insertmacro OrgLog "init" "setup=probe"',
    '  !insertmacro OrgLog "install-complete" "files and registry written"',
  ].join('\n'), dir)
  await run(exe, dir)
  const text = readLog(logIn(dir))
  assert.deepEqual(stages(text), ['init', 'install-complete'],
    'CONTROL: without the Quit the later stage IS written, so §1 measured the '
    + 'abort rather than an inability to write')
})

test('§4 the log is BOUNDED, and rotates at the start of a run rather than mid-run', async () => {
  const dir = freshDir('bounded')
  const bound = sizeBound()
  // A log left oversized by earlier runs.
  fs.writeFileSync(logIn(dir), 'x'.repeat(bound + 4096))
  const exe = await compile('bounded', [
    '  !insertmacro OrgLog "init" "setup=probe"',
    '  !insertmacro OrgLog "install-complete" "files and registry written"',
  ].join('\n'), dir)
  await run(exe, dir)

  const text = readLog(logIn(dir))
  assert.ok(text.length < bound, `the oversized log was rotated: now ${text.length} bytes`)
  assert.deepEqual(stages(text), ['init', 'install-complete'],
    'and BOTH of this run\'s lines are present — rotation happens once, at the '
    + 'first write, so a single installer\'s own stages are never split across it')
  assert.doesNotMatch(text, /xxxx/, 'the old content is gone')

  // CONTROL: a log UNDER the bound is appended to, not rotated. Otherwise
  // "rotated" would just be what this code always does.
  const keep = freshDir('kept')
  fs.writeFileSync(logIn(keep), '2026-01-01 00:00:00 [previous-run] kept\r\n')
  await run(await compile('kept', '  !insertmacro OrgLog "init" "setup=probe"', keep), keep)
  assert.match(readLog(logIn(keep)), /\[previous-run\]/,
    'CONTROL: an earlier run under the bound survives, so the rotation in this '
    + 'section was caused by the size and not by every run truncating')
})

test('§6 A SILENT INSTALL NEVER RUNS A PAGE HOOK — which is where this installer elevates', async () => {
  // ⚠ WHY THIS SECTION IS HERE AT ALL. Reading the templates to work out what
  // the new log would have recorded on the machine that failed turned up
  // something worse than a missing log: `customInstallMode` — the ONLY place
  // this installer ever calls UAC_RunElevated — is inserted into the
  // install-mode PAGE's PRE function (app-builder-lib
  // templates/nsis/multiUserUi.nsh:42, inside FUNCTION_INSTALL_MODE_PAGE_FUNCTION).
  // A silent install runs no pages.
  //
  // If that is true, a silent `--updated` run of an all-users installation from
  // an unelevated application cannot elevate AT ALL: no prompt is ever shown,
  // and the run stops when it needs rights it never asked for. That is
  // consistent with every fact in the incident report — the installer launched,
  // ran for about thirty seconds, exited, replaced nothing, and the user saw no
  // prompt — and it is the question r6 recommendation 7 asks about
  // `isAdminRightsRequired: false`.
  //
  // So the load-bearing link gets measured rather than read: does a page
  // callback run under `SilentInstall silent`?
  const dir = freshDir('silent-pages')
  const pageProbe = [
    '  !insertmacro OrgLog "section" "the install section ran"',
  ].join('\n')
  // A real custom page with a PRE callback, alongside a section. The PRE logs.
  const withPage = (silent) => [
    'Unicode true',
    'Name "orgtree-page-hook-probe"',
    `OutFile "${path.join(dir, silent ? 'silent.exe' : 'visible.exe')}"`,
    'RequestExecutionLevel user',
    silent ? 'SilentInstall silent' : '',
    '!include LogicLib.nsh',
    '!include FileFunc.nsh',
    `!define ORGTREE_LOG_MAX_BYTES ${sizeBound()}`,
    'Var OrgLogPath',
    'Var OrgLogStage',
    'Var OrgLogDetail',
    logFunction(),
    logMacro(),
    // ⚠ BOTH PAGES ARE NEEDED, and the second one is not decoration: NSIS runs
    // sections when the INSTFILES page runs, so a visible probe without it
    // would execute the page hook and then exit having run no section at all —
    // which is exactly how the control failed the first time, and it looked
    // like the section being skipped in visible mode. Silent installs run
    // sections regardless, which is the asymmetry under test.
    'AutoCloseWindow true',
    'Page custom orgtreePagePre',
    'Page instfiles',
    'Function orgtreePagePre',
    '  !insertmacro OrgLog "page-hook" "a page PRE callback ran"',
    // Nothing is drawn, so NSIS moves straight on in the visible case.
    'FunctionEnd',
    'Section "probe"',
    pageProbe,
    'SectionEnd',
    '',
  ].filter(line => line !== '').join('\n')

  const build = (silent) => new Promise((resolve, reject) => {
    const script = path.join(dir, silent ? 'silent.nsi' : 'visible.nsi')
    fs.writeFileSync(script, '﻿' + withPage(silent), 'utf8')
    execFile(makensis, [script], { windowsHide: true, timeout: 120000, maxBuffer: 8 << 20 },
      (error, stdout, stderr) => error
        ? reject(new Error(`makensis failed: ${String(stderr || stdout).slice(-2000)}`))
        : resolve(path.join(dir, silent ? 'silent.exe' : 'visible.exe')))
  })

  // CONTROL FIRST: with pages shown, the PRE callback DOES run. Without this,
  // "the hook did not run" could just mean the probe never logged anything.
  const visible = await build(false)
  await run(visible, dir)
  let text = readLog(logIn(dir))
  assert.ok(stages(text).includes('page-hook'),
    'CONTROL: a visible install runs the page PRE callback, so this probe can '
    + 'observe one running')
  assert.ok(stages(text).includes('section'), 'and the section runs too')

  // THE MEASUREMENT: same script, silent.
  fs.rmSync(logIn(dir), { force: true })
  const silent = await build(true)
  await run(silent, dir)
  text = readLog(logIn(dir))
  assert.ok(stages(text).includes('section'),
    'the silent install still runs its SECTION — so the probe ran at all')
  assert.equal(stages(text).includes('page-hook'), false,
    'AND IT NEVER RAN THE PAGE HOOK. So the one site where this installer '
    + 'elevates cannot be reached by a silent --updated run: an all-users '
    + 'update launched unelevated has no way to ask for rights, and no prompt '
    + 'is ever shown to decline. This is a source-derived explanation for the '
    + 'reported incident, and it is NOT a reproduction of it')
})

test('§5 an unwritable primary location falls back instead of losing the run', async () => {
  // $EXEDIR is preferred because it is where Setup sits and belongs to the
  // invoking user whichever account approved elevation — but Setup can be
  // launched from somewhere unwritable. A directory standing where the file
  // should go makes FileOpen fail exactly as a read-only location would.
  const dir = freshDir('fallback')
  fs.mkdirSync(logIn(dir))
  const tempLog = path.join(os.tmpdir(), 'orgtree-installer.log')
  const before = readLog(tempLog)
  const exe = await compile('fallback', '  !insertmacro OrgLog "init" "setup=probe-fallback-marker"', dir)
  await run(exe, dir)

  const after = readLog(tempLog)
  assert.notEqual(after, before, 'something was written to the fallback location')
  assert.match(after, /probe-fallback-marker/,
    'the run was recorded in $TEMP rather than lost — and NOT in $PLUGINSDIR, '
    + 'which is deleted when an installer exits and is half the reason nothing '
    + 'survived last time')
})
