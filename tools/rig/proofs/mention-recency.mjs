// The @ menu's mention times (migration 0076, USER 2026-10-27 m79e889ce1609
// "and ofc sort all items by most recently mentioned / operated on /
// presented"): the engine's native test against this run's disposable cluster.
// It makes its own database there, stages a pre-0076 schema holding mail that
// mentions real-shaped tickets, presentations (one by its old id), apps,
// panels and agents in two orgs, upgrades it, learns the mentions in a bounded
// catch-up, and ranks, filters and pages the live things. No live data is read.
// Inputs, owned by ORGTREE_AGENT under C:/orgtree-build/<agent>:
//   ORGTREE_MENTION_RECENCY_EXE the engine's test binary (orgtree_engine-<hash>.exe)
//   ORGTREE_CLAIM_TEST_OUTPUT   a private directory for the test's output
import fs from 'node:fs'
import path from 'node:path'
import {spawnSync} from 'node:child_process'
import {Proof} from '../proof.mjs'
import {rigHome} from '../lib.mjs'

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

export async function setup() {
  return { fixture: { org: { name: 'Mention recency' }, agents: [{ name: 'boss', tier: 'sol', grant: 10, charter: 'Synthetic superior only.' }] } }
}

export default async function (rig) {
  const p = new Proof('mention-recency')
  const owner = process.env.ORGTREE_AGENT
  if (!owner || !/^[A-Za-z0-9_-]{1,64}$/.test(owner)) throw Error('explicit owner required')
  const native = ownedInput(process.env.ORGTREE_MENTION_RECENCY_EXE, owner)
  const output = ownedInput(process.env.ORGTREE_CLAIM_TEST_OUTPUT, owner)
  if (!fs.statSync(native).isFile() || !/^orgtree_engine-[a-f0-9]+\.exe$/.test(path.basename(native)) || !fs.statSync(output).isDirectory()) {
    throw Error('the engine test binary and an output directory are required')
  }
  const {port, password} = rig.pgConn()
  const url = db => `host=127.0.0.1 port=${port} user=orgtree_admin password=${password} dbname=${db}`
  const env = { ...process.env, ORGTREE_RIG_HOME: rigHome(), ORGTREE_CLAIM_TEST_OUTPUT: output, ORGTREE_CLAIM_TEST_URL: url('orgtree_engine'), ORGTREE_CLAIM_TEST_ROOT: rig.dir,
    ORGTREE_CLAIM_TEST_ORG: String(rig.one(`SELECT org_id FROM ot.agents WHERE name='boss'`).org_id) }
  const run = (name, args) => {
    const r = spawnSync(native, [...args, '--ignored', '--nocapture', '--test-threads=1'],
      { env, encoding: 'utf8', windowsHide: true, timeout: 300000, maxBuffer: 4 * 1024 ** 2 })
    p.file(`${name}.log`, (r.stdout || '') + (r.stderr || ''))
    p.file(`${name}-exit.json`, { status: r.status, signal: r.signal, error: r.error?.message })
    return r
  }
  const passed = (r, n) => r.status === 0 && !r.signal && !r.error && r.stdout.includes(`${n} passed; 0 failed`)
  const guards = run('guards', ['domain::native_fixture::rejects_invalid_inputs', '--exact'])
  p.check('the fixture refuses absent, foreign, live and non-disposable inputs', passed(guards, 1))
  if (!passed(guards, 1)) return p.summary()
  const menu = run('menu', ['migrate::mention_recency_tests::'])
  p.check('staged pre-0076 upgrade, mentions learned from mail in a bounded catch-up, live things ranked, filtered and paged (1 native test)', passed(menu, 1),
    { status: menu.status, results: (menu.stdout.match(/^test .*$/gm) || []).slice(0, 10) })
  const file = path.join(output, 'mention-recency', 'menu.json')
  if (fs.existsSync(file)) p.file('menu.json', JSON.parse(fs.readFileSync(file, 'utf8')))
  p.file('runtime.json', { engine: rig.run.engineSource, run: rig.run.id, limits: 'A native test on its own staged database in the isolated cluster; synthetic mail only.' })
  return p.summary()
}
