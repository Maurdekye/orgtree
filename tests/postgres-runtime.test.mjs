import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { build } from 'esbuild'

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'orgtree-pg-paths-'))
const output = path.join(scratch, 'postgres-runtime.cjs')
await build({ entryPoints: ['apps/desktop/main/postgres-runtime.ts'], outfile: output,
  bundle: true, platform: 'node', format: 'cjs' })
const { postgresRuntimeEnvironment } = createRequire(import.meta.url)(output)
test.after(() => fs.rmSync(scratch, { recursive: true, force: true }))

test('disabled by default: no paths or storage selectors are supplied', () => {
  assert.deepEqual(postgresRuntimeEnvironment('missing'), {})
  assert.deepEqual(postgresRuntimeEnvironment('missing', false), {})
})

test('enabled payload resolves both executable locations without changing storage selection', () => {
  const directory = path.join(scratch, 'install with spaces', 'engine')
  const bin = path.join(directory, 'postgresql', 'bin')
  fs.mkdirSync(bin, { recursive: true })
  for (const file of ['postgres.exe', 'pg_ctl.exe', 'initdb.exe']) fs.writeFileSync(path.join(bin, file), '')
  const custodian = path.join(directory, 'pg-custodian.exe')
  fs.writeFileSync(custodian, '')
  assert.deepEqual(postgresRuntimeEnvironment(directory, true), {
    ORGTREE_PG_CUSTODIAN: custodian, ORGTREE_P03_PG_BIN: bin,
  })
  fs.unlinkSync(path.join(bin, 'initdb.exe'))
  assert.throws(() => postgresRuntimeEnvironment(directory, true), /initdb\.exe/)
  // A directory bearing an executable's name is not a packaged executable.
  fs.mkdirSync(path.join(bin, 'initdb.exe'))
  assert.throws(() => postgresRuntimeEnvironment(directory, true), /initdb\.exe/)
})

test('enabled payload refuses absent and relative locations', () => {
  assert.throws(() => postgresRuntimeEnvironment('relative', true), /absolute engine directory/)
  assert.throws(() => postgresRuntimeEnvironment(path.join(scratch, 'missing'), true), /pg-custodian\.exe/)
})
