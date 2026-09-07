// frontend/tests/containment/alloc.probe.mjs - the containment suite's planted
// allocator. NOT a test file (no .test. in the name, so run.mjs never bundles
// it): containment.test.ts launches it under tests/joblimit.ps1 to prove the
// memory ceiling actually kills and the absence of one actually lets it finish.
//
//   node alloc.probe.mjs <mb>          commit <mb> of ArrayBuffer in 32 MB
//                                      chunks, touch every page so the commit
//                                      is real, print "held <mb> MB", exit 0
//   node alloc.probe.mjs sleep <ms>    spawn ONE DETACHED CHILD of itself
//                                      (`sleep-child <ms>`) carrying the same
//                                      trailing --marker= argument, then sit
//                                      for <ms>; print "slept", exit 0
//   node alloc.probe.mjs sleep-child <ms>   the child: sit for 4 x <ms>, exit 0
//
// The detached child is the point of the sleep mode: `node --test` has
// children, and killing only the launched parent leaves them running. A
// detached grandchild that survives is what the run-limit test looks for by
// its marker (redteam-opus C2, 2026-09-07: without it, TerminateJobObject and
// KILL_ON_JOB_CLOSE could each be deleted and no test noticed).
//
// ArrayBuffer on purpose: it is EXTERNAL to V8's heap, the memory class
// --max-old-space-size cannot bound and the one the 2026-08-29 incident was
// made of (D-177).
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const [mode, arg, ...rest] = process.argv.slice(2)
if (mode === 'sleep' || mode === 'sleep-child') {
  if (mode === 'sleep') {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'sleep-child', arg, ...rest],
      { detached: true, stdio: 'ignore' })
    child.unref()
  }
  // the child sleeps 4x LONGER than its parent: a survivor check that runs
  // after the parent is gone must find a child that is still alive on its own,
  // or it is counting an empty room (redteam-opus R1: at 1x the orphan had
  // already exited by itself before any count ran)
  setTimeout(() => { console.log(mode === 'sleep' ? 'slept' : 'child slept'); process.exit(0) },
    mode === 'sleep-child' ? Number(arg) * 4 : Number(arg))
} else {
  const mb = Number(mode)
  const held = []
  const CHUNK = 32
  for (let done = 0; done < mb; done += CHUNK) {
    const buf = new Uint8Array(CHUNK * 1024 * 1024)
    for (let i = 0; i < buf.length; i += 4096) buf[i] = 1
    held.push(buf)
  }
  console.log(`held ${held.length * CHUNK} MB`)
  process.exit(0)
}
