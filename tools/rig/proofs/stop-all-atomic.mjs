// Stop All's latch, its app panel power-off and its watchdog pause commit
// together, before any agent wait (4.5.0 review B10, alpha3 489e3953e566 F2;
// USER 2026-10-26: Stop all powers off every app panel, hidden ones included,
// and release starts none of them again): the engine's native tests against
// this run's disposable cluster, each on its own fresh database. A Stop All
// that ends right after its latch commits, or whose power-off fails, leaves no
// latched org with a panel still marked to run; a start racing Stop All waits
// for its latch. No live data is read.
// Inputs, owned by ORGTREE_AGENT under C:/orgtree-build/<agent>:
//   ORGTREE_STOP_ALL_EXE        the engine's test binary (orgtree_engine-<hash>.exe)
//   ORGTREE_CLAIM_TEST_OUTPUT   a private directory for the test's output
import fs from 'node:fs'
import path from 'node:path'
import {spawnSync} from 'node:child_process'
import {Proof} from '../proof.mjs'
import {rigHome} from '../lib.mjs'

const TESTS = ['stop_all_ended_after_its_latch_leaves_no_panel_marked_to_run', 'stop_all_whose_power_off_fails_latches_nothing',
  'a_start_racing_stop_all_waits_for_its_latch']

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
  return { fixture: { org: { name: 'Stop all' }, agents: [{ name: 'boss', tier: 'sol', grant: 10, charter: 'Synthetic superior only.' }] } }
}

export default async function (rig) {
  const p = new Proof('stop-all-atomic')
  const owner = process.env.ORGTREE_AGENT
  if (!owner || !/^[A-Za-z0-9_-]{1,64}$/.test(owner)) throw Error('explicit owner required')
  const native = ownedInput(process.env.ORGTREE_STOP_ALL_EXE, owner)
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
  const r = run('stop-all', ['http::orgops::stop_all_tests::'])
  for (const name of TESTS) {
    const line = (r.stdout.match(new RegExp(`^test http::orgops::stop_all_tests::${name} \\.\\.\\. .*$`, 'm')) || [null])[0]
    p.check(name.replaceAll('_', ' '), line?.endsWith('... ok') ?? false, { line })
  }
  p.check('the three native tests ran and passed', passed(r, TESTS.length), { status: r.status, summary: (r.stdout.match(/^test result: .*$/m) || [null])[0] })
  p.file('runtime.json', { engine: rig.run.engineSource, run: rig.run.id, limits: 'Native tests, each on its own fresh database in the isolated cluster; synthetic rows only.' })
  return p.summary()
}
