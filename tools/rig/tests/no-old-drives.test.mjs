// The drive move of 2026-11-13: the repositories, worktrees and build output left E:, D: and C: for
// S:\orgtree\{orgtree,work,build,artifacts}, and nothing of ours may read or write the old places any more.
//   1. the rig's defaults never look at D: or E: (rig home, cargo target, PostgreSQL and renderer discovery)
//   2. no tool, test or capture script names an old root, in any way of writing a path
//      node --test tools/rig/tests/no-old-drives.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import * as lib from '../lib.mjs'

// BUILD_ROOT is new with the S: layout: read through the namespace so that an older lib fails tests by name
const { REPO, WORK_ROOT, RIG_HOMES, rigHome, cargoTarget, uiDir } = lib
const BUILD_ROOT = lib.BUILD_ROOT ?? 'S:\orgtree\build'

const OLD_DRIVE = /^[de]:/i

test('the rig layout is the S: one', () => {
  assert.equal(WORK_ROOT, 'S:\\orgtree\\work')
  assert.equal(BUILD_ROOT, 'S:\\orgtree\\build')
  assert.equal(RIG_HOMES, 'S:\\orgtree\\work\\rig')
})

test('with default settings the rig probes nothing on D: or E:', { skip: process.platform !== 'win32' }, ctx => {
  const keys = ['ORGTREE_RIG_HOME', 'ORGTREE_RIG_UI', 'ORGTREE_RIG_PG_SOURCE', 'CARGO_TARGET_DIR']
  const saved = Object.fromEntries(keys.map(k => [k, process.env[k]]))
  const seen = []
  // every answer is "not there", so each lookup walks its whole list of candidates
  for (const name of ['existsSync', 'statSync', 'readdirSync', 'readFileSync', 'accessSync', 'mkdirSync']) {
    ctx.mock.method(fs, name, (...args) => {
      seen.push(path.resolve(String(args[0])))
      if (name === 'existsSync') return false
      throw Object.assign(new Error('synthetic: not there'), { code: 'ENOENT' })
    })
  }
  try {
    for (const k of keys) delete process.env[k]
    const home = rigHome()
    assert.equal(OLD_DRIVE.test(home), false, home)
    assert.throws(() => uiDir('auto'), /no renderer bundle found/)
    process.env.CARGO_TARGET_DIR = path.join(BUILD_ROOT, 'synthetic-agent', 'cargo-target')
    assert.equal(cargoTarget(), path.join(BUILD_ROOT, 'synthetic-agent', 'cargo-target'))
  } finally {
    for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k] }
  }
  assert.ok(seen.some(p => p.toLowerCase() === WORK_ROOT.toLowerCase()), 'control: the default rig home was looked for on S:')
  assert.ok(seen.length >= 3, `control: the lookups ran (${seen.length})`)
  assert.deepEqual(seen.filter(p => OLD_DRIVE.test(p)), [])
})

// An old root, however a file writes its separators: / \ \\ \/ [\\/] and the MSYS /d/ form.
const SEP = String.raw`(?:\[\\\\\\\\/\]|\[\\\\/\]|\\\\\\\\|\\/|\\\\|\\|/)`
const OLD_ROOT = new RegExp([
  String.raw`\b[eE]:${SEP}Libraries${SEP}Desktop${SEP}orgtree\b`,
  String.raw`\b[dD]:${SEP}orgtree-work\b`,
  String.raw`\b[cC]:${SEP}orgtree-(?:build|artifacts)\b`,
  String.raw`(?<![\w.])/e/Libraries/(?:Desktop/orgtree|Downloads)\b`,
  String.raw`(?<![\w.])/d/orgtree-work\b`,
  String.raw`(?<![\w.])/c/orgtree-(?:build|artifacts)\b`,
].join('|'))

// Files that keep an old path as DATA, never as a place to go: each with why.
const KEPT = new Map([
  ['tools/rig/tests/no-old-drives.test.mjs', 'this test'],
  ['tools/rig/tests/build-permit.test.mjs', 'the cargo targets the rig must refuse'],
  ['engine/rs/orgtree-engine/migrations/0086_app_private_sites.sql', 'a checksummed migration (a comment)'],
  ['engine/rs/orgtree-engine/src/runtime/convo.rs', 'synthetic tool-input paths in tests'],
  ['engine/rs/orgtree-engine/src/runtime/convo_work_ref_tests.rs', 'synthetic tool-input paths'],
  ['tests/test_sensitive_path_gate.py', '3.x sample commands'],
  ['tests/test_state_human_mail_boundary.py', 'a 3.x sample mail body'],
  ['tools/rig/desktop/tool-rows.scenario.json', 'a fake CLI scenario: commands that are shown, never run'],
  ['apps/desktop/renderer/tests/images.test.tsx', 'a sample Markdown path'],
  ['apps/desktop/renderer/tests/mail-filter-bar-probe.tsx', 'a sample mail body'],
  ['apps/desktop/renderer/src/projecticonpaths.ts', 'where the icons were generated (dated)'],
  ['apps/desktop/renderer/tests/canvasbg.test.tsx', 'where a measurement was taken (dated)'],
])

test('the scanner knows every way a path is written', () => {
  for (const hit of ['E:/Libraries/Desktop/orgtree/node_modules', 'E:\\Libraries\\Desktop\\orgtree', "'D:\\\\orgtree-work'",
    '/^C:\\/orgtree-build\\//i', '/^C:[\\\\/]orgtree-build[\\\\/]/i', 'c:\\orgtree-build\\', 'C:/orgtree-artifacts/x.exe',
    'cd /d/orgtree-work/tmp', 'REPO=/e/Libraries/Desktop/orgtree', 'd:/orgtree-work/rig']) {
    assert.equal(OLD_ROOT.test(hit), true, hit)
  }
  for (const miss of ['S:/orgtree/work/rig', 'S:\\orgtree\\build\\me', '/s/orgtree/orgtree', 'E:/work/legacy32', 'C:\\Program Files\\Orgtree',
    'docs/orgtree-work-notes.md', 'https://example.invalid/d/orgtree-work']) {
    assert.equal(OLD_ROOT.test(miss), false, miss)
  }
})

test('no tool, test or capture script names an old root', () => {
  const ls = spawnSync('git', ['ls-files', '-z', '--', 'tools', 'tests', 'apps', 'engine/rs', 'packages', 'build', 'standalone', 'package.json'],
    { cwd: REPO, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 })
  assert.equal(ls.status, 0, ls.stderr)
  const files = ls.stdout.split('\0').filter(f => /\.(mjs|cjs|js|ts|tsx|json|py|ps1|sh|rs|sql|md|toml|nsh|yml|yaml|html|css)$/i.test(f))
  assert.ok(files.length > 1000, `control: the listing is the repository (${files.length} files)`)
  const found = []
  for (const f of files) {
    if (KEPT.has(f)) continue
    let text
    try { text = fs.readFileSync(path.join(REPO, f), 'utf8') } catch { continue }
    const lines = text.split(/\r?\n/)
    for (let i = 0; i < lines.length; i++) if (OLD_ROOT.test(lines[i])) found.push(`${f}:${i + 1}`)
  }
  assert.deepEqual(found, [])
  // the kept files are real and still hold what they are kept for, or the list has gone stale
  for (const [f] of KEPT) {
    const text = fs.readFileSync(path.join(REPO, f), 'utf8')
    assert.equal(OLD_ROOT.test(text) || /[eE]:[\\/]+Libraries|\/e\/Libraries/.test(text), true, `${f} no longer names an old path: drop it from KEPT`)
  }
})
