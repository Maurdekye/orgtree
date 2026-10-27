// Presentations identified by a readable slug (migration 0073, user 2026-10-27
// m4efbc12ac94e) and the slug orgtree_present may ask for (migration 0074,
// user mdcb7ce9a8103). Runs the engine's native document-slug tests against this
// run's disposable cluster: each makes its own database there and stages a
// pre-0073 schema with real-shaped presentations. No live data is read.
// Inputs, owned by ORGTREE_AGENT under C:/orgtree-build/<agent>:
//   ORGTREE_DOCUMENT_SLUGS_EXE  the engine's test binary (orgtree_engine-<hash>.exe)
//   ORGTREE_CLAIM_TEST_OUTPUT   a private directory for the tests' output
import {Proof} from '../proof.mjs'
import fs from 'node:fs'
import path from 'node:path'
import {spawnSync} from 'node:child_process'

function ownedInput(value, owner) {
  if (!value || !path.isAbsolute(value)) throw Error('explicit absolute owned input required')
  const file = path.resolve(value), base = path.resolve('C:/orgtree-build', owner), relative = path.relative(base, file)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw Error('input outside the owned build scope')
  for (let at = file; ; at = path.dirname(at)) {
    if (fs.lstatSync(at).isSymbolicLink()) throw Error('input symlink/junction refused')
    if (path.dirname(at) === at) break
  }
  if (fs.realpathSync(file).toLowerCase() !== file.toLowerCase()) throw Error('input canonical path mismatch')
  return file
}

export async function setup() { return { fixture: { org: { name: 'Document slugs' }, agents: [{ name: 'boss', tier: 'sol', grant: 100 }] } } }

export default async function (rig) {
  const p = new Proof('document-slugs')
  const owner = process.env.ORGTREE_AGENT
  if (!owner || !/^[A-Za-z0-9_-]{1,64}$/.test(owner)) throw Error('explicit owner required')
  const native = ownedInput(process.env.ORGTREE_DOCUMENT_SLUGS_EXE, owner)
  const output = ownedInput(process.env.ORGTREE_CLAIM_TEST_OUTPUT, owner)
  if (!fs.statSync(native).isFile() || !/^orgtree_engine-[a-f0-9]+\.exe$/.test(path.basename(native)) || !fs.statSync(output).isDirectory()) {
    throw Error('the engine test binary and an output directory are required')
  }
  const {port, password} = rig.pgConn()
  const url = db => `host=127.0.0.1 port=${port} user=orgtree_admin password=${password} dbname=${db}`
  const env = { ...process.env, ORGTREE_CLAIM_TEST_OUTPUT: output, ORGTREE_CLAIM_TEST_URL: url('orgtree_engine'), ORGTREE_CLAIM_TEST_ROOT: rig.dir,
    ORGTREE_CLAIM_TEST_ORG: String(rig.one(`SELECT org_id FROM ot.agents WHERE name='boss'`).org_id) }
  const run = (name, args, extra = {}) => {
    const r = spawnSync(native, [...args, '--ignored', '--nocapture', '--test-threads=1'],
      { env: { ...env, ...extra }, encoding: 'utf8', windowsHide: true, timeout: 300000, maxBuffer: 4 * 1024 ** 2 })
    p.file(`${name}.log`, (r.stdout || '') + (r.stderr || ''))
    p.file(`${name}-exit.json`, { status: r.status, signal: r.signal, error: r.error?.message })
    return r
  }
  const passed = (r, n) => r.status === 0 && !r.signal && !r.error && r.stdout.includes(`${n} passed; 0 failed`)
  const guards = run('guards', ['domain::native_fixture::rejects_invalid_inputs', '--exact'])
  p.check('the fixture refuses absent, foreign, live and non-disposable inputs', passed(guards, 1))
  if (!passed(guards, 1)) return p.summary()
  const slugs = run('slugs', ['migrate::document_slug_tests::'])
  p.check('staged pre-0073 upgrade, old ids on every route, free slugs under concurrency, requested slugs (4 native tests)', passed(slugs, 4),
    { status: slugs.status, results: (slugs.stdout.match(/^test .*$/gm) || []).slice(0, 10) })
  // the opening read's own hand-built schema, with 0073's resolver, in a fresh database
  rig.exec('CREATE DATABASE opening_fixture')
  const opening = run('opening', ['http::docs::opening_tests::oldest_unread_read_is_scoped_and_uses_modified_fallback', '--exact'],
    { ORGTREE_OPENING_TEST_PG: url('opening_fixture') })
  p.check('the opening read restores a reader by its old id', passed(opening, 1))
  for (const f of ['upgrade.json', 'routes.json', 'present.json', 'requested.json']) {
    const file = path.join(output, 'document-slugs', f)
    if (fs.existsSync(file)) p.file(f, JSON.parse(fs.readFileSync(file, 'utf8')))
  }
  return p.summary()
}
