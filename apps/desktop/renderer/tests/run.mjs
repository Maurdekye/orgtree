// frontend/tests/run.mjs — the frontend suite's runner.
//
//   node tests/run.mjs                 (from frontend/)  — everything
//   node tests/run.mjs convo           — only files whose name contains "convo"
//   node tests/run.mjs --reps 5        — passed through to the suites via
//                                        ORGTREE_TEST_REPS
//
// WHY A BUNDLE STEP. The sources are TypeScript with extensionless imports and
// JSX, and node's own type stripping does neither. esbuild is already in the
// tree (vite's), so each `*.test.ts(x)` is bundled — app code and all — into
// one ESM file under a temp dir and handed to node's built-in test runner. No
// new runner, no config file, no transform layer to get out of sync with vite:
// the same bundler that builds the app builds the tests.
//
// The DOM comes from jsdom (a devDependency), installed by `harness.ts` before
// any app module is reached — see the import-order note there.

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as esbuild from 'esbuild'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const argv = process.argv.slice(2)
const filters = []
let repsValue
let outputArg
let prebuiltArg
let afterOptions = false
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i]
  if (afterOptions) { filters.push(arg); continue }
  if (arg === '--') { afterOptions = true; continue }
  const [name, inline] = arg.split('=', 2)
  if (name === '--reps') {
    repsValue = inline ?? argv[++i]
    if (repsValue === undefined) throw new Error('--reps needs a value')
  } else if (name === '--output' || name === '--out') {
    outputArg = inline ?? argv[++i]
    if (!outputArg) throw new Error(`${name} needs a directory`)
  } else if (name === '--prebuilt') {
    prebuiltArg = inline ?? argv[++i]
    if (!prebuiltArg) throw new Error('--prebuilt needs a directory')
  } else if (name === '--filter') {
    const value = inline ?? argv[++i]
    if (!value) throw new Error('--filter needs a value')
    filters.push(value)
  } else if (arg === '--help' || arg === '-h') {
    console.log('Usage: node run.mjs [filter ...] [--reps N] [--output DIR] [--prebuilt DIR]')
    console.log('Filters are filename substrings combined with OR. --prebuilt skips bundling and never removes DIR.')
    process.exit(0)
  } else if (arg.startsWith('-')) {
    throw new Error(`unknown option ${arg}`)
  } else {
    filters.push(arg)
  }
}
if (outputArg && prebuiltArg) throw new Error('--output and --prebuilt cannot be combined')

const entries = readdirSync(HERE)
  .filter((f) => /\.test\.tsx?$/.test(f))
  .filter((f) => !filters.length || filters.some((filter) => f.includes(filter)))
  .sort()
  .map((f) => path.join(HERE, f))

if (!prebuiltArg && !entries.length) throw new Error(`no test files match ${filters.join(', ') || '*'}`)

// ⚠ the bundle lands INSIDE node_modules on purpose: it imports jsdom (kept
// external), and node resolves a bare specifier by walking up from the
// importing file — from a temp dir that walk never reaches frontend's
// node_modules. It is also already ignored by every VCS rule in the tree.
const prebuilt = prebuiltArg ? path.resolve(prebuiltArg) : null
const requestedOutput = outputArg ? path.resolve(outputArg) : null
let out
let ownsOutput = false
let outputRoot = null
let argRoot = null
if (prebuilt) {
  if (!existsSync(prebuilt)) throw new Error(`prebuilt directory does not exist: ${prebuilt}`)
  out = prebuilt
} else if (requestedOutput) {
  mkdirSync(requestedOutput, { recursive: true })
  if (readdirSync(requestedOutput).length) throw new Error(`refusing non-empty output directory: ${requestedOutput}`)
  out = requestedOutput
  const dependencyRoot = path.dirname(path.dirname(createRequire(import.meta.url).resolve('esbuild/package.json')))
  symlinkSync(dependencyRoot, path.join(out, 'node_modules'), 'junction')
  ownsOutput = true
} else {
  outputRoot = mkdtempSync(path.join(os.tmpdir(), 'orgtree-renderer-tests-'))
  out = path.join(outputRoot, 'bundles')
  mkdirSync(out)
  // ESM ignores NODE_PATH. A junction beside the bundles keeps external
  // jsdom/react resolution valid without putting output in a shared checkout.
  const dependencyRoot = path.dirname(path.dirname(createRequire(import.meta.url).resolve('esbuild/package.json')))
  symlinkSync(dependencyRoot, path.join(outputRoot, 'node_modules'), 'junction')
  ownsOutput = true
}
const cleanup = () => {
  if (argRoot) rmSync(argRoot, { recursive: true, force: true })
  if (ownsOutput && !process.env.KEEP_ORGTREE_TEST_OUTPUT) rmSync(outputRoot ?? out, { recursive: true, force: true })
}
process.once('exit', cleanup)

