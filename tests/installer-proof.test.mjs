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
const { installerProofStep, INSTALLER_PROOF, NO_INSTALLER_SIGHTINGS } = createRequire(import.meta.url)(outfile)

/** Drive a whole sequence of sightings, as the real poll would, and return
 *  every verdict plus the one it settled on. */
function run(sightings, bounds = INSTALLER_PROOF) {
  let memory = NO_INSTALLER_SIGHTINGS
  const verdicts = []
  for (const seen of sightings) {
    const step = installerProofStep(memory, seen, bounds)
    memory = step.memory
    verdicts.push(step.result.verdict)
    if (step.result.verdict !== 'pending') return { verdicts, settled: step.result }
  }
  return { verdicts, settled: null }
}

/** A look that SUCCEEDED. `readable` defaults true here because the interesting
 *  majority of cases are successful looks; the unreadable ones are built with
 *  `blind()` below and say so at the call site. */
const at = (elapsedMs, installerRunning, elevatorRunning, readable = true) =>
  ({ elapsedMs, installerRunning, elevatorRunning, readable })
/** A look that FAILED — the process table could not be read at all. It must
 *  never decide anything: see the sections at the end of this file. */
const blind = (elapsedMs) => ({ elapsedMs, installerRunning: false, elevatorRunning: false, readable: false })
/** A run of successful looks showing nothing, at the real poll interval. The
 *  appear bound needs a FLOOR of real readings before it may fire, so a
 *  two-element sequence no longer reaches it - which is the whole point of the
 *  floor, and the reason these sequences are built rather than hand-listed. */
const nothingSeen = (count, from = 0) =>
  Array.from({ length: count }, (_unused, index) => at(from + index * INSTALLER_PROOF.pollMs, false, false))

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
  // 32 looks at 250ms reaches 7750ms: inside the bound, and past the floor.
  const before = run(nothingSeen(32))
  assert.equal(before.settled, null, 'inside the bound it is still waiting')
  // 33 looks reaches exactly 8000ms.
  const after = run(nothingSeen(33))
  assert.equal(after.settled?.verdict, 'failed')
  assert.match(after.settled.detail, /no installer process appeared within 8000ms/)
  assert.match(after.settled.detail, /across \d+ readings of the process list/,
    'and it says how many real readings it is based on, because "we looked and '
    + 'saw nothing" is only meaningful if we actually looked')

  // ⚠ THE FLOOR IS LOAD-BEARING: elapsed time alone must not be enough. Two
  // looks that happen to straddle the bound are not evidence of absence.
  const tooFewLooks = run([at(0, false, false), at(INSTALLER_PROOF.appearMs, false, false)])
  assert.equal(tooFewLooks.settled, null,
    'past the bound but with only 2 successful readings, the wait continues - '
    + 'without this, a couple of slow looks could condemn a healthy install')
})

test('§5 an installer that DIES INSTANTLY is caught — the case that emits no error at all', () => {
  // Blocked by anti-virus or policy a moment after CreateProcess: the spawn
  // succeeded, so electron-updater reports nothing, ever.
  const { settled } = run(nothingSeen(33))
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
  let memory = NO_INSTALLER_SIGHTINGS
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
    { name: 'installer died instantly', seq: nothingSeen(33) },
  ]
  for (const { name, seq } of failing) {
    assert.equal(oldRuleSaysInstalled(), true, `${name}: the old rule reports success`)
    assert.equal(run(seq).settled?.verdict, 'failed', `${name}: the new rule reports failure`)
  }
})

// ---------------------------------------------------------------- the WAIT
// §1-§9 are the rule. These drive the loop that applies it: what gets recorded,
// how long it is prepared to wait, and that it never returns on silence.

const { awaitInstallerProof } = createRequire(import.meta.url)(outfile)

/** Drive the loop over a scripted sequence of looks. The clock advances by
 *  pollMs per look, so `elapsedMs` is real without any waiting. */
