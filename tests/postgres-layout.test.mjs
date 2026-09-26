import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { POSTGRES_PIN, POSTGRES_REQUIRED, assertPostgresRuntime } from '../tools/postgres-layout.mjs'

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
  const manifest = { schema: 'orgtree.postgres-runtime/v1', archive: POSTGRES_PIN,
    custodian: { features: [], sources: {} }, files }
  const save = () => fs.writeFileSync(path.join(engine, 'postgres-runtime-manifest.json'), JSON.stringify(manifest))
  save()
  return { engine, manifest, save }
}

test('valid payload is checked byte-for-byte; altered native bytes refuse', t => {
  const { engine } = payload(t)
  assert.equal(assertPostgresRuntime(engine).files, POSTGRES_REQUIRED.length + 1)
  fs.appendFileSync(path.join(engine, 'pg-custodian.exe'), 'bad')
  assert.throws(() => assertPostgresRuntime(engine), /hash mismatch: pg-custodian/)
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

test('wrong pin, qualification feature, and truncated manifest refuse', t => {
  const { engine, manifest, save } = payload(t)
  manifest.archive = { ...POSTGRES_PIN, sha256: '0'.repeat(64) }; save()
  assert.throws(() => assertPostgresRuntime(engine), /unapproved archive/)
  manifest.archive = POSTGRES_PIN; manifest.custodian.features = ['qualification']; save()
  assert.throws(() => assertPostgresRuntime(engine), /feature set/)
  manifest.custodian.features = []; delete manifest.files['pg-custodian.exe']; save()
  assert.throws(() => assertPostgresRuntime(engine), /incomplete/)
})

test('source packaging rejects a custodian without the current native source inventory', t => {
  const { engine } = payload(t)
  assert.throws(() => assertPostgresRuntime(engine, { sourceRoot: path.resolve(import.meta.dirname, '..') }), /source list changed/)
})
