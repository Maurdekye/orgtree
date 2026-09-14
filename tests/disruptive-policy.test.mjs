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
  { name: 'requesting elevation',
    // A UAC prompt is a modal on somebody else's screen that they cannot ignore.
    pattern: /(-Verb\s+RunAs|\brunas\b)/i,
    fires: "spawn('powershell', ['-Command', 'Start-Process -Verb RunAs setup.exe'])" },
  { name: 'executing a compiled installer',
    pattern: /(spawn|spawnSync|execFile|execFileSync)[^\n]*(Setup\.exe|msiexec|\.msi\b)/i,
    fires: "execFile(path.join(dir, 'OrgtreeSetup.exe'), ['/S'])",
    alsoFires: "spawn('msiexec', ['/i', msi])" },
]

/** Does the package's own `test` script stay out of tests/disruptive/?
 *
 *  THIS IS WHAT THE FOLDER BARRIER ACTUALLY DEPENDS ON, and the first version of
 *  this guard did not check it: §3 asserted that the guard's OWN model of the
 *  glob was non-recursive, which is a statement about the test rather than about
 *  the repository. An independent review widened the real script to a recursive
 *  glob and every section stayed green while `npm test` walked into the folder.
 *  A control that cannot fail is not a control.
 *
 *  Returns a reason when the script can reach the folder, '' when it cannot. */
export function testScriptReachesDisruptive(script) {
  if (typeof script !== 'string' || !script.includes('--test')) return 'the test script does not run node --test'
  const args = script.split(/\s+/).filter(a => a && !a.startsWith('-') && a !== 'node' && a !== 'npm')
  const paths = args.filter(a => a.includes('/') || a.includes('*') || a.endsWith('.mjs'))
  if (paths.length === 0) return 'bare `node --test` searches recursively from the working directory'
  for (const spec of paths) {
    if (spec.includes('**')) return 'the path ' + spec + ' is recursive'
    if (/(^|\/)disruptive(\/|$)/.test(spec)) return 'the path ' + spec + ' names the disruptive folder'
  }
  return ''
}

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

test('§3 THE REAL `test` SCRIPT cannot reach tests/disruptive/', () => {
  // Samples first, so this section is shown able to fail. The middle two are the
  // exact mutations an independent review used to prove the previous §3 was not
  // a control at all: both left it green.
  assert.equal(testScriptReachesDisruptive('node --test tests/*.test.mjs'), '', 'the shipped shape must pass')
  assert.notEqual(testScriptReachesDisruptive('node --test tests/**/*.test.mjs'), '', 'a recursive glob must be caught')
  assert.notEqual(testScriptReachesDisruptive('node --test'), '', 'bare `node --test` recurses and must be caught')
  assert.notEqual(testScriptReachesDisruptive('node --test tests/disruptive/*.test.mjs'), '', 'naming the folder must be caught')

  const pkg = JSON.parse(fs.readFileSync(path.join(path.dirname(testsDir), 'package.json'), 'utf8'))
  const reason = testScriptReachesDisruptive(pkg.scripts && pkg.scripts.test)
  assert.equal(reason, '', 'package.json test script can reach the disruptive folder: ' + reason)

  const inside = defaultGlobFiles().filter(f => path.dirname(f).endsWith('disruptive'))
  assert.deepEqual(inside, [], 'the default glob model became recursive')
})

test('§5 every probe in tests/disruptive/ actually asks the gate', () => {
  // Barrier two was convention until this existed: requireDisruptiveOptIn returns
  // a boolean and nothing obliged a probe to call it. Now the obligation is
  // enforced rather than remembered.
  const dir = path.join(testsDir, 'disruptive')
  const probes = fs.readdirSync(dir).filter(n => n.endsWith('.test.mjs'))
  const ungated = probes.filter(n => !/requireDisruptiveOptIn|disruptiveProbesEnabled/.test(fs.readFileSync(path.join(dir, n), 'utf8')))
  assert.deepEqual(ungated, [], 'these probes never ask the gate, so barrier two does not exist for them: ' + ungated.join(', '))
})

test('§4 the gate opens only on an explicit opt-in', () => {
  assert.equal(disruptiveProbesEnabled({}), false, 'absent env must not enable')
  assert.equal(disruptiveProbesEnabled({ [DISRUPTIVE_ENV]: '0' }), false)
  assert.equal(disruptiveProbesEnabled({ [DISRUPTIVE_ENV]: 'true' }), false, 'only the exact value 1 opts in')
  assert.equal(disruptiveProbesEnabled({ [DISRUPTIVE_ENV]: '1' }), true)
  assert.equal(requireDisruptiveOptIn('sample', {}), false)
  assert.equal(requireDisruptiveOptIn('sample', { [DISRUPTIVE_ENV]: '1' }), true)
})