if (!prebuilt) await esbuild.build({
  entryPoints: entries,
  outdir: out,
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  jsx: 'automatic',
  sourcemap: 'inline',
  outExtension: { '.js': '.mjs' },
  logLevel: 'warning',
  // jsdom is a real node package with native-ish internals — never bundle it
  // The temp run has a private junction to dependencies beside its bundles.
  // Keep jsdom external because its native-ish internals do not bundle safely.
  external: ['jsdom', 'node:*'],
  define: {
    'process.env.NODE_ENV': '"development"',
    // the bundle runs from node_modules/.orgtree-tests, so a suite that reads
    // the sources cannot find them from import.meta.url — hand it the path
    __SRC_DIR__: JSON.stringify(path.join(HERE, '..', 'src')),
  },
})

// ⚠ PER-TEST TIMEOUT — THE RUNNER BOUNDS THE DAMAGE, BECAUSE THE TESTS CANNOT
// (D-177). node's default is NO timeout at all: a child spawned by `--test`
// carries `--test-timeout=0`, so a test that hangs hangs forever. On 2026-08-29
// that turned one hung suite into a machine-wide incident — a single
// `kbdhire.test.mjs` child reached 22 GB resident / 66 GB commit in ~40 s, took
// the machine to 0.44 GB free, and killed the user's editor. Six earlier
// low-memory events the same day were the same shape.
//
// The hang and the incident are two different failures, and this flag is aimed
// squarely at the second. A hung test is a bug someone fixes; an UNBOUNDED hung
// test is everyone's problem, including causes nobody has diagnosed yet. The
// known trigger is process-global `mock.timers` (`useFakeClock()`) under a
// concurrent runner — see the header of `sysnotice.test.tsx` — but this bound
// holds whatever the cause.
//
// It is PER TEST, not per run, so a slow suite is unaffected.
//
// WHERE 10s COMES FROM — measured, not guessed. Across the whole suite (246
// tests) the SLOWEST test is 593 ms; the whole run is ~32 s wall. 10 s is ~17x
// the slowest real test, which is ample headroom for a loaded machine, and it
// is deliberately NOT the 60 s this patch first carried: the kbdhire child
// reached 17.5 GB in THIRTEEN seconds, so a 60 s bound would have let the very
// incident this exists to stop happen almost in full.
//
// ⚠ AND BE HONEST ABOUT WHAT THIS BUYS: a timeout bounds TIME, not MEMORY. At
// the ~1.5 GB/s that incident allocated, even 10 s is several GB. This converts
// an unbounded machine-wide incident into a bounded, survivable one — it does
// not make it free. That is why the per-file structural fix and a suite's own
// `{ timeout }` still matter and should not be removed because this exists.
//
// Scaled by --reps because a stress run legitimately multiplies each test's
// work. A suite may still set its own `{ timeout }` per test, which wins over
// this default. ORGTREE_TEST_TIMEOUT_MS overrides everything; 0 restores node's
// old unbounded behaviour and should only ever be temporary.
const REPS_N = Math.max(1, Number(repsValue ?? process.env.ORGTREE_TEST_REPS) || 1)
const TIMEOUT_MS = process.env.ORGTREE_TEST_TIMEOUT_MS ?? String(10_000 * REPS_N)

// ⚠ CONCURRENCY IS BOUNDED, AND IT IS THE OTHER HALF OF D-177 (user, 2026-08-29:
// "make sure parallel tests arent fighting ovrr the virtual timer like what
// caused oom before; vscode crashed anhandful of times").
//
// `node --test` with N files defaults to `availableParallelism()` children —
// SIXTEEN on this machine — and each child bundles the whole app plus its own
// jsdom, and 21 of the 35 suites enable `mock.timers` (`useFakeClock`), which
// is process-global per child. The timeout above bounds how long ONE runaway
// child lives; it does nothing about how many live at once, and its own note
// says so ("a timeout bounds TIME, not MEMORY"). Peak memory is the product of
// the two, which is why the incident was machine-wide rather than one hung
// suite's problem.
//
// MEASURED on this machine (16 cores), whole suite, 282 tests passing either
// way — sampled total working set across the runner's own node children:
//   unbounded → peak 2,345 MB across 17 processes, 11.6 s wall
//   bounded 4 → peak   873 MB across  6 processes, 15.7 s wall  (two runs:
//               871/875 MB, 15.2/16.3 s)
// A 2.7x cut in peak memory for ~4 s of wall time. That is the trade this line
// makes, and on a machine also running a backend, a browser probe and several
// agents it is the difference between headroom and none. Re-measure before
// changing the number rather than reasoning about it: the first draft of this
// comment guessed 716 MB / 12.4 s and both figures were wrong.
//
// It does NOT replace either existing defence: the per-test timeout still
// bounds a runaway's lifetime, and a suite that does not need the clock should
// still not enable it (see sysnotice.test.tsx's header, and bearerrehire's).
// ORGTREE_TEST_CONCURRENCY overrides; set it to 0 for node's old unbounded
// behaviour, which should only ever be temporary.
const CONCURRENCY = process.env.ORGTREE_TEST_CONCURRENCY ?? '4'

