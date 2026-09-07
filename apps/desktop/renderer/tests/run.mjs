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
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as esbuild from 'esbuild'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const argv = process.argv.slice(2)
const repsIdx = process.argv.indexOf('--reps')
// the value after --reps is not a filename filter
const filter = argv.filter((a, i) => !a.startsWith('--')
  && argv[i - 1] !== '--reps')[0] ?? ''

const entries = readdirSync(HERE)
  .filter((f) => /\.test\.tsx?$/.test(f))
  .filter((f) => !filter || f.includes(filter))
  .map((f) => path.join(HERE, f))

if (!entries.length) {
  console.error(`no test files match ${filter || '*'}`)
  process.exit(1)
}

// ⚠ the bundle lands INSIDE node_modules on purpose: it imports jsdom (kept
// external), and node resolves a bare specifier by walking up from the
// importing file — from a temp dir that walk never reaches frontend's
// node_modules. It is also already ignored by every VCS rule in the tree.
const out = path.join(HERE, '..', 'node_modules', '.orgtree-tests')
rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })
await esbuild.build({
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
const REPS_N = Math.max(1, Number(repsIdx > 0
  ? process.argv[repsIdx + 1]
  : process.env.ORGTREE_TEST_REPS) || 1)
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

const files = readdirSync(out).filter((f) => f.endsWith('.mjs'))
// --test-force-exit: React's scheduler holds a ref'd MessageChannel open for
// the process's whole life, so node would otherwise sit at 100 % pass and
// never exit.
const nodeArgs = ['--test', '--test-force-exit',
  `--test-timeout=${TIMEOUT_MS}`,
  ...(Number(CONCURRENCY) > 0 ? [`--test-concurrency=${CONCURRENCY}`] : []),
  ...files.map((f) => path.join(out, f))]
const env = {
  ...process.env,
  ORGTREE_TEST_REPS: repsIdx > 0 ? process.argv[repsIdx + 1] : process.env.ORGTREE_TEST_REPS,
}

if (process.platform === 'win32' && JOB_MB > 0) {
  // the argument list goes through a file, one per line: dozens of bundle
  // paths must not pass through powershell's own quoting a second time
  const argFile = path.join(out, 'node-args.txt')
  writeFileSync(argFile, nodeArgs.join('\n') + '\n')
  const ps = path.join(process.env.SystemRoot ?? 'C:\\Windows',
    'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const r = spawnSync(ps, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', path.join(HERE, 'joblimit.ps1'),
    '-LimitMB', String(JOB_MB),
    '-TimeoutSec', String(Math.ceil(RUN_TIMEOUT_MS / 1000)),
    '-WorkDir', path.join(HERE, '..'),
    '-Exe', process.execPath,
    '-ArgFile', argFile], { stdio: 'inherit', env })
  if (r.error || r.status !== 0) {
    if (r.error) console.error(`[run.mjs] could not start joblimit.ps1: ${r.error.message}`)
    // a ceiling that fires can leave NO output at all (the child dies before
    // its reporter writes), so name the bounds as candidate causes here
    else console.error(`[run.mjs] test job exited ${r.status}. If there is no test output above, the ${JOB_MB} MB job ceiling or the ${RUN_TIMEOUT_MS} ms run limit is the likely cause (ORGTREE_TEST_JOB_MB / ORGTREE_TEST_RUN_TIMEOUT_MS; 0 disables).`)
    process.exit(1)
  }
} else {
  console.error(`[run.mjs] containment OFF: ${process.platform !== 'win32'
    ? `no Job Object launcher on ${process.platform}`
    : 'ORGTREE_TEST_JOB_MB=0'}; run limit ${RUN_TIMEOUT_MS > 0 ? `${RUN_TIMEOUT_MS} ms on the direct child only` : 'none'}`)
  const r = spawnSync(process.execPath, nodeArgs, {
    stdio: 'inherit', env,
    ...(RUN_TIMEOUT_MS > 0 ? { timeout: RUN_TIMEOUT_MS, killSignal: 'SIGKILL' } : {}),
  })
  if (r.error?.code === 'ETIMEDOUT') {
    console.error(`[run.mjs] RUN LIMIT: no exit after ${RUN_TIMEOUT_MS} ms - test parent killed (children not covered without the job)`)
  }
  if (r.error || r.status !== 0) process.exit(1)
}
