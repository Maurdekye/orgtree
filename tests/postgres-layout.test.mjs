import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { POSTGRES_PIN, POSTGRES_REQUIRED, POSTGRES_SCHEMA, assertPostgresRuntime } from '../tools/postgres-layout.mjs'

function payload(t) {
  const engine = fs.mkdtempSync(path.join(os.tmpdir(), 'orgtree-pg-layout-'))
  t.after(() => fs.rmSync(engine, { recursive: true, force: true }))
  const files = {}
  for (const name of [...POSTGRES_REQUIRED, 'postgresql/lib/pgoutput.dll']) {
    const full = path.join(engine, name)
    fs.mkdirSync(path.dirname(full), { recursive: true })
    const bytes = Buffer.from(name)
    fs.writeFileSync(full, bytes)
    files[name] = { bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') }
  }
  const manifest = { schema: POSTGRES_SCHEMA, archive: POSTGRES_PIN, files }
  const save = () => fs.writeFileSync(path.join(engine, 'postgres-runtime-manifest.json'), JSON.stringify(manifest))
  save()
  return { engine, manifest, save }
}

test('valid payload is checked byte-for-byte; altered native bytes refuse', t => {
  const { engine } = payload(t)
  assert.equal(assertPostgresRuntime(engine).files, POSTGRES_REQUIRED.length + 1)
  fs.appendFileSync(path.join(engine, 'postgresql/bin/postgres.exe'), 'bad')
  assert.throws(() => assertPostgresRuntime(engine), /hash mismatch: postgresql\/bin\/postgres\.exe/)
})

test('missing DLL or unlisted file refuses even with all main executables present', t => {
  const { engine } = payload(t)
  const dll = path.join(engine, 'postgresql/lib/pgoutput.dll')
  fs.unlinkSync(dll)
  assert.throws(() => assertPostgresRuntime(engine), /file set differs/)
  fs.writeFileSync(dll, 'postgresql/lib/pgoutput.dll')
  fs.writeFileSync(path.join(engine, 'postgresql/bin/unlisted.dll'), '')
  assert.throws(() => assertPostgresRuntime(engine), /file set differs/)
})

test('wrong pin, a v1 or custodian manifest, and a truncated manifest refuse', t => {
  const { engine, manifest, save } = payload(t)
  manifest.archive = { ...POSTGRES_PIN, sha256: '0'.repeat(64) }; save()
  assert.throws(() => assertPostgresRuntime(engine), /unapproved schema or archive/)
  manifest.archive = POSTGRES_PIN; manifest.schema = 'orgtree.postgres-runtime/v1'; save()
  assert.throws(() => assertPostgresRuntime(engine), /--rewrite-manifest/)
  manifest.schema = POSTGRES_SCHEMA; manifest.custodian = { features: [], sources: {} }; save()
  assert.throws(() => assertPostgresRuntime(engine), /unapproved schema/)
  delete manifest.custodian; delete manifest.files['postgresql/bin/initdb.exe']; save()
  assert.throws(() => assertPostgresRuntime(engine), /incomplete/)
})

test('a stray pg-custodian.exe beside the payload is not part of it', t => {
  const { engine } = payload(t)
  // A machine provisioned before 4.6.1 still has the old custodian beside the
  // payload; packaging no longer ships the engine folder's top level, and the
  // gate neither needs nor counts it.
  fs.writeFileSync(path.join(engine, 'pg-custodian.exe'), 'old')
  assert.equal(assertPostgresRuntime(engine, { sourceRoot: path.resolve(import.meta.dirname, '..') }).files, POSTGRES_REQUIRED.length + 1)
})
