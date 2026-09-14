// nsis-destination.test.mjs — WHAT THE REAL NSIS PARSER ACTUALLY DOES WITH OUR
// QUOTED /D=, AND WHY THAT REFUTES THE LEADING EXPLANATION OF THE INCIDENT.
//
// THE CLAIM UNDER TEST. On the machine that failed its 2.1.3 → 2.1.4 update, the
// app launched the silent installer twice with
//
//     --updated /S --force-run /D=C:\Program Files\Orgtree\Orgtree
//
// and came back as 2.1.3 both times, having replaced nothing. The incident
// report names the destination contract as the strongest source-correlated
// cause: NSIS wants /D= last and UNQUOTED, Node quotes any argument containing
// whitespace, and app-builder-lib's GetDParameter copies everything after /D=
// into $INSTDIR — trailing quote included. Our own source said so in a comment,
// our own log said "NOTE: this /D= argument will reach NSIS quoted", and the
// argument was passed anyway.
//
// ⚠ IT IS HALF TRUE, AND THE HALF THAT MATTERS IS FALSE. Measured here: the
// macro's output really does carry the trailing quote (§1, and that is the
// control that proves this fixture can see the defect at all) — but assigning
// it to $INSTDIR REMOVES the quote (§2), so the destination the installer
// actually uses is correct, and identical to what the unquoted form produces.
// A directory created from it is the intended one, not one ending in a quote.
// The two forms are indistinguishable by the time anything is installed.
//
// So the quoted /D= is not what broke that machine, and a fix aimed at it would
// have been a change made against a refuted hypothesis. What broke it remains
// unexplained; the report's own surviving alternatives — a declined elevation
// prompt, or another internal installer exit — are now the whole field, which
// is why durable installer-side diagnostics matter more than this contract did.
//
// ⚠⚠ WHAT THIS DOES *NOT* SAY, and the distinction is most of the value of the
// result. It does not say the /D= handoff is safe, or robust, or well designed.
// It says that FOR THIS PATH SHAPE, on THESE pinned versions, the quoted and
// unquoted forms converge on the same $INSTDIR — and the reason they converge
// is INCIDENTAL rather than designed: the only character the quoting adds is a
// double quote, which Windows forbids in a filename, so NSIS's own $INSTDIR
// sanitisation removes it. §4 shows that sanitisation stripping all six
// forbidden characters at once, which is what makes the mechanism nameable.
//
// A corruption made of LEGAL characters would pass straight through that
// sanitisation and land in $INSTDIR intact. Windows command-line quoting has
// known edges of that kind — a trailing backslash before the closing quote is
// the obvious one, where it is consumed as an escaped quote rather than as a
// terminator. NOTHING HERE ESTABLISHES that such a shape is reachable from the
// app's own installDirectory(), and this file does not go looking for one.
// It is written down so that "the destination contract was measured" can never
// be read as "the destination contract is sound".
//
// ⚠ NOTHING HERE IS A MODEL. The parser is the shipped `GetDParameter`,
// extracted at test time from app-builder-lib's own template so upstream
// changes reach this test. The compiler is the real makensis from
// electron-builder's cache. The quoting is done by Node's own `spawn`, the
// exact mechanism that produced the argument in the incident log. And the
// versions are the ones that built the failing installer: package-lock.json was
// last touched by 7b9223f, "prepare 2.1.4 stable release boundary", which is
// the same commit the public v2.1.4 tag points at.
//
// Nothing is installed. The probe is a small NSIS program written by this test
// that parses its own command line, writes what it parsed, creates one
// directory under its own temp folder, and exits. It has no install section and
// it is not our installer.
//
// Run: THIS PROBE IS OPT-IN AND WILL DISTURB THE DESKTOP.
//   set ORGTREE_DISRUPTIVE_PROBES=1  and then  npm run test:disruptive
//   (or: node --test tests/disruptive/nsis-destination.test.mjs, same variable set)
//   Without that variable every test here SKIPS and measures nothing.

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile, spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { requireDisruptiveOptIn } from './gate.mjs'

