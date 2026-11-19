// .github/ci/linux/glibc-floor.mjs must tell "this file has no dynamic symbols" (a static
// program: no floor, fine) from "the symbols could not be read" (objdump missing, an I/O
// error, a format it does not know: no verdict, so the check fails). At 14b809c both were
// one silent catch, and a reader that failed for every file gave a green report with no
// floor (integrator's finding, 2026-11-19).
//
// The script runs as written, on a folder of synthetic ELF headers that are never
// executed. Only `objdump` is replaced, by a preload that answers from a table, so the
// test needs no binutils and runs on any platform.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const script = fileURLToPath(new URL('../.github/ci/linux/glibc-floor.mjs', import.meta.url))

// What the stand-in objdump does for a file, by the file's name.
const READER = `
import childProcess from 'node:child_process'
import path from 'node:path'
import { syncBuiltinESMExports } from 'node:module'
const table = body => 'x:     file format elf64-littleaarch64\\n\\nDYNAMIC SYMBOL TABLE:\\n' + body + '\\n'
const exits = (status, stderr, stdout = '') => { throw Object.assign(new Error('Command failed: objdump'), { status, signal: null, stderr, stdout }) }
const answers = {
  'needs-2.34': () => table('0000000000000000      DF *UND*\\t0000000000000000 (GLIBC_2.34) pthread_create\\n0000000000000000      DF *UND*\\t0000000000000000 (GLIBC_2.17) memcpy'),
  'needs-2.36': () => table('0000000000000000      DF *UND*\\t0000000000000000 (GLIBC_2.36) arc4random'),
  'no-glibc': () => table('0000000000000000      DF *UND*\\t0000000000000000  Base        some_symbol'),
  'static-exit-0': () => table('no symbols'),
  'static-exit-1': () => exits(1, 'objdump: static-exit-1: not a dynamic object\\n', table('no symbols')),
  'io-error': () => { throw Object.assign(new Error('read EIO'), { code: 'EIO' }) },
  'no-objdump': () => { throw Object.assign(new Error('spawnSync objdump ENOENT'), { code: 'ENOENT' }) },
  'unknown-format': () => exits(1, 'objdump: unknown-format: file format not recognized\\n'),
  'killed': () => { throw Object.assign(new Error('Command failed: objdump'), { status: null, signal: 'SIGKILL', stderr: '', stdout: '' }) },
  'empty-output': () => '',
}
childProcess.execFileSync = (name, args) => {
  if (name !== 'objdump' || args[0] !== '-T') throw new Error('unexpected command ' + name)
  return answers[path.basename(args[1])]()
}
syncBuiltinESMExports()
`

function check(names, { arch = 'arm64', max = '2.35' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glibc-floor-'))
  try {
    const app = path.join(dir, 'app')
    fs.mkdirSync(app)
    const header = Buffer.alloc(64)
    header.writeUInt32BE(0x7f454c46, 0)
    header.set([2, 1, 1], 4)          // ELF64, little endian
    header.writeUInt16LE(3, 16)       // a shared object
    header.writeUInt16LE(183, 18)     // aarch64
    for (const name of names) fs.writeFileSync(path.join(app, name), header)
    fs.writeFileSync(path.join(app, 'notes.txt'), 'not an ELF file')
    const reader = path.join(dir, 'reader.mjs')
    fs.writeFileSync(reader, READER)
    const report = path.join(dir, 'report.json')
    const env = { ...process.env }
    delete env.NODE_OPTIONS; delete env.GITHUB_STEP_SUMMARY
    const run = spawnSync(process.execPath, ['--import', pathToFileURL(reader).href, script, app, arch, max, report], { env, encoding: 'utf8', timeout: 30_000 })
    assert.equal(run.error, undefined)
    const written = fs.existsSync(report) ? JSON.parse(fs.readFileSync(report, 'utf8')) : null
    return { status: run.status, output: run.stdout + run.stderr, report: written, row: name => written?.files.find(file => file.file === name) }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

test('symbols that were read: the floor is the newest glibc, and the limit holds', () => {
  const fine = check(['needs-2.34', 'no-glibc'])
  assert.equal(fine.status, 0, fine.output)
  assert.equal(fine.report.floor, '2.34')
  assert.deepEqual(fine.report.problems, [])
  assert.equal(fine.row('needs-2.34').glibc, '2.34')
  assert.equal(fine.row('no-glibc').glibc, null)
  assert.equal(fine.report.files.length, 2, 'the text file is not an ELF file')

  const over = check(['needs-2.34', 'needs-2.36'])
  assert.equal(over.status, 1)
  assert.equal(over.report.floor, '2.36')
  assert.deepEqual(over.report.problems, ['needs-2.36 needs glibc 2.36, newer than 2.35'])
})

test('a file with no dynamic symbols has no floor and is not a failure', () => {
  // objdump says so either way: "no symbols" with exit 0, or "not a dynamic object" with exit 1
  for (const name of ['static-exit-0', 'static-exit-1']) {
    const run = check(['needs-2.34', name])
    assert.equal(run.status, 0, `${name}: ${run.output}`)
    assert.equal(run.row(name).glibc, null)
    assert.equal(run.row(name).symbols, 'none', `${name} is recorded as having no dynamic symbols`)
    assert.equal(run.row('needs-2.34').symbols, 'read')
    assert.equal(run.report.floor, '2.34')
    assert.deepEqual(run.report.problems, [])
  }
})

test('symbols that could not be read fail the check, each with its reason', () => {
  for (const [name, reason] of [['io-error', /EIO/], ['no-objdump', /ENOENT/], ['unknown-format', /file format not recognized/], ['killed', /SIGKILL/], ['empty-output', /no dynamic symbol table in its output/]]) {
    const run = check(['needs-2.34', name])
    assert.equal(run.status, 1, `${name} must fail the check: ${run.output}`)
    assert.equal(run.row(name).symbols, 'unreadable')
    assert.equal(run.report.problems.length, 1, name)
    assert.match(run.report.problems[0], new RegExp(`^${name}: its dynamic symbols could not be read`))
    assert.match(run.report.problems[0], reason)
    assert.match(run.output, new RegExp(`::error::${name}: its dynamic symbols could not be read`))
  }
})

test('a reader that fails for every file is a failure, never a green report without a floor', () => {
  const run = check(['io-error'])
  assert.equal(run.status, 1)
  assert.equal(run.report.floor, null)
  assert.equal(run.report.problems.length, 1)
})

test('no symbols read anywhere is a failure even when every file says it has none', () => {
  // a packaged app always has dynamically linked programs: a floor of "none" means the check saw nothing
  const run = check(['static-exit-0', 'static-exit-1'])
  assert.equal(run.status, 1, run.output)
  assert.match(run.report.problems.join('\n'), /no file's dynamic symbols name a glibc version/)
})