// ⚠ CONTAINMENT — THE RUN AS A WHOLE IS BOUNDED IN MEMORY AND IN TIME, because
// the two bounds above are each only half of one. The per-test timeout bounds
// how long ONE test lives and says itself that it bounds time, not memory; the
// concurrency cap bounds how MANY children live at once, not what one of them
// may take. Neither stops a single child that allocates 1.5 GB/s for ten
// seconds, and the incident this exists for (D-177) was exactly that shape:
// the machine was at 0.44 GB free before any timeout fired. Both bounds also
// stop at the test: a runaway in setup, in a hook, or after `--test-force-exit`
// fails to force anything, is outside them.
//
// So on Windows the whole `node --test` tree runs inside a kernel Job Object
// (tests/joblimit.ps1) with a JOB-WIDE COMMIT CEILING: an allocation past it is
// REFUSED by the kernel — the child dies with the same "Array buffer allocation
// failed" the incident produced, in well under a second, instead of swapping
// the host — and a WHOLE-RUN time limit that terminates every process in the
// job, not just the parent (node's --test parent does not take its children
// with it when killed on Windows). The ceiling covers ArrayBuffer / external
// memory, which --max-old-space-size does not (measured, D-177).
//
// WHERE THE NUMBERS COME FROM. Ceiling 6 GB: the whole suite at concurrency 4
// peaks at 873 MB (measured above), so this is ~7x headroom — loose enough
// that no honest run touches it, tight enough that a runaway dies at ~4 s of
// the incident's rate rather than at 66 GB. Run limit 5 min: the whole suite is
// ~36 s wall, so ~8x. The RUN LIMIT scales with --reps like the per-test
// timeout does; the ceiling does not (a stress run repeats work, it does not
// hold more of it at once).
// ORGTREE_TEST_JOB_MB overrides the ceiling (0 = no ceiling); ORGTREE_TEST_
// RUN_TIMEOUT_MS overrides the run limit (0 = none). Both reach this file
// through tools/run_tests.py too: its child_env() strips ORGTREE_* but
// exempts ORGTREE_TEST_*. Without the job (non-Windows, or ceiling 0) the run
// limit still applies through spawnSync's own timeout, which bounds the
// direct child only — and that path SAYS it is uncontained, because an
// uncontained run that looks like a contained one is the guard that reads
// right and means nothing. A malformed override is refused, not read as 0.
//
// `containment.test.ts` is the positive control: it runs a planted allocator
// under a 512 MB ceiling and asserts it DIES with the allocation error, runs
// the same allocator under no ceiling and asserts it FINISHES, and runs a
// sleeper with a detached child past a 2 s run limit and asserts exit 124
// with no survivor. A guard that has never been seen to fire is not a guard
// (team rule 2).
const envInt = (name, dflt) => {
  const raw = process.env[name]
  if (raw === undefined) return dflt
  if (!/^\d+$/.test(raw.trim())) {
    console.error(`[run.mjs] ${name}=${JSON.stringify(raw)} is not a whole number of ${name.endsWith('_MS') ? 'milliseconds' : 'MB'}; refusing to guess`)
    process.exit(2)
  }
  return Number(raw.trim())
}
const JOB_MB = envInt('ORGTREE_TEST_JOB_MB', 6144)
const RUN_TIMEOUT_MS = envInt('ORGTREE_TEST_RUN_TIMEOUT_MS', 300_000 * REPS_N)

const files = readdirSync(out).filter((f) => f.endsWith('.mjs')).sort()
  .filter((f) => !filters.length || filters.some((filter) => f.includes(filter)))
