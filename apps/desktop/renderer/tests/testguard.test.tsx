/** testguard.mjs's controls: a guard that has never been seen to fire is not a
 *  guard, and one that changes what passes is worse than none.
 *
 * §1 the incident's own assertion (`assert.equal(el, null, msg)` on a
 *    React-rendered element) fails in milliseconds with a bounded report that
 *    still names the caller's message, the element and the caller's line
 * §2 a SMALL failure gets Node's own message, byte for byte
 * §3 every comparison method passes and fails exactly where Node's does
 * §4 every way a test reaches assert is guarded (strict aliases, the loose
 *    module, a named import, an Assert instance)
 * §5 under a 512 MB Job ceiling, Node's own diff of two 6000-line values dies
 *    on its allocation, and the guarded run of the same values survives it
 *    (Windows: the Job launcher is tests/joblimit.ps1)
 * §6 outside run.mjs's Job, the watchdog ends a synchronous runaway at its
 *    memory limit; with the watchdog off the same allocator finishes
 * §7 outside the Job, the watchdog ends a DETACHED orphan once its parent is
 *    gone; with the watchdog off the orphan stays
 * §8 run.mjs's heap cap and guard preload reach this test process itself
 * §9 run.mjs refuses to start below its free-memory floor or on a malformed
 *    floor, and gets past a satisfied floor
 */
import { mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import loose, { strictEqual as namedStrictEqual } from 'node:assert'
import { spawnSync } from 'node:child_process'
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import v8 from 'node:v8'
import { estimateLines, originalOf } from './testguard.mjs'

declare const __SRC_DIR__: string
const TESTS = path.join(__SRC_DIR__, '..', 'tests')
const GUARD = path.join(TESTS, 'testguard.mjs')
const DIFF_PROBE = path.join(TESTS, 'testguard', 'diff.probe.mjs')
const WATCH_PROBE = path.join(TESTS, 'testguard', 'watch.probe.mjs')
const LAUNCHER = path.join(TESTS, 'joblimit.ps1')
const PS = path.join(process.env.SystemRoot ?? 'C:\\Windows',
  'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
const WIN = process.platform === 'win32'

const firstFrame = (err: unknown) =>
  String((err as Error).stack).split('\n').find((line) => line.trimStart().startsWith('at ')) ?? ''

function Menu() {
  return (
    <div className="custom-apps-menu">
      <button className="custom-apps-new" title="New panel">+ New panel</button>
      <button className="custom-apps-open" title="Open Panel 2">Panel 2</button>
    </div>
  )
}

test('§1 the incident\'s assertion on a rendered element fails in milliseconds with a bounded report', async (t) => {
  const view = await mountView(<Menu />, (el) => el)
  t.after(() => view.unmount())
  const row = view.el.querySelector('.custom-apps-new')
  assert.equal(row === null, false, 'the fixture must render the row')
  // anti-vacuity: Node's own report of this element must really be past the
  // budget, or this case would pass through Node's path and prove nothing
  assert.equal(estimateLines(row), Infinity, 'a React-rendered element should print past the line budget')

  const started = performance.now()
  let caught: unknown
  try {
    assert.equal(row, null, 'the separate "+ New panel" row is gone')
  } catch (err) {
    caught = err
  }
  const ms = performance.now() - started
  assert.equal(caught instanceof assert.AssertionError, true, `expected an AssertionError, got ${String(caught)}`)
  const err = caught as InstanceType<typeof assert.AssertionError>
  assert.equal(ms < 1000, true, `the bounded report took ${ms.toFixed(0)} ms`)
  assert.equal(err.code, 'ERR_ASSERTION')
  assert.equal(err.operator, 'strictEqual')
  assert.match(err.message, /^the separate "\+ New panel" row is gone\n/)
  assert.match(err.message, /report bounded by tests\/testguard\.mjs/)
  assert.match(err.message, /\+ actual {3}<button class="custom-apps-new" title="New panel">/)
  assert.match(err.message, /- expected null/)
  // reporters get a preview string, never the node and its graph
  assert.equal(typeof err.actual, 'string')
  assert.equal(err.expected, null)
  // the stack starts at the caller, not inside the guard
  assert.doesNotMatch(firstFrame(err), /\bstrictEqual\b/, firstFrame(err))
})

test('§2 a small failure gets Node\'s own message, byte for byte', () => {
  const messageOf = (fn: (...args: unknown[]) => void, ...args: unknown[]) => {
    try { fn(...args) } catch (err) { return (err as Error).message }
    return 'passed'
  }
  const cases: [string, unknown[]][] = [
    ['deepEqual', [['a', 'b'], ['a', 'c'], 'rows differ']],
    ['deepEqual', [{ open: true, label: 'Panel 2' }, { open: false, label: 'Panel 2' }]],
    ['equal', [1, 2]],
    ['equal', ['Open Panel 2', 'Create a panel for Notes', 'the title names the copy']],
    ['notEqual', ['same', 'same']],
  ]
  for (const [name, args] of cases) {
    const guarded = (assert as unknown as Record<string, (...a: unknown[]) => void>)[name]!
    const theirs = messageOf(originalOf(guarded), ...args)
    assert.notEqual(theirs, 'passed', `${name} control must fail`)
    assert.equal(messageOf(guarded, ...args), theirs, `${name}${JSON.stringify(args)}`)
  }
})

test('§3 every method passes and fails exactly where Node\'s does', () => {
  const shared = { a: [1, 2] }
  const values: [string, unknown, unknown][] = [
    ['same number', 1, 1], ['-0 and 0', -0, 0], ['NaN', NaN, NaN], ['1 and "1"', 1, '1'],
    ['null and undefined', null, undefined], ['same ref', shared, shared],
    ['equal objects', { a: [1, { b: 2 }] }, { a: [1, { b: 2 }] }], ['different objects', { a: 1 }, { a: 2 }],
    ['loose-equal objects', { a: 1 }, { a: '1' }], ['maps', new Map([[1, 2]]), new Map([[1, 2]])],
    ['subset', { a: 1, b: 2 }, { a: 1 }], ['dates', new Date(0), new Date(0)],
  ]
  const outcome = (fn: (a: unknown, b: unknown) => void, a: unknown, b: unknown) => {
    try { fn(a, b); return 'pass' } catch (err) { return (err as { code?: string }).code ?? (err as Error).name }
  }
  let compared = 0
  for (const [label, mod] of [['assert/strict', assert], ['assert', loose]] as const) {
    for (const name of ['equal', 'notEqual', 'strictEqual', 'notStrictEqual', 'deepEqual', 'notDeepEqual',
      'deepStrictEqual', 'notDeepStrictEqual', 'partialDeepStrictEqual']) {
      const guarded = (mod as unknown as Record<string, ((a: unknown, b: unknown) => void) | undefined>)[name]
      if (!guarded) continue
      for (const [what, a, b] of values) {
        assert.equal(outcome(guarded, a, b), outcome(originalOf(guarded), a, b), `${label}.${name}(${what})`)
        compared++
      }
    }
  }
  assert.equal(compared >= 2 * 8 * values.length, true, `only ${compared} comparisons ran`)
})

test('§4 every way a test reaches assert is guarded', () => {
  const wrapped = (fn: unknown) => originalOf(fn) !== fn
  assert.equal(wrapped(assert.strictEqual), true, 'assert/strict strictEqual')
  assert.equal(assert.equal === assert.strictEqual, true, 'strict equal stays an alias of strictEqual')
  assert.equal(assert.deepEqual === assert.deepStrictEqual, true, 'strict deepEqual stays an alias')
  assert.equal(wrapped(loose.equal) && wrapped(loose.deepEqual) && wrapped(loose.notStrictEqual), true, 'loose module')
  assert.equal(namedStrictEqual === loose.strictEqual, true, 'a named import follows the guarded export')
  const instance = new loose.Assert()
  assert.equal(wrapped(instance.strictEqual) && wrapped(instance.deepStrictEqual), true, 'an Assert instance')
})

/** One probe under tests/joblimit.ps1, output to a file (see containment.test.ts
 *  for why a file and not a pipe). */
function underJob(limitMb: number, probeArgs: string[], env: NodeJS.ProcessEnv) {
  const dir = mkdtempSync(path.join(tmpdir(), 'orgtree-testguard-'))
  const argFile = path.join(dir, 'args.txt')
  writeFileSync(argFile, [DIFF_PROBE, ...probeArgs].join('\n') + '\n')
  const outFile = path.join(dir, 'out.txt')
  const fd = openSync(outFile, 'w')
  const r = spawnSync(PS, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', LAUNCHER, '-LimitMB', String(limitMb), '-TimeoutSec', '60',
    '-WorkDir', TESTS, '-Exe', process.execPath, '-ArgFile', argFile],
  { stdio: ['ignore', fd, fd], env, timeout: 90_000, windowsHide: true })
  closeSync(fd)
  return { status: r.status, out: readFileSync(outFile, 'utf8') }
}

/** The environment of a test process launched OUTSIDE run.mjs: no Job marker,
 *  no preload, no free-memory floor (so only the case's own limit can fire). */
function uncontained(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, NODE_OPTIONS: '', ORGTREE_TEST_GUARD_FREE_MB: '0', ...extra }
  delete env.ORGTREE_TEST_CONTAINED_MB
  return env
}

