// Repository integrity for the orgtree-mailhub integration (ported from
// tests/test_mailhub_repo.py, 4.6.1).
//
// The synchronization design's enforcement half: orgtree-mailhub is the SOLE
// authoritative copy of shared hub logic, consumed as a submodule pinned to an
// exact commit. These checks fail when that stops being true: a second tracked
// copy creeping back in, an absent/uninitialized submodule, a dirty or drifted
// checkout. Run by hand, as the Python script was (an uninitialized submodule
// is a failure here, so it is not part of npm test, where worktrees commonly
// leave the submodule uninitialized):
//
//     node tools/check-mailhub-repo.mjs
//
// The Python script also ran the pinned submodule's own hubtool suites
// (tests/test_hubtool*.py). Those belong to the orgtree-mailhub repository,
// which still ships hubtool.py and its Python tests; Orgtree itself no longer
// carries a Python runtime to run them with.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const SUB = path.join(ROOT, 'engine', 'mailhub')
const failures = []
let passed = 0

function check(label, fn) {
  try {
    fn()
  } catch (error) {
    failures.push([label, error])
    console.log(`  FAIL     ${label}`)
    return
  }
  passed += 1
  console.log(`  ok ${String(passed).padStart(3)}  ${label}`)
}

function git(args, cwd = ROOT) {
  const run = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true, timeout: 60000, maxBuffer: 64 * 1024 * 1024 })
  return run.stdout ?? ''
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function submodulePresent() {
  // mail hub v2: the Rust hub (hub/), its client and its contract
  for (const probe of ['hub/src/main.rs', 'Cargo.toml', 'hubtool.py', 'Dockerfile', 'docs/PROVENANCE.md', 'docs/v2.md', 'tests/test_hubtool.py']) {
    const file = path.join(SUB, probe)
    assert(fs.existsSync(file) && fs.statSync(file).isFile(),
      `engine/mailhub/${probe} is missing — the submodule is absent or uninitialized. Run: git submodule update --init`)
  }
}

function submoduleCleanAndPinned() {
  const line = git(['submodule', 'status']).split(/\r?\n/).find(row => row.trim().endsWith('engine/mailhub') || (row + ' ').includes(' engine/mailhub ')) ?? ''
  assert(line, 'engine/mailhub is not a registered submodule')
  const marker = line[0]
  assert(marker === ' ', {
    '-': 'the submodule is NOT INITIALIZED (git submodule update --init)',
    '+': 'the submodule checkout DIFFERS from the pinned commit — adopting a new upstream revision is its own reviewed commit',
    U: 'the submodule has merge conflicts',
  }[marker] ?? `unexpected submodule state ${JSON.stringify(line)}`)
  const inner = git(['status', '--porcelain'], SUB)
  assert(inner.trim() === '',
    'the submodule checkout is DIRTY — shared hub changes land in orgtree-mailhub first, never as local edits under the pin:\n' + inner)
}

function noSecondTrackedCopy() {
  // This checker holds the fingerprint strings itself, so it is skipped.
  const self = 'tools/check-mailhub-repo.mjs'
  const listed = git(['ls-files']).split(/\r?\n/).filter(Boolean)
  assert(listed.length, 'git ls-files returned nothing — run inside the repo')
  // The hub SERVER's unmistakable fingerprints: its schema and its route
  // table next to a web framework. A CLIENT that speaks the protocol is fine.
  const offenders = []
  for (const relative of listed) {
    if (relative.startsWith('engine/mailhub') || relative === self) continue
    if (!/\.(py|mjs|cjs|js|ts|rs)$/.test(relative)) continue
    let source
    try { source = fs.readFileSync(path.join(ROOT, relative), 'utf8') } catch { continue }
    if (source.includes('CREATE TABLE IF NOT EXISTS orgs')
      || (source.replaceAll("'", '"').includes('"/api/register"') && /FastAPI|axum::Router/.test(source))) offenders.push(relative)
  }
  assert(!offenders.length,
    `a second tracked copy of hub-server logic exists outside the submodule: ${offenders.join(', ')} — orgtree-mailhub is the sole authoritative source`)
  for (const gone of ['engine/hub', 'engine/hub_runtime.py']) {
    assert(!listed.some(p => p === gone || p.startsWith(gone + '/')), `${gone} is tracked again — the superseded V2 hub must stay removed`)
  }
}

console.log('orgtree-mailhub repository integrity')
check('submodule present and initialized', submodulePresent)
check('submodule clean and exactly at the pinned commit', submoduleCleanAndPinned)
check('no second tracked copy of hub-server logic; V2 hub stays removed', noSecondTrackedCopy)
console.log()
if (failures.length) {
  for (const [label, error] of failures) console.log(`\n✗ ${label}\n${error.message}`)
  console.log(`mailhub-repo: ${passed} passed · ${failures.length} FAILED`)
  process.exit(1)
}
console.log(`mailhub-repo: all ${passed} checks passed`)
