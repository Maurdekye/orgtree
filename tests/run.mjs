// tests/run.mjs — the root suite's runner: `npm test` is `node tests/run.mjs`.
//
//   node tests/run.mjs                               tests/*.test.mjs, the `npm test` set
//   node tests/run.mjs tests/foo.test.mjs            named files or globs, as `node --test` takes them
//   node tests/run.mjs tests/foo.test.mjs --test-name-pattern "draft"
//                                                    node's own test flags pass through
//
// ⚠ WHY A RUNNER AND NOT A BARE `node --test` (2026-10-26). A bare run starts
// one child per CPU (sixteen here), with no per-test timeout, no memory bound
// and nothing that ends the tree as a whole; a failing assertion on a large
// value can then allocate without limit (the renderer suite's 41 GB incident,
// docs/agents/development-and-verification.md, "Renderer test memory guards").
// This applies the renderer runner's bounds to the root suite:
//   • refuse to start below ORGTREE_TEST_MIN_FREE_MB free (3072);
//   • cap every test process's V8 heap at ORGTREE_TEST_HEAP_MB (2048) and
//     preload testguard.mjs (bounded assertion reports), both through
//     NODE_OPTIONS: a `--max-old-space-size` flag on the `node --test` command
//     line does not reach its per-file children (measured on node 24.12);
//   • ORGTREE_TEST_CONCURRENCY files at once (4) and ORGTREE_TEST_TIMEOUT_MS per
//     test (120000; a test's own `{ timeout }` still wins). Both match
//     tools/test-baseline.mjs's defaults for this same suite;
//   • on Windows, the whole tree inside a Job Object (joblimit.ps1) with a
//     commit ceiling of ORGTREE_TEST_JOB_MB (6144) and a whole-run limit of
//     ORGTREE_TEST_RUN_TIMEOUT_MS (1800000) that ends every process in it.
// A malformed override is refused, not read as 0; 0 switches a bound off.
// tests/disruptive/ keeps its own `npm run test:disruptive`: its probes are
// gated on ORGTREE_DISRUPTIVE_PROBES and drive the desktop on purpose.

import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const RENDERER_TESTS = path.join(ROOT, 'apps', 'desktop', 'renderer', 'tests')

const envInt = (name, dflt) => {
  const raw = process.env[name]
  if (raw === undefined) return dflt
  if (!/^\d+$/.test(raw.trim())) {
    console.error(`[tests/run.mjs] ${name}=${JSON.stringify(raw)} is not a whole number of ${name.endsWith('_MS') ? 'milliseconds' : 'MB'}; refusing to guess`)
    process.exit(2)
  }
  return Number(raw.trim())
}

const MIN_FREE_MB = envInt('ORGTREE_TEST_MIN_FREE_MB', 3072)
const freeMb = Math.floor(os.freemem() / 2 ** 20)
if (MIN_FREE_MB > 0 && freeMb < MIN_FREE_MB) {
  console.error(`[tests/run.mjs] FREE MEMORY ${freeMb} MB is below the ${MIN_FREE_MB} MB floor (ORGTREE_TEST_MIN_FREE_MB); not starting`)
  process.exit(2)
}
const HEAP_MB = envInt('ORGTREE_TEST_HEAP_MB', 2048)
const CONCURRENCY = envInt('ORGTREE_TEST_CONCURRENCY', 4)
const TIMEOUT_MS = envInt('ORGTREE_TEST_TIMEOUT_MS', 120_000)
const JOB_MB = envInt('ORGTREE_TEST_JOB_MB', 6144)
const RUN_TIMEOUT_MS = envInt('ORGTREE_TEST_RUN_TIMEOUT_MS', 1_800_000)

// node's test flags that take their value as the NEXT argument; anything else
// that does not start with `-` is a file or glob
const VALUE_FLAGS = new Set(['--test-name-pattern', '--test-skip-pattern', '--test-reporter',
  '--test-reporter-destination', '--test-shard'])
const passed = process.argv.slice(2)
let hasFiles = false
for (let i = 0; i < passed.length; i++) {
  if (VALUE_FLAGS.has(passed[i])) i++
  else if (!passed[i].startsWith('-')) hasFiles = true
}
const args = ['--test',
  ...(CONCURRENCY > 0 ? [`--test-concurrency=${CONCURRENCY}`] : []),
  ...(TIMEOUT_MS > 0 ? [`--test-timeout=${TIMEOUT_MS}`] : []),
  ...passed, ...(hasFiles ? [] : ['tests/*.test.mjs'])]

const env = { ...process.env }
env.NODE_OPTIONS = [process.env.NODE_OPTIONS,
  ...(HEAP_MB > 0 ? [`--max-old-space-size=${HEAP_MB}`] : []),
  `--import=${pathToFileURL(path.join(RENDERER_TESTS, 'testguard.mjs')).href}`].filter(Boolean).join(' ')
delete env.ORGTREE_TEST_CONTAINED_MB
const contained = process.platform === 'win32' && JOB_MB > 0
if (contained) env.ORGTREE_TEST_CONTAINED_MB = String(JOB_MB)
console.error(`[tests/run.mjs] ${freeMb} MB free at start (floor ${MIN_FREE_MB || 'off'}); heap cap ${HEAP_MB ? `${HEAP_MB} MB` : 'node default'} per test process; concurrency ${CONCURRENCY || 'node default'}; per-test timeout ${TIMEOUT_MS || 'none'} ms`)

let status
if (process.platform === 'win32') {
  // the argument list goes through a file, one per line (joblimit.ps1's contract)
  const dir = mkdtempSync(path.join(os.tmpdir(), 'orgtree-root-tests-'))
  try {
    const argFile = path.join(dir, 'node-args.txt')
    writeFileSync(argFile, args.join('\n') + '\n')
    const result = spawnSync(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(RENDERER_TESTS, 'joblimit.ps1'),
        '-LimitMB', String(JOB_MB), '-TimeoutSec', String(Math.ceil(RUN_TIMEOUT_MS / 1000)),
        '-WorkDir', ROOT, '-Exe', process.execPath, '-ArgFile', argFile],
      { stdio: 'inherit', env, windowsHide: true })
    if (result.error) console.error(`[tests/run.mjs] could not start joblimit.ps1: ${result.error.message}`)
    status = result.error ? 1 : (result.status ?? 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
} else {
  console.error(`[tests/run.mjs] containment OFF: no Job Object launcher on ${process.platform}; the run limit ends the direct child only`)
  const result = spawnSync(process.execPath, args, { stdio: 'inherit', env, cwd: ROOT,
    ...(RUN_TIMEOUT_MS > 0 ? { timeout: RUN_TIMEOUT_MS, killSignal: 'SIGKILL' } : {}) })
  status = result.error?.code === 'ETIMEDOUT' ? 124 : (result.status ?? 1)
}
if (status === 124) console.error(`[tests/run.mjs] RUN LIMIT: the run was ended after ${RUN_TIMEOUT_MS} ms; files that had not finished never ran to completion`)
process.exitCode = status
