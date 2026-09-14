// console-window-lock.mjs — ONE test at a time may own a console window.
//
// ⚠ WHY THIS EXISTS, because it looks like over-engineering until it bites.
// `node --test` runs test FILES concurrently, in separate processes, and
// `npm test` globs every file at once. Two files here spawn real consoles and
// close them by posting WM_CLOSE to the host's window, found by matching its
// title. Run at the same time, they interfere in two distinct ways, both
// measured on this machine:
//
//   - The default console host is WINDOWS TERMINAL, which hosts several
//     consoles as TABS IN ONE WINDOW. MainWindowTitle then reports only the
//     ACTIVE tab, so the other file's probe becomes invisible and its close
//     reports 'no-window' — a failure that looks like the probe never started.
//   - Worse in principle: closing a tabbed host window closes EVERY tab in it,
//     so one file's close can end the other file's probe and make a survival
//     assertion fail for a reason that has nothing to do with the code.
//
// Serialising the console-window work removes both. The lock is a directory,
// because mkdir is atomic across processes, and it is taken by the tests that
// touch console WINDOWS only — everything else still runs concurrently.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const LOCK = path.join(os.tmpdir(), 'orgtree-console-window-probe.lock')
/** A run killed mid-test must not wedge every later run. Comfortably longer
 *  than any single console section, which is a few seconds. */
const STALE_MS = 120_000
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))

/** Take the lock, and return the function that releases it. Hold it across the
 *  whole spawn-and-close sequence, not just the close. */
export async function acquireConsoleWindowLock(timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      fs.mkdirSync(LOCK)
      return () => { try { fs.rmSync(LOCK, { recursive: true, force: true }) } catch { /* already released */ } }
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      try {
        if (Date.now() - fs.statSync(LOCK).mtimeMs > STALE_MS) {
          fs.rmSync(LOCK, { recursive: true, force: true })
          continue
        }
      } catch { /* it vanished under us, which means it is free */ }
      if (Date.now() > deadline) {
        throw new Error(`another console-window test still holds ${LOCK} after ${timeoutMs}ms`)
      }
      await sleep(250)
    }
  }
}