// DISRUPTIVE PROBE — SECOND BARRIER. This file opens consoles or windows,
// or drives the real installer toolchain, so it must never run because
// somebody typed `npm test`. Barrier one is the folder: the default glob
// `tests/*.test.mjs` does not recurse, so it cannot reach this file.
// Barrier two is this gate: without an explicit opt-in every test below is
// SKIPPED, which node:test reports as skipped rather than as a pass — a
// probe that was never asked for must never read as one that ran and was
// fine. Run these deliberately with `npm run test:disruptive` after setting
// ORGTREE_DISRUPTIVE_PROBES=1, on a machine you are willing to have
// interrupted.
const DISRUPTIVE_OK = requireDisruptiveOptIn('nsis destination')
const gatedTest = DISRUPTIVE_OK ? test : test.skip

const require_ = createRequire(import.meta.url)

/** Resolved through node_modules rather than joined onto the repo root: this
 *  worktree deliberately has none of its own and resolves upward to a shared
 *  tree, so a path join finds nothing. */
const resolveQuietly = (specifier) => { try { return require_.resolve(specifier) } catch { return '' } }
const multiUserTemplate = resolveQuietly('app-builder-lib/templates/nsis/multiUser.nsh')
const stdUtilsInclude = resolveQuietly('app-builder-lib/templates/nsis/include/StdUtils.nsh')

/** electron-builder caches the toolchain it builds installers with. Using that
 *  one rather than any makensis on PATH is the point: it is the compiler the
 *  published installer was built by. */
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
const stdUtilsPluginDir = (() => {
  const dll = underVersionDir(path.join(cache, 'nsis-resources-3.4.1'), 'plugins', 'x86-unicode', 'StdUtils.dll')
  return dll ? path.dirname(dll) : ''
})()

/** The REAL macro, lifted out of the real template rather than copied into this
 *  file. Copying it would make the test agree with a snapshot of upstream
 *  instead of with upstream. */
const shippedGetDParameter = () => {
  const source = fs.readFileSync(multiUserTemplate, 'utf8')
  const begin = source.indexOf('!macro GetDParameter')
  assert.ok(begin >= 0, 'GetDParameter must still exist in app-builder-lib templates/nsis/multiUser.nsh')
  const end = source.indexOf('!macroend', begin)
  assert.ok(end > begin, 'the macro must be terminated')
  return source.slice(begin, end + '!macroend'.length)
}

const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'orgtree-nsis-'))
const probeExe = path.join(workdir, 'd-parameter-probe.exe')
/** Where a /D= in these tests points. Under the test's own temp directory, so
 *  the one CreateDirectory the probe performs cannot touch anything real — and
 *  it deliberately CONTAINS A SPACE, because that is the whole subject. */
const spacedTarget = path.join(workdir, 'Program Files', 'Orgtree')
/** What the installer resolves for itself when no /D= is present. In the real
 *  template this is InstallLocation read from `Software\<APP_GUID>`; the probe
 *  pre-sets it so "nothing overrode it" is observable. */
const RESOLVED_WITHOUT_ARGUMENT = 'C:\\Resolved\\By\\Nsis\\Itself'

/** ⚠ NSIS ESCAPES, BUILT WITHOUT WRITING BACKSLASH-R IN SOURCE. `$\r$\n` is
 *  what NSIS wants inside a quoted string; assembling it from char codes keeps
 *  every layer between here and the file from reinterpreting it, which cost
 *  real time when a shell turned it into actual newlines and makensis reported
 *  "unterminated string". */
const BS = String.fromCharCode(92)
const NL = `$${BS}r$${BS}n`