function wait(script, extra = {}) {
  const stages = []
  let i = 0, clock = 0
  const bounds = { appearMs: INSTALLER_PROOF.appearMs, pollMs: INSTALLER_PROOF.pollMs, ...extra.bounds }
  return awaitInstallerProof({
    // ⚠ A LOOK CAP, so a non-terminating loop FAILS instead of hanging. The
    // sampler used to clamp to the last scripted look for ever, which meant a
    // mutation that stopped the wait from terminating wedged the whole file
    // with no verdict - and a hang is strictly worse than a failure, because a
    // failure is information.
    sample: async () => {
      if (i > 4000) throw new Error(`awaitInstallerProof did not terminate after ${i} looks`)
      return script[Math.min(i++, script.length - 1)]
    },
    now: () => clock,
    sleep: async () => { clock += bounds.pollMs },
    record: (stage, detail) => stages.push({ stage, detail }),
    bounds,
    ...extra,
  }).then(result => ({ result, stages, looks: i }))
}
const look = (installerRunning, elevatorRunning, readable = true) => ({ installerRunning, elevatorRunning, readable })
/** A look the sampler could not answer. */
const blindLook = () => ({ installerRunning: false, elevatorRunning: false, readable: false })

test('§10 a proven installer is recorded as RUNNING — the stage that means an update is really under way', async () => {
  const { result, stages } = await wait([look(false, false), look(false, false), look(true, false)])
  assert.equal(result.verdict, 'started')
  assert.deepEqual(stages.map(s => s.stage), ['installer-running'])
  assert.match(stages[0].detail, /observed running/)
})

test('§11 a UAC prompt is announced ONCE, and the wait outlasts it', async () => {
  const script = []
  for (let n = 0; n < 200; n++) script.push(look(false, true))   // prompt up, far past any grace
  script.push(look(true, true))                                   // approved
  const { result, stages } = await wait(script)
  assert.equal(result.verdict, 'started')
  assert.deepEqual(stages.map(s => s.stage), ['installer-awaiting-elevation', 'installer-running'],
    'the prompt is recorded once, not on every look — a readable log, not a wall')
  assert.match(stages[0].detail, /permission prompt is open/)
})

test('§12 a dismissed prompt ends the wait as NEVER STARTED, not as success', async () => {
  const { result, stages } = await wait([look(false, true), look(false, true), look(false, false)])
  assert.equal(result.verdict, 'failed')
  assert.deepEqual(stages.map(s => s.stage), ['installer-awaiting-elevation', 'installer-never-started'])
  assert.match(stages[1].detail, /dismissed, or the launch was blocked/)
})

test('§13 SILENCE never returns success — the loop runs to the bound and then reports failure', async () => {
  const { result, stages, looks } = await wait([look(false, false)])
  assert.equal(result.verdict, 'failed')
  assert.deepEqual(stages.map(s => s.stage), ['installer-never-started'])
  assert.ok(looks > 1, 'it really did keep looking rather than deciding on the first glance')
})

test('§14 a spawn error electron-updater DOES report ends the wait at once', async () => {
  // The one failure the library can tell us about. Waiting out a bound after it
  // would be waiting for something already known not to be coming.
  const { result, stages, looks } = await wait([look(false, false)], { reportedError: () => new Error('ENOENT installer missing') })
  assert.equal(result.verdict, 'failed')
  assert.equal(looks, 0, 'it did not even look at the process table')
  assert.deepEqual(stages.map(s => s.stage), ['installer-never-started'])
  // the raw error is handed to record() on purpose - UpdateLog.record
  // sanitizes every detail it is given, and passing the value through keeps
  // the most information. This fake record does not sanitize, hence String().
  assert.match(String(stages[0].detail), /ENOENT/)
})

// ------------------------------------------------- the instrument, not the subject
// §16-§20 are about the PROCESS LISTING FAILING rather than about the installer.
// The old rule collapsed "I could not look" into "I looked and saw nothing",
// which are opposite claims: `tasklist` has a 4000ms timeout and the appear
// bound is 8000ms, so two hung listings could burn the whole bound and report a
// perfectly healthy install as never started. The comment beside the sampler
// claimed an unreadable listing "can only delay a verdict, never invent one" —
// staffing-flow showed that was true only while an elevator had been seen.