if (!files.length) throw new Error(`no prebuilt test files match ${filters.join(', ') || '*'}`)
// --test-force-exit: React's scheduler holds a ref'd MessageChannel open for
// the process's whole life, so node would otherwise sit at 100 % pass and
// never exit.
const nodePrefix = ['--test', '--test-force-exit',
  `--test-timeout=${TIMEOUT_MS}`,
  ...(Number(CONCURRENCY) > 0 ? [`--test-concurrency=${CONCURRENCY}`] : [])]
const env = {
  ...process.env,
  ORGTREE_TEST_REPS: repsValue ?? process.env.ORGTREE_TEST_REPS,
}
const dependencyRoot = path.dirname(path.dirname(createRequire(import.meta.url).resolve('esbuild/package.json')))
env.NODE_PATH = [dependencyRoot, process.env.NODE_PATH].filter(Boolean).join(path.delimiter)

// PowerShell's ProcessStartInfo has a finite command-line string even when an
// argument file is used. Keep each batch below a conservative Windows limit;
// all batches still receive the same timeout, concurrency and Job Object.
const maxArgChars = envInt('ORGTREE_TEST_MAX_ARG_CHARS', 24_000)
const winArgLength = value => 2 + value.replaceAll('"', '\\"').length
const batches = []
let batch = []
let batchLength = nodePrefix.reduce((n, value) => n + winArgLength(value), 0)
for (const file of files) {
  const value = path.join(out, file)
  const addition = winArgLength(value) + 1
  if (addition + nodePrefix.reduce((n, item) => n + winArgLength(item), 0) > maxArgChars) {
    throw new Error(`test path exceeds ORGTREE_TEST_MAX_ARG_CHARS: ${value}`)
  }
  if (batch.length && batchLength + addition > maxArgChars) {
    batches.push(batch)
    batch = []
    batchLength = nodePrefix.reduce((n, item) => n + winArgLength(item), 0)
  }
  batch.push(value)
  batchLength += addition
}
if (batch.length) batches.push(batch)

const ps = path.join(process.env.SystemRoot ?? 'C:\\Windows',
  'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
argRoot = mkdtempSync(path.join(os.tmpdir(), 'orgtree-renderer-args-'))
const deadline = RUN_TIMEOUT_MS > 0 ? Date.now() + RUN_TIMEOUT_MS : 0
let aggregate = 0
for (let index = 0; index < batches.length; index++) {
  const args = [...nodePrefix, ...batches[index]]
  const remaining = deadline ? deadline - Date.now() : 0
  if (deadline && remaining <= 0) {
    console.error(`[run.mjs] RUN LIMIT: no batch remained within ${RUN_TIMEOUT_MS} ms`)
    aggregate = 124
    break
  }
  let status
  if (process.platform === 'win32') {
    // The argument list goes through a file one per line. joblimit.ps1 then
    // creates a contained process tree and enforces the same limits per batch.
    const argFile = path.join(argRoot, `node-args-${index}.txt`)
    writeFileSync(argFile, args.join('\n') + '\n')
    const timeoutSec = deadline ? Math.max(1, Math.ceil(remaining / 1000)) : 0
    const result = spawnSync(ps, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', path.join(HERE, 'joblimit.ps1'), '-LimitMB', String(JOB_MB),
      '-TimeoutSec', String(timeoutSec), '-WorkDir', path.join(HERE, '..'),
      '-Exe', process.execPath, '-ArgFile', argFile], { stdio: 'inherit', env })
    if (result.error) {
      console.error(`[run.mjs] could not start joblimit.ps1: ${result.error.message}`)
      status = 1
    } else status = result.status ?? 1
    if (status === 124) console.error(`[run.mjs] batch ${index + 1}/${batches.length} hit the run limit or was terminated by containment`)
    else if (status !== 0) console.error(`[run.mjs] batch ${index + 1}/${batches.length} failed with exit ${status}`)
  } else {
    console.error(`[run.mjs] containment OFF: no Job Object launcher on ${process.platform}; run limit applies to the direct child only`)
    const result = spawnSync(process.execPath, args, { stdio: 'inherit', env,
      ...(remaining > 0 ? { timeout: remaining, killSignal: 'SIGKILL' } : {}) })
    status = result.error?.code === 'ETIMEDOUT' ? 124 : (result.status ?? 1)
    if (status === 124) console.error(`[run.mjs] batch ${index + 1}/${batches.length} hit the run limit; child descendants are not covered without a Job Object`)
  }
  if (status !== 0) aggregate = status === 124 ? 124 : (aggregate || 1)
}

cleanup()
process.exitCode = aggregate