const probeSource = () => [
  'Unicode true',
  'Name "orgtree-d-parameter-probe"',
  `OutFile "${probeExe}"`,
  'RequestExecutionLevel user',
  'SilentInstall silent',
  `!addplugindir /x86-unicode "${stdUtilsPluginDir}"`,
  '!include LogicLib.nsh',
  `!include "${stdUtilsInclude}"`,
  '',
  shippedGetDParameter(),
  '',
  'Section "probe"',
  `  StrCpy $INSTDIR "${RESOLVED_WITHOUT_ARGUMENT}"`,
  '  !insertmacro GetDParameter $R0',
  '  ${If} $R0 != ""',
  '    StrCpy $INSTDIR $R0',
  '  ${EndIf}',
  '  ${StdUtils.GetAllParameters} $R8 "0"',
  // lengths, because the difference between the two values is ONE character
  // and an eyeballed string will not show it
  '  StrLen $R1 $R0',
  '  StrLen $R2 $INSTDIR',
  // ⚠ THE OUTPUT PATH COMES FROM THE ENVIRONMENT AT RUNTIME. `$%VAR%` is
  // resolved at COMPILE time and warns "unknown variable/constant, ignoring",
  // which silently produced an empty filename and a probe that ran and wrote
  // nothing — indistinguishable from a probe that never started.
  '  ReadEnvStr $8 "ORGTREE_PROBE_OUT"',
  '  StrCmp $8 "" 0 +3',
  '    SetErrorLevel 91',
  '    Quit',
  '  ClearErrors',
  '  FileOpen $9 $8 w',
  '  IfErrors 0 +3',
  '    SetErrorLevel 92',
  '    Quit',
  `  FileWrite $9 "raw=[$R8]${NL}"`,
  `  FileWrite $9 "dparam=[$R0] len=$R1${NL}"`,
  `  FileWrite $9 "instdir=[$INSTDIR] len=$R2${NL}"`,
  // Does the parsed value WORK as a directory? This is the question that
  // matters: a stray quote in a variable is harmless if nothing ever uses it.
  '  ClearErrors',
  '  CreateDirectory "$INSTDIR"',
  '  IfErrors 0 +3',
  `    FileWrite $9 "createdir=failed${NL}"`,
  '  Goto +2',
  `    FileWrite $9 "createdir=ok${NL}"`,
  '  FileClose $9',
  'SectionEnd',
  '',
].join('\n')

const compileProbe = () => new Promise((resolve, reject) => {
  const script = path.join(workdir, 'probe.nsi')
  // ⚠ UTF-8 WITH BOM. The shipped macro contains a non-ASCII character in one
  // of its comments; without the BOM makensis reads the file as the ANSI
  // codepage and the mojibake breaks string parsing.
  fs.writeFileSync(script, '\ufeff' + probeSource(), 'utf8')
  execFile(makensis, [script], { windowsHide: true, timeout: 120000, maxBuffer: 8 << 20 }, (error, stdout, stderr) => {
    if (error) return reject(new Error(`makensis failed: ${String(stderr || stdout).slice(-2000)}`))
    resolve(String(stdout))
  })
})

let compiled
const probe = async (args, { verbatim = false, label = 'run' } = {}) => {
  compiled ??= compileProbe()
  await compiled
  const out = path.join(workdir, `parsed-${label}.txt`)
  try { fs.rmSync(out, { force: true }) } catch { /* fresh */ }
  const code = await new Promise((resolve, reject) => {
    // ⚠ THE ONLY DIFFERENCE BETWEEN THE TWO FORMS IS THIS FLAG. Same argument
    // array either way: without it Node quotes anything containing whitespace,
    // which is the mechanism under test; with it the arguments are joined onto
    // the command line untouched.
    const child = spawn(probeExe, args, {
      windowsHide: true, stdio: 'ignore', windowsVerbatimArguments: verbatim,
      env: { ...process.env, ORGTREE_PROBE_OUT: out },
    })
    child.on('error', reject)
    child.on('exit', resolve)
  })
  // ⚠ THE PROBE MUST HAVE WRITTEN. Error level 91/92 mean it could not find its
  // output path or could not open it. Without this, a probe that wrote nothing
  // would report "no /D= was parsed", which reads exactly like the fix working.
  assert.equal(code, 0, `the probe must complete: exit code ${code} (91 = no output path, 92 = could not open it)`)
  assert.ok(fs.existsSync(out), 'the probe must have written its output: it never ran')
  const text = fs.readFileSync(out, 'utf8')
  const field = (name) => (new RegExp(`^${name}=\\[(.*)\\](?: len=(\\d+))?$`, 'm').exec(text) ?? [])
  const [, raw] = field('raw')
  const [, dparam, dparamLen] = field('dparam')
  const [, instdir, instdirLen] = field('instdir')
  return {
    raw, dparam, instdir, text,
    dparamLen: Number(dparamLen), instdirLen: Number(instdirLen),
    createdDirectory: /^createdir=ok$/m.test(text),
  }
}