const winOnly = WIN ? false : `joblimit.ps1 is a Windows Job Object launcher; not run on ${process.platform}`

test('§5 Node\'s own diff dies at a 512 MB ceiling that the guarded run survives', { skip: winOnly, timeout: 120_000 }, () => {
  assert.equal(existsSync(LAUNCHER) && existsSync(DIFF_PROBE) && existsSync(PS), true, 'launcher, probe and powershell exist')
  // red: Node as shipped. Two 6000-element arrays print as ~12,000 lines and
  // their diff needs ~1.15 GB of ArrayBuffer, so it must die on the ceiling
  // before it ever builds an AssertionError
  const red = underJob(512, ['unguarded', '6000'], { ...process.env, NODE_OPTIONS: '' })
  assert.match(red.out, /\[joblimit\] memory ceiling = 512 MB/, red.out)
  assert.doesNotMatch(red.out, /^AssertionError/m, `Node's own diff fit in 512 MB, so this control proves nothing:\n${red.out}`)
  assert.equal(red.status !== 0 || /Array buffer allocation failed/.test(red.out), true,
    `the unguarded diff should have died on its allocation:\n${red.out}`)
  // green: the same values and ceiling, guarded
  const green = underJob(512, ['guarded', '6000', GUARD], { ...process.env, NODE_OPTIONS: '' })
  assert.equal(green.status, 0, green.out)
  assert.match(green.out, /^AssertionError: .*report bounded by tests\/testguard\.mjs/m, green.out)
  const ms = Number(/settled in (\d+) ms/.exec(green.out)?.[1])
  assert.equal(ms < 1000, true, `guarded report took ${ms} ms:\n${green.out}`)
})

test('§6 outside the Job, the watchdog ends a synchronous runaway at its limit', { timeout: 60_000 }, () => {
  const run = (guardMb: string, mb: string) => spawnSync(process.execPath, [WATCH_PROBE, 'alloc', GUARD, mb],
    { env: uncontained({ ORGTREE_TEST_GUARD_MB: guardMb }), encoding: 'utf8', timeout: 45_000, windowsHide: true })
  const fired = run('200', '700')
  assert.notEqual(fired.status, 0, `the runaway was not stopped:\n${fired.stdout}\n${fired.stderr}`)
  assert.match(fired.stderr, /\[testguard\] resident memory \d+ MB passed ORGTREE_TEST_GUARD_MB=200/, fired.stderr)
  assert.doesNotMatch(fired.stdout, /held/, fired.stdout)
  // anti-vacuity: with the watchdog off, the allocator is healthy and finishes
  const control = run('0', '256')
  assert.equal(control.status, 0, `${control.stdout}\n${control.stderr}`)
  assert.match(control.stdout, /held 256 MB/, control.stdout)
})

