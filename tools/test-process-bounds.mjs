// tools/test-process-bounds.mjs — the bounds a node:test run() gives its
// per-file children, for runners that call run() in-process rather than
// launching `node --test` (tools/test-baseline.mjs's root suite).
//
// The renderer and root runners (apps/desktop/renderer/tests/run.mjs,
// tests/run.mjs) put these bounds in NODE_OPTIONS, because a flag on the
// `node --test` command line does not reach its per-file children (measured
// on node 24.12, 2026-10-26). run() takes an `execArgv` that it appends to
// every child's own command line, so here the flags are the children's own:
//   • --max-old-space-size=ORGTREE_TEST_HEAP_MB (2048; 0 = node's default)
//   • --import of testguard.mjs: bounded assertion reports, and a watchdog
//     that ends a child past 3072 MB resident or when its parent is gone
// plus the free-memory floor ORGTREE_TEST_MIN_FREE_MB (3072; 0 = none) that
// the caller checks before starting. A malformed override is refused, not
// read as 0. tests/run-bounds.test.mjs §3 holds the control.

import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
export const TESTGUARD = path.join(ROOT, 'apps', 'desktop', 'renderer', 'tests', 'testguard.mjs')

function envMb(env, name, dflt) {
  const raw = env[name]
  if (raw === undefined || raw === '') return dflt
  if (!/^\d+$/.test(String(raw).trim())) throw new Error(`${name}=${JSON.stringify(raw)} is not a whole number of MB; refusing to guess`)
  return Number(String(raw).trim())
}

/** `{ heapMb, minFreeMb, execArgv }` for a run() whose children must be bounded. */
export function testProcessBounds(env = process.env) {
  const heapMb = envMb(env, 'ORGTREE_TEST_HEAP_MB', 2048)
  const minFreeMb = envMb(env, 'ORGTREE_TEST_MIN_FREE_MB', 3072)
  return {
    heapMb,
    minFreeMb,
    execArgv: [...(heapMb > 0 ? [`--max-old-space-size=${heapMb}`] : []), `--import=${pathToFileURL(TESTGUARD).href}`],
  }
}

/** Throws, naming the floor, when the machine has less free memory than it. */
export function assertFreeMemory(minFreeMb, label = 'test run', freeMb = Math.floor(os.freemem() / 2 ** 20)) {
  if (minFreeMb > 0 && freeMb < minFreeMb) {
    throw new Error(`FREE MEMORY ${freeMb} MB is below the ${minFreeMb} MB floor (ORGTREE_TEST_MIN_FREE_MB); not starting the ${label}`)
  }
  return freeMb
}