test.after(() => { try { fs.rmSync(workdir, { recursive: true, force: true }) } catch { /* temp */ } })

gatedTest('the real toolchain, the real macro, and the versions that built the failing installer', () => {
  // Asserted rather than skipped: if any of this stops being available the
  // sections below stop being evidence, and that must be visible rather than
  // inferred from a green run with skips in it.
  assert.ok(makensis, `makensis must be available (looked under ${cache})`)
  assert.ok(stdUtilsPluginDir, 'the StdUtils plugin must be available')
  assert.ok(multiUserTemplate, 'app-builder-lib multiUser.nsh must be resolvable')
  assert.match(shippedGetDParameter(), /StdUtils\.GetAllParameters/,
    'the shipped macro must still read the RAW command line — the entire hazard '
    + 'is that it parses a command line rather than an argument vector')
  // The pinned versions are the ones the published 2.1.4 installer was built
  // with; package-lock.json was last changed by 7b9223f, which is the commit
  // the public v2.1.4 tag points at.
  assert.equal(require_('app-builder-lib/package.json').version, '26.15.3')
  assert.equal(require_('electron-updater/package.json').version, '6.8.9')
})

gatedTest('§1 CONTROL: Node really does quote it, and the macro really does keep the quote', async () => {
  // This is the firing control for everything below. It establishes that the
  // fixture reproduces the exact condition the incident log recorded — if this
  // stops passing, §2 is not a refutation of anything, it is a broken probe.
  const parsed = await probe(['--updated', '/S', '--force-run', `/D=${spacedTarget}`], { label: 'quoted' })

  assert.match(parsed.raw, /"\/D=.*Program Files.*"/,
    'the raw Win32 command line carries the argument WRAPPED IN QUOTES, exactly '
    + 'as the incident log shows — Node did this, not us')
  assert.equal(parsed.dparam, `${spacedTarget}"`,
    'and GetDParameter copies everything after /D= into its output variable, '
    + 'trailing quote included: the documented defect is real at this level')
  assert.equal(parsed.dparamLen, spacedTarget.length + 1,
    'one character longer than the path, which is the quote and nothing else')
})

gatedTest('§2 THE REFUTATION: $INSTDIR strips that quote, so the destination is correct anyway', async () => {
  const quoted = await probe(['--updated', '/S', '--force-run', `/D=${spacedTarget}`], { label: 'quoted' })

  assert.equal(quoted.instdir, spacedTarget,
    'assigning the macro output to $INSTDIR yields the INTENDED directory: NSIS '
    + 'removes the trailing quote as part of that assignment. This is the step '
    + 'the incident report could not observe, and it is where the theory fails')
  assert.equal(quoted.instdirLen, quoted.dparamLen - 1,
    'exactly one character shorter than what the macro parsed — the quote is gone')
  assert.equal(quoted.createdDirectory, true,
    'and the value WORKS as a path: the probe created that directory')
  assert.equal(fs.existsSync(spacedTarget), true, 'the intended directory exists')
  assert.equal(fs.existsSync(`${spacedTarget}"`), false,
    'and no directory ending in a quote was created, which is what a '
    + 'mis-parsed destination would have produced')

  // THE SAME DESTINATION AS THE UNQUOTED FORM. r6's other suggested repair was
  // a raw command line keeping /D= unquoted; it is indistinguishable here.
  const verbatim = await probe(['--updated', '/S', '--force-run', `/D=${spacedTarget}`],
    { verbatim: true, label: 'verbatim' })
  assert.equal(verbatim.dparam, spacedTarget, 'unquoted, the macro parses it with no quote to strip')
  assert.equal(verbatim.instdir, quoted.instdir,
    'AND BOTH FORMS ARRIVE AT THE SAME $INSTDIR. By the time anything is '
    + 'installed the quoting has made no difference, so it cannot be what left '
    + 'the reported machine on its old version')

  // ⚠ AND THE CONVERGENCE IS INCIDENTAL, asserted so the narrowness of the
  // claim is part of the test rather than only part of its header. The two
  // forms differ by exactly one character, that character is a double quote,
  // and it survives in an ordinary variable (§4) — it is removed here only
  // because $INSTDIR forbids it. Nothing about this generalises to a corruption
  // made of characters Windows permits.
  assert.equal(quoted.dparamLen - verbatim.dparamLen, 1,
    'the quoted form differs from the unquoted one by exactly one character')
  assert.equal(quoted.dparam.slice(-1), String.fromCharCode(34),
    'and that character is a double quote — the one class of corruption '
    + '$INSTDIR sanitisation happens to catch')
})