const alive = (pid: number) => {
  try { process.kill(pid, 0); return true } catch (err) { return (err as { code?: string }).code !== 'ESRCH' }
}

async function orphanAfter(guardMb: string, waitMs: number) {
  const pidFile = path.join(mkdtempSync(path.join(tmpdir(), 'orgtree-testguard-')), 'orphan.pid')
  const parent = spawnSync(process.execPath, [WATCH_PROBE, 'orphan', GUARD, pidFile],
    { env: uncontained({ ORGTREE_TEST_GUARD_MB: guardMb }), timeout: 30_000, windowsHide: true })
  assert.equal(parent.status, 0, String(parent.stderr))
  const pid = Number(readFileSync(pidFile, 'utf8'))
  const deadline = Date.now() + waitMs
  while (Date.now() < deadline && alive(pid)) await new Promise((r) => setTimeout(r, 100))
  return pid
}

test('§7 outside the Job, the watchdog ends a detached orphan once its parent is gone', { timeout: 60_000 }, async () => {
  const pid = await orphanAfter('3072', 5000)
  assert.equal(alive(pid), false, `orphan ${pid} outlived its parent by 5 s`)
  // anti-vacuity: a detached child is NOT ended by node's kill-on-close job,
  // so without the watchdog it really does outlive its parent
  const kept = await orphanAfter('0', 1500)
  const survived = alive(kept)
  if (survived) process.kill(kept)
  assert.equal(survived, true, `orphan ${kept} died without the watchdog, so this case proves nothing`)
})

const nodeOptions = process.env.NODE_OPTIONS ?? ''
const viaRunner = nodeOptions.includes('testguard.mjs')

test('§8 run.mjs\'s heap cap and guard preload reach this test process', {
  skip: viaRunner ? false : 'not launched by run.mjs (no testguard preload in NODE_OPTIONS)',
}, () => {
  const cap = Number(/--max-old-space-size=(\d+)/.exec(nodeOptions)?.[1] ?? 0)
  assert.equal(cap > 0, true, `no heap cap in NODE_OPTIONS: ${nodeOptions}`)
  // the limit is the old-space cap plus the young generation (~200 MB)
  const limitMb = v8.getHeapStatistics().heap_size_limit / 2 ** 20
  assert.equal(limitMb >= cap && limitMb <= cap + 512, true, `heap limit ${limitMb.toFixed(0)} MB under a ${cap} MB cap`)
})

test('§9 run.mjs refuses to start below its free-memory floor', { timeout: 60_000 }, () => {
  const run = (floor: string) => spawnSync(process.execPath, [path.join(TESTS, 'run.mjs'), 'no-such-suite-for-the-floor'],
    { env: { ...process.env, ORGTREE_TEST_MIN_FREE_MB: floor }, encoding: 'utf8', timeout: 45_000, windowsHide: true })
  const refused = run('99999999')
  assert.equal(refused.status, 2, refused.stderr)
  assert.match(refused.stderr, /FREE MEMORY \d+ MB is below the 99999999 MB floor/, refused.stderr)
  const malformed = run('3gb')
  assert.equal(malformed.status, 2, malformed.stderr)
  assert.match(malformed.stderr, /ORGTREE_TEST_MIN_FREE_MB="3gb" is not a whole number/, malformed.stderr)
  // anti-vacuity: a satisfied floor gets as far as the (empty) file filter
  const passed = run('1')
  assert.doesNotMatch(passed.stderr, /FREE MEMORY/, passed.stderr)
  assert.match(passed.stderr, /no test files match no-such-suite-for-the-floor/, passed.stderr)
})
