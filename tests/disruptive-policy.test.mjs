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
    const hit = PROBE_PATHS.find(p => globToRegExp(spec).test(p))
    if (hit) return 'the path ' + spec + ' matches ' + hit
  }
  return ''
}

/** Paths a probe could occupy. `testScriptReachesDisruptive` asks whether a glob
 *  MATCHES one of these rather than how the glob is SPELLED.
 *
 *  The spelling check this replaces passed a single-level wildcard directory —
 *  "tests", slash, star, slash, star dot test dot mjs — which reaches the folder
 *  through a wildcard that is neither a double star nor the literal word
 *  "disruptive". Expanding the glob against the DISK would not have caught it
 *  either, because the folder holds no probes yet and an empty folder matches
 *  nothing — so the question has to be asked about a path that may exist, not
 *  only about paths that do. The nested entry covers a probe in a subfolder. */
const PROBE_PATHS = ['tests/disruptive/probe.test.mjs', 'tests/disruptive/sub/probe.test.mjs']

/** The subset of glob syntax these scripts use. `*` stops at a separator, `**`
 *  crosses them, `?` takes one character; everything else is literal. */
function globToRegExp(spec) {
  const s = spec.replace(/\\/g, '/')
  let out = '^'
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (c === '*' && s[i + 1] === '*') { out += '.*'; i++; if (s[i + 1] === '/') i++ }
    else if (c === '*') out += '[^/]*'
    else if (c === '?') out += '[^/]'
    else out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(out + '$')
}

/** Every script node's own discovery could pick up inside the folder, at any
 *  depth. Node's no-argument mode is broader than `*.test.mjs` on both counts —
 *  it recurses, and it also matches `*-test.mjs` and `test-*.mjs` — so a check
 *  modelled on the narrower set is blind to files that invocation really runs. */
function disruptiveFolderScripts(dir) {
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...disruptiveFolderScripts(full))
    else if (/\.(mjs|cjs|js)$/.test(entry.name) && entry.name !== 'gate.mjs') out.push(full)
  }
  return out
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
  // The two shapes a spelling-based check let through, measured by a reviewer.
  assert.notEqual(testScriptReachesDisruptive('node --test tests/*/*.test.mjs'), '', 'a single-level wildcard directory must be caught')
  assert.notEqual(testScriptReachesDisruptive('node --test tests/disruptive*/*.test.mjs'), '', 'a wildcard suffix on the folder name must be caught')

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
  const ungated = disruptiveFolderScripts(dir)
    .filter(f => !/requireDisruptiveOptIn|disruptiveProbesEnabled/.test(fs.readFileSync(f, 'utf8')))
    .map(f => path.relative(dir, f).replace(/\\/g, '/'))
  assert.deepEqual(ungated, [], 'these scripts never ask the gate, so barrier two does not exist for them: ' + ungated.join(', '))
})

test('§4 the gate opens only on an explicit opt-in', () => {
  assert.equal(disruptiveProbesEnabled({}), false, 'absent env must not enable')
  assert.equal(disruptiveProbesEnabled({ [DISRUPTIVE_ENV]: '0' }), false)
  assert.equal(disruptiveProbesEnabled({ [DISRUPTIVE_ENV]: 'true' }), false, 'only the exact value 1 opts in')
  assert.equal(disruptiveProbesEnabled({ [DISRUPTIVE_ENV]: '1' }), true)
  assert.equal(requireDisruptiveOptIn('sample', {}), false)
  assert.equal(requireDisruptiveOptIn('sample', { [DISRUPTIVE_ENV]: '1' }), true)
})