gatedTest('§3 with no /D= at all, the destination the installer resolved for itself stands', async () => {
  // Recorded because it is the premise of the "just omit the argument" repair.
  // It holds — but §2 means there is nothing here to repair, so the app is not
  // taking that route.
  const parsed = await probe(['--updated', '/S', '--force-run'], { label: 'no-d' })
  assert.doesNotMatch(parsed.raw, /\/D=/, 'precondition: no /D= was sent')
  assert.equal(parsed.dparam, '', 'so the macro found nothing to override with')
  assert.equal(parsed.instdir, RESOLVED_WITHOUT_ARGUMENT,
    'and what the installer worked out for itself survives untouched — in the '
    + 'real template that is InstallLocation from the registry, assigned before '
    + '/D= is ever consulted')
})

// ---------------------------------------------------------------------------
// THE INSTRUMENT, AND WHY $INSTDIR LOSES THE QUOTE
//
// §2 rests on two numbers that look mutually inconsistent: the macro parses 76
// characters ending in a quote, and $INSTDIR holds 75 without one, with only
// `StrCpy $INSTDIR $R0` in between — a copy with no documented stripping
// behaviour. fix-coordinator objected on exactly that, and the objection is
// right as stated: either something neither of us had identified is happening,
// or THE READBACK CANNOT SHOW A QUOTE and §2 is an artifact of this file.
//
// This second probe settles both halves, and it never uses /D= at all: it
// poisons the values directly, so what is under test is NSIS's assignment
// behaviour and this file's own ability to display the character.
// ---------------------------------------------------------------------------

const DQ = String.fromCharCode(34)
/** A double quote, escaped for inside an NSIS quoted string. */
const NSIS_QUOTE = `$${BS}${DQ}`
const POISON = `C:${BS}poison${DQ}`
const POISON_CLEAN = `C:${BS}poison`
const ILLEGAL_IN = `C:${BS}weird${DQ}a*b?c<d>e|f`
const ILLEGAL_CLEAN = `C:${BS}weirdabcdef`

const poisonExe = path.join(workdir, 'instdir-poison-probe.exe')
const poisonSource = () => [
  'Unicode true',
  'Name "orgtree-instdir-poison-probe"',
  `OutFile "${poisonExe}"`,
  'RequestExecutionLevel user',
  'SilentInstall silent',
  '!include LogicLib.nsh',
  '',
  'Section "poison"',
  // the SAME string into an ordinary variable and into the special one
  `  StrCpy $R3 "C:${BS}poison${NSIS_QUOTE}"`,
  `  StrCpy $INSTDIR "C:${BS}poison${NSIS_QUOTE}"`,
  '  StrLen $R4 $R3',
  '  StrLen $R5 $INSTDIR',
  '  StrCpy $R6 $R3 1 -1',          // last character of the ordinary variable
  '  StrCpy $R7 $INSTDIR 1 -1',     // last character of $INSTDIR
  '  StrCpy $R0 $INSTDIR',          // captured before the next assignment clobbers it
  // every character Windows forbids in a filename, at once
  `  StrCpy $R1 "C:${BS}weird${NSIS_QUOTE}a*b?c<d>e|f"`,
  '  StrCpy $INSTDIR $R1',
  '  StrLen $R2 $INSTDIR',
  '  ReadEnvStr $8 "ORGTREE_PROBE_OUT"',
  '  StrCmp $8 "" 0 +3',
  '    SetErrorLevel 91',
  '    Quit',
  '  ClearErrors',
  '  FileOpen $9 $8 w',
  '  IfErrors 0 +3',
  '    SetErrorLevel 92',
  '    Quit',
  `  FileWrite $9 "normal=[$R3] len=$R4 last=[$R6]${NL}"`,
  `  FileWrite $9 "instdir=[$R0] len=$R5 last=[$R7]${NL}"`,
  `  FileWrite $9 "illegal_in=[$R1]${NL}"`,
  `  FileWrite $9 "illegal_instdir=[$INSTDIR] len=$R2${NL}"`,
  '  FileClose $9',
  'SectionEnd',
  '',
].join('\n')

