// frontend/tests/testguard/watch.probe.mjs - testguard.test.tsx's planted
// runaway and orphan. NOT a test file (run.mjs never bundles it).
//
//   node watch.probe.mjs alloc <guard.mjs> <mb>
//       import the guard, then commit 32 MB every 40 ms in a SYNCHRONOUS loop
//       (a busy-wait, so the main thread never yields, like the incident's
//       diff) up to <mb>; print "held <mb> MB" if nothing stopped it
//   node watch.probe.mjs idle <guard.mjs>
//       import the guard and sit for 20 s, then print "idle child exited"
//   node watch.probe.mjs orphan <guard.mjs> <pidFile>
//       spawn `idle` DETACHED (outside node's kill-on-close job, so nothing
//       but the guard ties it to this parent), write its pid, exit at once
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'

const [mode, guardPath, arg] = process.argv.slice(2)

if (mode === 'orphan') {
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'idle', guardPath],
    { detached: true, stdio: 'ignore' })
  child.unref()
  writeFileSync(arg, String(child.pid))
  process.exit(0)
}

await import(pathToFileURL(guardPath).href)
if (mode === 'alloc') {
  const held = []
  for (let mb = 0; mb < Number(arg); mb += 32) {
    const buf = new Uint8Array(32 * 1024 * 1024)
    for (let i = 0; i < buf.length; i += 4096) buf[i] = 1
    held.push(buf)
    const until = Date.now() + 40
    while (Date.now() < until) { /* never yield to the event loop */ }
  }
  console.log(`held ${held.length * 32} MB`)
} else if (mode === 'idle') {
  setTimeout(() => { console.log('idle child exited'); process.exit(0) }, 20_000)
}