test('§16 THE CASE THAT USED TO INVENT A FAILURE: two hung listings decide nothing', async () => {
  // Exactly the reported arithmetic: two unreadable looks straddling the bound.
  const { settled, verdicts } = run([blind(0), blind(4000), blind(8250)])
  assert.equal(settled, null,
    'no verdict at all: a bound cannot be burned by looks that never happened')
  assert.deepEqual(verdicts, ['pending', 'pending', 'pending'])

  // POSITIVE CONTROL, and it is the same arithmetic with the ONLY difference
  // being that the looks succeeded. Without this the section above would also
  // pass against a rule that never fails anything.
  const readable = run(nothingSeen(33))
  assert.equal(readable.settled?.verdict, 'failed',
    'CONTROL: the same elapsed time with REAL readings does report failure, so '
    + '§16 is about readability and not about the bound being unreachable')
})

test('§17 an unreadable table past the outer bound is UNKNOWN, never failed', () => {
  const { settled } = run([blind(0), blind(INSTALLER_PROOF.unreadableMs)])
  assert.equal(settled?.verdict, 'unknown',
    'we did not observe an absent installer, we failed to observe anything - and '
    + 'the caller owes that the unproven exit, not a "did not install" message')
  assert.match(settled.detail, /could not be read/)
  assert.notEqual(settled.verdict, 'failed')
})

test('§18 AN ABSENCE IS CONFIRMED TWICE: one readable look after blind ones is not enough', () => {
  // A single successful look arriving after a gap cannot end the wait, because
  // a silent install that had already finished would read identically to one
  // that never started.
  const single = run([blind(0), blind(4000), at(8250, false, false)])
  assert.equal(single.settled, null, 'the first readable look after a gap only starts confirming')
  // The NEXT readable look does decide - the previous one was readable too.
  const confirmed = run([blind(0), blind(4000), ...nothingSeen(9, 8250)])
  assert.equal(confirmed.settled?.verdict, 'failed', 'consecutive real readings do decide')

  // AND THE SAME RULE PROTECTS THE ELEVATOR PATH, which is where it matters
  // most: the elevator seen, then the table unreadable, then one look showing
  // nothing, must NOT be read as a dismissed prompt.
  const elevatorGap = run([at(0, false, true), blind(250), at(500, false, false)])
  assert.equal(elevatorGap.settled, null,
    'not a refusal yet: the look that saw no elevator followed a blind one')
  const elevatorReally = run([at(0, false, true), at(250, false, false), at(500, false, false)])
  assert.equal(elevatorReally.settled?.verdict, 'failed',
    'CONTROL: two consecutive real readings with the elevator gone IS the refusal')
})

test('§19 a readable look showing the installer still settles it immediately, gap or not', () => {
  // Positive proof outranks every caution above: the caution exists to avoid
  // inventing failures, never to delay success.
  const { settled } = run([blind(0), blind(4000), at(8250, true, false)])
  assert.equal(settled?.verdict, 'started')
})

test('§20 the wait records UNKNOWN as proof-unavailable, and keeps looking until then', async () => {
  const { result, stages, looks } = await wait([blindLook()], { bounds: { unreadableMs: 2000 } })
  assert.equal(result.verdict, 'unknown')
  assert.deepEqual(stages.map(s => s.stage), ['installer-proof-unavailable'],
    'the same stage the cannot-identify fallback uses, because it is the same '
    + 'state: nobody checked')
  assert.ok(looks > 1, 'and it really did keep trying rather than giving up on the first failure')
  // NEGATIVE CONTROL: it must not be recorded as a verdict about the installer.
  assert.equal(stages.some(s => s.stage === 'installer-never-started'), false)
})

test('§15 every terminal path records exactly one durable verdict stage', async () => {
  const paths = [
    [look(true, false)],
    [look(false, true), look(false, false)],
    [look(false, false)],
  ]
  for (const script of paths) {
    const { stages } = await wait(script)
    const verdicts = stages.filter(s => s.stage === 'installer-running' || s.stage === 'installer-never-started')
    assert.equal(verdicts.length, 1, `exactly one verdict recorded, got ${JSON.stringify(stages.map(s => s.stage))}`)
  }
})
