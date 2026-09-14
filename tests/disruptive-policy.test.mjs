// The boundary guard for disruptive probes.
//
// A full `npm test` must not be able to open a window on the machine it runs
// on. This test enforces that structurally rather than by convention: it scans
// every file the DEFAULT glob can reach and fails if one of them contains a
// primitive that can disturb the desktop.
//
// It is headless by construction — it reads files and matches strings. It
// spawns nothing, so it can never become the problem it exists to prevent.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DISRUPTIVE_ENV, disruptiveProbesEnabled, requireDisruptiveOptIn } from './disruptive/gate.mjs'

const testsDir = path.dirname(fileURLToPath(import.meta.url))

/** The primitives that can disturb a desktop, each with a sample that MUST make
 *  it fire. The sample is not documentation — §1 runs it, so a pattern that has
 *  been broken by an edit fails here rather than silently matching nothing.
 *  A detector nobody has watched fire is not a detector. */
const DISRUPTIVE = [
  { name: 'a spawn allowed to show a window',
    // `windowsHide: false` and `windowsHide: !someFlag` both permit a window.
    pattern: /windowsHide:\s*(false|!)/,
    fires: "spawn(exe, [], { windowsHide: false })",
    alsoFires: "spawn(exe, [], { windowsHide: !showWindows })" },
  { name: 'direct window manipulation',
    // user32 is how a probe finds, shows or closes somebody else's window.
    pattern: /\buser32\b/i,
    fires: "Add-Type -Name W -Namespace U -MemberDefinition '[DllImport(\"user32.dll\")]...'" },
  { name: 'compiling or running NSIS',
    pattern: /(spawn|spawnSync|execFile|execFileSync)[^\n]*makensis/i,
    fires: "spawnSync(path.join(dir, 'makensis.exe'), args)" },
  { name: 'launching the real Electron binary',
    pattern: /spawn\(\s*electron\b/,
    fires: "const child = spawn(electron, [script], opts)" },
]

/** Files the DEFAULT glob `tests/*.test.mjs` reaches. Not recursive — that
 *  non-recursion is half the safety property, so it is modelled exactly. */
function defaultGlobFiles() {
  return fs.readdirSync(testsDir, { withFileTypes: true })
    .filter(e => e.isFile() && e.name.endsWith('.test.mjs'))
    .map(e => path.join(testsDir, e.name))
}

test('§1 POSITIVE CONTROL: every pattern fires on the thing it is meant to catch', () => {
  for (const d of DISRUPTIVE) {
    assert.match(d.fires, d.pattern, `the "${d.name}" detector did not fire on its own sample`)
    if (d.alsoFires) assert.match(d.alsoFires, d.pattern, `the "${d.name}" detector missed a second form`)
  }
})

test('§1b NEGATIVE CONTROL: ordinary test code does not trip the detectors', () => {
  const innocuous = "const r = await execFile(node, [script], { windowsHide: true })\nassert.equal(r.code, 0)\n"
  for (const d of DISRUPTIVE) assert.doesNotMatch(innocuous, d.pattern, `"${d.name}" false-positives on ordinary code`)
})

test('§2 no file reachable from the default glob contains a disruptive primitive', () => {
  // This file is the one exemption, and it is exempt by RESOLVED PATH rather
  // than by name, so the exemption cannot be borrowed by another file that
  // happens to be called something similar. It holds the patterns as sample
  // strings — §1 proves they are samples that fire, not calls that spawn.
  const selfPath = fileURLToPath(import.meta.url)
  const offenders = []
  for (const file of defaultGlobFiles()) {
    if (path.resolve(file) === path.resolve(selfPath)) continue
    const text = fs.readFileSync(file, 'utf8')
    for (const d of DISRUPTIVE) {
      if (d.pattern.test(text)) offenders.push(`${path.basename(file)}: ${d.name}`)
    }
  }
  assert.deepEqual(offenders, [],
    `these files can disturb the desktop from an ordinary \`npm test\`. Move them to tests/disruptive/ and gate them on ${DISRUPTIVE_ENV}:\n  ` + offenders.join('\n  '))
})

test('§3 the default glob cannot reach tests/disruptive/', () => {
  const inside = defaultGlobFiles().filter(f => path.dirname(f).endsWith('disruptive'))
  assert.deepEqual(inside, [], 'the default glob became recursive; the folder barrier is gone')
})

test('§4 the gate opens only on an explicit opt-in', () => {
  assert.equal(disruptiveProbesEnabled({}), false, 'absent env must not enable')
  assert.equal(disruptiveProbesEnabled({ [DISRUPTIVE_ENV]: '0' }), false)
  assert.equal(disruptiveProbesEnabled({ [DISRUPTIVE_ENV]: 'true' }), false, 'only the exact value 1 opts in')
  assert.equal(disruptiveProbesEnabled({ [DISRUPTIVE_ENV]: '1' }), true)
  assert.equal(requireDisruptiveOptIn('sample', {}), false)
  assert.equal(requireDisruptiveOptIn('sample', { [DISRUPTIVE_ENV]: '1' }), true)
})