gatedTest('§4 INSTRUMENT CONTROL: this readback CAN show a trailing quote — and $INSTDIR still loses it', async () => {
  const script = path.join(workdir, 'poison.nsi')
  fs.writeFileSync(script, '﻿' + poisonSource(), 'utf8')
  await new Promise((resolve, reject) => {
    execFile(makensis, [script], { windowsHide: true, timeout: 120000, maxBuffer: 8 << 20 },
      (error, stdout, stderr) => error
        ? reject(new Error(`makensis failed: ${String(stderr || stdout).slice(-2000)}`))
        : resolve())
  })
  const out = path.join(workdir, 'poison.txt')
  try { fs.rmSync(out, { force: true }) } catch { /* fresh */ }
  const code = await new Promise((resolve, reject) => {
    const child = spawn(poisonExe, [], { windowsHide: true, stdio: 'ignore', env: { ...process.env, ORGTREE_PROBE_OUT: out } })
    child.on('error', reject)
    child.on('exit', resolve)
  })
  assert.equal(code, 0, 'the poison probe must complete (91 = no output path, 92 = could not open it)')

  // ⚠ READ AS BYTES. A text readback that quietly dropped the character is the
  // artifact being ruled out, so the claim is checked against raw bytes too:
  // 0x22 is a double quote.
  const bytes = fs.readFileSync(out)
  const text = bytes.toString('utf8')
  const row = (name) => (new RegExp(`^${name}=\\[(.*?)\\](?: len=(\\d+))?(?: last=\\[(.*)\\])?$`, 'm').exec(text) ?? [])
  const rawRow = (name) => bytes.toString('latin1').split(/\r?\n/).find(line => line.startsWith(`${name}=`)) ?? ''

  // (1) THE CONTROL. An ORDINARY variable given the poisoned string reads back
  // WITH the quote. If this fails, nothing in §2 can be believed, because the
  // instrument cannot display a character we put there ourselves.
  const [, normal, normalLen, normalLast] = row('normal')
  assert.equal(normal, POISON, 'CONTROL: an ordinary variable keeps the trailing quote')
  assert.equal(Number(normalLen), POISON.length, 'and NSIS itself agrees on the longer length')
  assert.equal(normalLast, DQ, 'and its last character IS the quote')
  assert.ok(rawRow('normal').includes(DQ),
    'CONTROL AT THE BYTE LEVEL: 0x22 really is present in the file on that row, '
    + 'so this channel can carry it')

  // (2) THE SAME STRING INTO $INSTDIR LOSES IT. Same probe, same write, same
  // readback; one assignment different.
  const [, instdir, instdirLen, instdirLast] = row('instdir')
  assert.equal(instdir, POISON_CLEAN, '$INSTDIR does NOT keep the trailing quote')
  assert.equal(Number(instdirLen), POISON_CLEAN.length,
    'and NSIS computes the shorter length ITSELF — the difference in §2 is not '
    + 'something this test derived by parsing')
  assert.equal(instdirLast, 'n', 'its last character is the last letter of the path')
  const instdirValue = rawRow('instdir').slice('instdir=['.length, rawRow('instdir').indexOf(']'))
  assert.ok(!instdirValue.includes(DQ), 'and no 0x22 anywhere in the $INSTDIR value')

  // (3) THE MECHANISM, NAMED, so nobody re-litigates this in six months. It is
  // not about quotes at all: assigning to $INSTDIR VALIDATES IT AS A FILENAME.
  assert.equal(row('illegal_in')[1], ILLEGAL_IN, 'the source string held all six forbidden characters')
  assert.equal(row('illegal_instdir')[1], ILLEGAL_CLEAN,
    'and $INSTDIR stripped every one of " * ? < > | . So `StrCpy $INSTDIR` is '
    + 'NOT a verbatim copy: NSIS sanitises the value on assignment to that '
    + 'variable. That is why the quoted /D= arrives clean, why the two lengths '
    + 'in §2 differ by exactly one, and why CreateDirectory succeeded on the '
    + 'intended path rather than failing on an invalid character')
})
