// installer-proof.test.mjs — PROOF THAT AN INSTALLER PROCESS ACTUALLY LIVES.
//
// The defect this measures: `install()` returning true means electron-updater
// got a pid back, and a pid means a process OBJECT WAS CREATED. It does not
// mean the process survived, is the installer, or accepted anything
// (BaseUpdater.spawnLog resolves on `p.pid !== undefined`). A process that
// starts and then dies emits no 'error', so the app recorded a handoff, waited
// out a silent grace and quit having installed nothing.
//
// The two cases that drive the whole design, and that a naive liveness check
// gets backwards:
//   * §2 UAC CANCELLED. elevate.exe is alive the entire time the prompt is on
//     screen, so "something we spawned is running" is TRUE in exactly the case
//     we must catch. Only the installer's own image proves approval.
//   * §3 A SLOW PROMPT. A person may leave a prompt up far longer than any
//     grace. Timing out there would fail an update that is still about to
//     succeed, and would relaunch the app into a race with its own installer.
//
// Pure inputs throughout: no process is spawned and nothing is installed, which
// is what lets the cancelled/blocked/slow matrix be covered on a development
// machine at all.
//
// Run: node --test tests/installer-proof.test.mjs

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { build } from 'esbuild'
import { createRequire } from 'node:module'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orgtree-installer-proof-'))
const outfile = path.join(root, 'updater.cjs')
await build({ entryPoints: ['apps/desktop/main/updater.ts'], outfile, bundle: true, format: 'cjs', platform: 'node' })
const { installerProofStep, INSTALLER_PROOF } = createRequire(import.meta.url)(outfile)

/** Drive a whole sequence of sightings, as the real poll would, and return
 *  every verdict plus the one it settled on. */
function run(sightings, bounds = INSTALLER_PROOF) {
  let memory = { elevatorSeen: false }
  const verdicts = []
  for (const seen of sightings) {
    const step = installerProofStep(memory, seen, bounds)
    memory = step.memory
    verdicts.push(step.result.verdict)
    if (step.result.verdict !== 'pending') return { verdicts, settled: step.result }
  }
  return { verdicts, settled: null }
}

const at = (elapsedMs, installerRunning, elevatorRunning) =>
  ({ elapsedMs, installerRunning, elevatorRunning })

test('§1 the installer running is the ONE positive proof, and it ends the wait', () => {
  const { settled } = run([
    at(0, false, false),
    at(250, false, false),
    at(500, true, false),
  ])
  assert.equal(settled?.verdict, 'started')
  assert.match(settled.detail, /observed running after 500ms/)
})

test('§2 UAC CANCELLED is a failure, even though the elevator was alive throughout the prompt', () => {
  // This is the case the old code read as success: elevate.exe gets a pid,
  // spawnLog resolves true, install() returns true, no 'error' is ever emitted,
  // and the 3s grace passes in silence while the prompt is still up.
  const { verdicts, settled } = run([
    at(0, false, true),        // prompt raised
    at(250, false, true),      // still up — the user is reading it
    at(500, false, true),
    at(750, false, false),     // dismissed: the elevator exited, no installer
  ])
  assert.deepEqual(verdicts.slice(0, 3), ['pending', 'pending', 'pending'],
    'while the prompt is up the only correct answer is to wait')
  assert.equal(settled?.verdict, 'failed')
  assert.match(settled.detail, /dismissed, or the launch was blocked/)
})

test('§3 a SLOW prompt is never timed out — waiting is unbounded while the elevator lives', () => {
  // Far past appearMs, and past any grace the old code had. An answer is still
  // coming; declaring failure here would race the installer it is about to
  // start.
  const long = []
  for (let ms = 0; ms <= INSTALLER_PROOF.appearMs * 12; ms += INSTALLER_PROOF.pollMs) long.push(at(ms, false, true))
  const { verdicts, settled } = run(long)
  assert.equal(settled, null, 'no verdict was forced')
  assert.ok(verdicts.length > 300, 'and it really did keep waiting')
  assert.ok(verdicts.every(v => v === 'pending'))
  // ...and it still resolves correctly once the user finally approves
  const approved = run([...long, at(999999, true, true)])
  assert.equal(approved.settled?.verdict, 'started')
})

test('§4 NO elevation: the installer should appear at once, and the wait IS bounded', () => {
  const before = run([at(0, false, false), at(INSTALLER_PROOF.appearMs - 1, false, false)])
  assert.equal(before.settled, null, 'inside the bound it is still waiting')
  const after = run([at(0, false, false), at(INSTALLER_PROOF.appearMs, false, false)])
  assert.equal(after.settled?.verdict, 'failed')
  assert.match(after.settled.detail, /no installer process appeared within 8000ms/)
})

test('§5 an installer that DIES INSTANTLY is caught — the case that emits no error at all', () => {
  // Blocked by anti-virus or policy a moment after CreateProcess: the spawn
  // succeeded, so electron-updater reports nothing, ever.
  const { settled } = run([
    at(0, false, false),
    at(250, false, false),
    at(INSTALLER_PROOF.appearMs, false, false),
  ])
  assert.equal(settled?.verdict, 'failed', 'silence must never read as success')
})

test('§6 an elevator that never appears is not mistaken for one that exited', () => {
  // Both look like "no elevator running now". Only the memory of having SEEN
  // one turns the second reading into a refusal, and the bound must still
  // apply to the first.
  const never = run([at(0, false, false), at(100, false, false)])
  assert.equal(never.settled, null, 'never-seen is still waiting inside the bound')
  const exited = run([at(0, false, true), at(100, false, false)])
  assert.equal(exited.settled?.verdict, 'failed',
    'seen-then-gone is a decision, and it was no')
  assert.match(exited.settled.detail, /elevation helper exited/)
})

test('§7 approval that arrives in the SAME look as the elevator is still approval', () => {
  // The elevator has not exited yet and the installer is already up — a real
  // and common overlap. The positive proof must outrank everything.
  const { settled } = run([at(0, false, true), at(250, true, true)])
  assert.equal(settled?.verdict, 'started')
})

test('§8 memory only ever accumulates — a flicker in the elevator reading cannot un-see it', () => {
  let memory = { elevatorSeen: false }
  memory = installerProofStep(memory, at(0, false, true)).memory
  assert.equal(memory.elevatorSeen, true)
  memory = installerProofStep(memory, at(250, false, false)).memory
  assert.equal(memory.elevatorSeen, true, 'the fact it was once up is durable')
})

test('§9 NEGATIVE CONTROL: the old rule — "a pid came back and nothing errored" — passes every failing case', () => {
  // What the code did before: treat the absence of a spawn error as success.
  // Modelled here so the difference is measured rather than asserted in prose.
  const oldRuleSaysInstalled = () => true            // no 'error' ever arrives
  const failing = [
    { name: 'UAC cancelled', seq: [at(0, false, true), at(250, false, false)] },
    { name: 'installer died instantly', seq: [at(0, false, false), at(INSTALLER_PROOF.appearMs, false, false)] },
  ]
  for (const { name, seq } of failing) {
    assert.equal(oldRuleSaysInstalled(), true, `${name}: the old rule reports success`)
    assert.equal(run(seq).settled?.verdict, 'failed', `${name}: the new rule reports failure`)
  }
})
