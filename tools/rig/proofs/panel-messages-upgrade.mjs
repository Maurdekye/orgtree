// Panel messages named like the old lifecycle rows survive the History upgrade
// (migrations 0070 and 0071a around the shipped 0071; 4.5.0 high D14, review
// alpha4 99517050d4d6 F2): the engine's native tests against this run's
// disposable cluster. Each makes its own database there. One stages a pre-0070
// schema holding the engine's own lifecycle rows in every shape it wrote and
// messages sent under the same names, upgrades it, and checks that only the
// engine's rows are deleted or stay History while every message is kept as it
// was. The other stages a database that already had 0071 and checks that the
// upgrade leaves it unchanged. No live data is read.
// Inputs, owned by ORGTREE_AGENT under C:/orgtree-build/<agent>:
//   ORGTREE_PANEL_MESSAGES_EXE  the engine's test binary (orgtree_engine-<hash>.exe)
//   ORGTREE_CLAIM_TEST_OUTPUT   a private directory for the tests' output
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
  return { fixture: { org: { name: 'Panel messages' }, agents: [{ name: 'boss', tier: 'sol', grant: 10, charter: 'Synthetic superior only.' }] } }
}

export default async function (rig) {
  const p = new Proof('panel-messages-upgrade')
  const owner = process.env.ORGTREE_AGENT
  if (!owner || !/^[A-Za-z0-9_-]{1,64}$/.test(owner)) throw Error('explicit owner required')
  const native = ownedInput(process.env.ORGTREE_PANEL_MESSAGES_EXE, owner)
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
  const upgrade = run('upgrade', ['migrate::panel_message_tests::'])
  p.check('a staged pre-0070 upgrade deletes only the engine\'s own lifecycle rows, keeps its starts, stops and fires as History, and keeps every message under its own name; a database that already had 0071 is left as it was (2 native tests)',
    passed(upgrade, 2), { status: upgrade.status, results: (upgrade.stdout.match(/^test .*$/gm) || []).slice(0, 10) })
  const file = path.join(output, 'panel-messages', 'upgrade.json')
  if (fs.existsSync(file)) p.file('upgrade.json', JSON.parse(fs.readFileSync(file, 'utf8')))
  p.file('runtime.json', { engine: rig.run.engineSource, run: rig.run.id, limits: 'Native tests on their own staged databases in the isolated cluster; synthetic rows only.' })
  return p.summary()
}
