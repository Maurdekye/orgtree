// Builds orgtree-update-fixture.exe — the harmless binary BOTH upgrade entry
// points target. See build/update-fixture.nsi for the contract it honours.
//
//   node tools/build-update-fixture.mjs [--out <path>]
//
// It compiles an installer-shaped executable that installs nothing. Compiling is
// not running: nothing here executes the result, and the fixture itself is
// silent and windowless when it is eventually run.
//
// ⚠ THIS IS NOT PART OF A RELEASE PACKAGE. The fixture is a test artifact; the
// release preflight separately refuses any main bundle composed to hand off to
// one (tools/preflight-lib.mjs, assertNoUpdateFixture).

import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const argv = process.argv.slice(2)
const outIndex = argv.indexOf('--out')
const out = path.resolve(outIndex >= 0 && argv[outIndex + 1]
  ? argv[outIndex + 1]
  : 'dist/update-fixture/orgtree-update-fixture.exe')

const compiler = path.resolve(process.env.ORGTREE_MAKENSIS || path.join(
  process.env.LOCALAPPDATA || '',
  'electron-builder/Cache/nsis-3.0.4.1/nsis-3.0.4.1-1mx3n/makensis.exe'))
if (!fs.existsSync(compiler)) {
  throw new Error('INERT: NSIS compiler unavailable; set ORGTREE_MAKENSIS')
}

fs.mkdirSync(path.dirname(out), { recursive: true })
// /DOUTFILE, not /XOutFile: makensis runs command-line commands BEFORE the
// script, so an /X would be overridden by the script's own OutFile line. The
// script honours this define and falls back to a local name without it.
const result = spawnSync(compiler, ['/V2', `/DOUTFILE=${out}`, 'build/update-fixture.nsi'],
  { encoding: 'utf8', windowsHide: true, timeout: 60000 })
if (result.status !== 0) {
  throw new Error(`makensis failed (${result.status}):\n${result.stdout ?? ''}${result.stderr ?? ''}`)
}
if (!fs.existsSync(out)) throw new Error(`makensis reported success but produced no ${out}`)
console.log(`Built ${out} (${fs.statSync(out).size} bytes). It installs nothing.`)
