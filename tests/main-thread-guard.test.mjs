// main-thread-guard.test.mjs — NOTHING ON THE DESKTOP MAIN THREAD LAUNCHES A PROGRAM OR WAITS ON THE DISK FROM A TIMER.
//
// @item:orgtree/nick-pc-4-6-0-desktop-main-process-stalls-input-f. USER 2026-11-16 16:30:53Z m8fe70e62fc2c "Full scope +
// guard": on Nick-PC the main thread stalled 0.5-30 s with stacks in child_process spawn/execFile from timers (the
// 2 s core-control status, the 5 s streamer tasklist) and in detectHarnesses' statSync scan on every tray rebuild. Even
// an ASYNC execFile blocks the main thread for the whole CreateProcess call (antivirus image scanning included), so
// every bounded program run goes through the probe host (a utilityProcess, main/probe-host.ts + probe-host-child.ts).
//
// The rules, by static scan of apps/desktop/main/*.ts:
//  (a) only probe-host-child.ts imports node:child_process, except the four lifecycle launches that own a live child
//      (@coordinator-opus mc30c3aeead90 2026-11-16 20:02Z, choice A): each may import `spawn` only, never execFile/exec;
//  (b) no execFileSync / spawnSync / execSync anywhere;
//  (c) the modules timers reach do no synchronous fs work, except the listed lines (each with its reason).
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const MAIN = 'apps/desktop/main'
const files = fs.readdirSync(MAIN).filter(f => f.endsWith('.ts') && !f.endsWith('.d.ts')).sort()
const read = f => fs.readFileSync(path.join(MAIN, f), 'utf8')
/** comments out, strings kept: a rule quoted in a comment is not a call */
const code = f => read(f).replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' ')).replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1')

/** The launches that stay on main (choice A, approved by @coordinator-opus 2026-11-16 20:02Z): none runs from a timer. */
const SPAWN_ON_MAIN = {
  'engine.ts': 'the engine `serve` child: piped stdio and a lifetime tied to the desktop',
  'providerlogin.ts': 'the interactive provider login: streams its stdio to the sign-in UI',
  'index.ts': 'the relaunch right before exit, and the updater installer handoff before quit',
}

test('only the probe host imports child_process; the lifecycle launches import spawn alone', () => {
  const offenders = []
  for (const f of files) {
    const src = code(f)
    const uses = [...src.matchAll(/(?:from\s*|require\(\s*|import\(\s*)['"](?:node:)?child_process['"]/g)]
    if (!uses.length || f === 'probe-host-child.ts') continue
    if (!SPAWN_ON_MAIN[f]) { offenders.push(`${f}: imports child_process`); continue }
    if (/(?:require|import)\(\s*['"](?:node:)?child_process/.test(src)) { offenders.push(`${f}: loads child_process dynamically`); continue }
    for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"](?:node:)?child_process['"]/g)) {
      const names = m[1].split(',').map(s => s.trim()).filter(Boolean).filter(s => !s.startsWith('type '))
        .map(s => s.split(/\s+as\s+/)[0].trim())
      for (const n of names) if (n !== 'spawn') offenders.push(`${f}: imports ${n} from child_process`)
    }
    if (/import\s+(?:\*\s+as\s+\w+|\w+)\s*(?:,\s*\{[^}]*\})?\s*from\s*['"](?:node:)?child_process/.test(src)) offenders.push(`${f}: imports the whole child_process module`)
  }
  assert.deepEqual(offenders, [])
  assert.ok(files.includes('probe-host.ts') && files.includes('probe-host-child.ts'), 'the probe host exists')
})

test('no synchronous program launch anywhere in the desktop main', () => {
  const offenders = files.flatMap(f => [...code(f).matchAll(/\b(execFileSync|spawnSync|execSync)\b/g)].map(m => `${f}: ${m[1]}`))
  assert.deepEqual(offenders, [])
})

/** Timer-reached modules (the 2 s core-control tick, the 5 s streamer sample and tray poll, every stall record and window
 *  event, every preference change, the credential refresh tick) and the only synchronous fs lines each may keep. */
const TIMER_MODULES = {
  'core-lifecycle.ts': [],
  'streamer-auto.ts': [],
  'harnesses.ts': [],
  'credential-bridge.ts': [],
  'stall-log.ts': [],
  'stall-probe.ts': [],
  'window-events.ts': [],
  'probe-host.ts': [],
  'preferences.ts': [
    // read once at startup, before any window exists
    "const raw: unknown = JSON.parse(fs.readFileSync(file, 'utf8'))",
    // flushSync: the one synchronous write, at before-quit, so a quit loses no preference (coordinator OK 20:02Z)
    'fs.mkdirSync(path.dirname(this.file), { recursive: true })',
    'fs.writeFileSync(temp, JSON.stringify(next), { mode: 0o600 })',
    'fs.renameSync(temp, this.file)',
  ],
}
for (const f of files) if (/^(tray|taskbar)/.test(f)) TIMER_MODULES[f] ??= []

test('timer-reached modules do no synchronous fs work outside the listed lines', () => {
  const offenders = []
  for (const [f, allowed] of Object.entries(TIMER_MODULES)) {
    assert.ok(files.includes(f), `${f} exists`)
    for (const line of code(f).split('\n')) {
      if (!/\bfs\.\w+Sync\(|\b(?:readFileSync|writeFileSync|appendFileSync|statSync|existsSync|readdirSync|renameSync|mkdirSync|rmSync|unlinkSync|openSync|writeSync|fsyncSync|lstatSync|accessSync|copyFileSync)\(/.test(line)) continue
      if (!allowed.includes(line.trim())) offenders.push(`${f}: ${line.trim()}`)
    }
  }
  assert.deepEqual(offenders, [])
})
