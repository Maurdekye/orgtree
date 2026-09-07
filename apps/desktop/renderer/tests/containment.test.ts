/** Containment of the frontend test run itself (tests/joblimit.ps1, run.mjs):
 *  the positive control for a guard that must be SEEN to fire.
 *
 * run.mjs runs the whole `node --test` tree inside a Windows Job Object with a
 * job-wide commit ceiling and a whole-run time limit (D-177, containment
 * approved by the user 2026-09-07). A ceiling nobody has watched kill anything
 * is a name-based guard: it reads right, runs, and might mean nothing. So this
 * suite launches the launcher on a planted allocator (tests/containment/
 * alloc.probe.mjs) and asserts each side of every bound:
 *
 * §1 a 640 MB allocation under a 512 MB ceiling DIES with the incident's own
 *    error text, non-zero exit — the ceiling is real and it is the kernel's
 * §2 the same allocation under NO ceiling FINISHES and reports what it held —
 *    the launcher itself does not kill a healthy child (anti-vacuity: without
 *    this, §1 would pass against a launcher that kills everything)
 * §3 a 10 s sleeper that spawned a detached 40 s child, under a 2 s run limit,
 *    exits 124 within a few seconds and leaves NO surviving process — the
 *    limit terminates the tree, not a parent (the child outlives the parent
 *    so the survivor count has something to find if the tree kill is gone)
 *
 * Windows only, and it says so: on any other platform every case is SKIPPED
 * with the reason, never passed, because the launcher does not run there.
 *
 * Each case spawns Windows PowerShell 5.1 the exact way run.mjs does. The
 * memory cost is bounded by the cases themselves (640 MB for ~1 s, twice).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

declare const __SRC_DIR__: string
const TESTS = path.join(__SRC_DIR__, '..', 'tests')
const LAUNCHER = path.join(TESTS, 'joblimit.ps1')
const PROBE = path.join(TESTS, 'containment', 'alloc.probe.mjs')
const PS = path.join(process.env.SystemRoot ?? 'C:\\Windows',
  'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
const WIN = process.platform === 'win32'
const skip = WIN ? false : `joblimit.ps1 is a Windows Job Object launcher; not run on ${process.platform}`

function launch(limitMb: number, timeoutSec: number, probeArgs: string[]) {
  const dir = mkdtempSync(path.join(tmpdir(), 'orgtree-contain-'))
  const argFile = path.join(dir, 'args.txt')
  // a marker only this child carries, so §3 can look for survivors by it
  const marker = `contain-${process.pid}-${Date.now()}`
  writeFileSync(argFile, [PROBE, ...probeArgs, `--marker=${marker}`].join('\n') + '\n')
  const started = Date.now()
  // ⚠ output goes to a FILE, not a pipe. A pipe is held open by every process
  // that inherited it — including a detached grandchild the launcher failed to
  // kill — so spawnSync would not return until that orphan died on its own,
  // and the survivor count in §3 would then always run against an empty room
  // (redteam-opus R1). With a file, spawnSync returns when the LAUNCHER exits,
  // and whatever it left behind is still there to be counted.
  const outFile = path.join(dir, 'out.txt')
  const fd = openSync(outFile, 'w')
  const r = spawnSync(PS, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', LAUNCHER, '-LimitMB', String(limitMb), '-TimeoutSec', String(timeoutSec),
    '-WorkDir', path.join(TESTS, '..'), '-Exe', process.execPath, '-ArgFile', argFile],
  { stdio: ['ignore', fd, fd], timeout: 60_000 })
  closeSync(fd)
  return { ...r, marker, elapsedMs: Date.now() - started, out: readFileSync(outFile, 'utf8') }
}

test('§0 the launcher and the probe exist where run.mjs looks for them', { skip }, () => {
  assert.ok(existsSync(LAUNCHER), LAUNCHER)
  assert.ok(existsSync(PROBE), PROBE)
  assert.ok(existsSync(PS), PS)
})

test('§1 640 MB under a 512 MB ceiling dies with the allocation error', { skip }, () => {
  const r = launch(512, 60, ['640'])
  assert.notEqual(r.status, 0, `expected a non-zero exit, got ${r.status}\n${r.out}`)
  assert.match(r.out, /Array buffer allocation failed|FATAL ERROR|out of memory/i,
    `the child should have died on its allocation, not on something else:\n${r.out}`)
  assert.doesNotMatch(r.out, /held 640 MB/, `the ceiling let the allocation through:\n${r.out}`)
  assert.match(r.out, /\[joblimit\] memory ceiling = 512 MB/, r.out)
})

test('§2 the same 640 MB under no ceiling finishes and reports what it held', { skip }, () => {
  const r = launch(0, 60, ['640'])
  assert.equal(r.status, 0, `healthy child was not allowed to finish:\n${r.out}`)
  assert.match(r.out, /held 640 MB/, r.out)
  assert.match(r.out, /\[joblimit\] memory ceiling = none/, r.out)
})

/** node.exe processes whose command line contains `needle` — `@()` so one
 *  match counts as 1, not as an empty string. */
function nodeCount(needle: string): string {
  const q = spawnSync(PS, ['-NoProfile', '-NonInteractive', '-Command',
    `@(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*${needle}*' }).Count`],
  { encoding: 'utf8', timeout: 30_000 })
  return `${(q.stdout ?? '').trim()}${q.stderr ? ` [stderr: ${q.stderr.trim()}]` : ''}`
}

test('§3 a sleeper with a detached child past a 2 s run limit exits 124 promptly and leaves no survivor', { skip }, () => {
  // positive control for the survivor query: THIS process is a node.exe whose
  // command line names its bundle, so the query must be able to count ≥ 1
  const self = nodeCount(path.basename(process.argv[1] ?? 'orgtree-tests'))
  assert.ok(Number(self) >= 1, `the survivor query cannot see a running node.exe: ${self}`)

  const r = launch(512, 2, ['sleep', '10000'])
  // survivors FIRST: the launched parent AND its detached child (which sleeps
  // 4x longer, so it is still alive on its own here) both carry the marker;
  // the child is what a parent-only kill would leave behind, and this is the
  // assertion the run limit exists for — it speaks before the timing one
  const left = nodeCount(r.marker)
  assert.equal(left, '0', `a process from the terminated job survived (count=${left})`)
  assert.equal(r.status, 124, `expected the limiter's 124, got ${r.status}\n${r.out}`)
  assert.match(r.out, /\[joblimit\] RUN LIMIT/, r.out)
  assert.doesNotMatch(r.out, /slept/, `the sleeper finished, so nothing was terminated:\n${r.out}`)
  // an orphan holding the inherited stdio would make the launcher block for
  // the orphan's whole life: its own failure mode, pinned by the clock
  assert.ok(r.elapsedMs < 15_000, `terminated far too late: ${r.elapsedMs} ms`)
})
