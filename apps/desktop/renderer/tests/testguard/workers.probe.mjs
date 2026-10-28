// frontend/tests/testguard/workers.probe.mjs - testguard.test.tsx's Worker
// counter. NOT a test file (run.mjs never bundles it).
//
// Preloaded with --import BEFORE testguard.mjs (through NODE_OPTIONS, the way
// run.mjs preloads the guard), it wraps worker_threads.Worker in every isolate
// that loads it, so each Worker constructed there prints one line:
// "[workers.probe] created in main" or "[workers.probe] created in worker".
import workerThreads from 'node:worker_threads'
import { syncBuiltinESMExports } from 'node:module'
import { writeSync } from 'node:fs'

const Real = workerThreads.Worker
workerThreads.Worker = class extends Real {
  constructor(...args) {
    super(...args)
    try { writeSync(1, `[workers.probe] created in ${workerThreads.isMainThread ? 'main' : 'worker'}\n`) } catch {}
  }
}
syncBuiltinESMExports()
