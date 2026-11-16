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
const { postgresLaunchOptions, ...rest } = createRequire(import.meta.url)(output)
test.after(() => fs.rmSync(scratch, { recursive: true, force: true }))

test('the Python-era path helpers are gone with the Python engine', () => {
  assert.deepEqual(Object.keys(rest).sort(), ['exeName'])
})

test('packaged launches enable bootstrap while development path opt-in cannot', () => {
  assert.deepEqual(postgresLaunchOptions(true, {}), { packagedPostgres: true, bootstrapPostgres: true })
  assert.deepEqual(postgresLaunchOptions(false, {}), { packagedPostgres: false, bootstrapPostgres: false })
  assert.deepEqual(postgresLaunchOptions(false, { ORGTREE_DESKTOP_PACKAGED_PG: '1' }),
    { packagedPostgres: true, bootstrapPostgres: false })
  assert.deepEqual(postgresLaunchOptions(true, { ORGTREE_DESKTOP_PACKAGED_PG: '0' }),
    { packagedPostgres: true, bootstrapPostgres: true })
})
