// Apps and panels identified by readable slugs (migration 0075, USER 2026-10-27
// mc70ab563f21d "apps and panels should have slug based identifiers as well").
// First the engine's native app-slug tests against this run's disposable
// cluster: each makes its own database there and stages a pre-0075 schema with
// real-shaped apps, panels and everything that names them, then upgrades it
// and uses the old ids. Then the slugs through the real engine: an agent makes
// an app with a Hebrew name and an English slug, copies, and an app_listener
// watchdog by slug, and a fire reaches it naming the slugs. No live data is read.
// Inputs, owned by ORGTREE_AGENT under C:/orgtree-build/<agent>:
//   ORGTREE_APP_SLUGS_EXE       the engine's test binary (orgtree_engine-<hash>.exe)
//   ORGTREE_CLAIM_TEST_OUTPUT   a private directory for the tests' output
import assert from 'node:assert/strict'
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

// recover: the engine starts its app event dispatcher (a safe start never does)
export async function setup() {
  return { recover: true, fixture: { org: { name: 'App slugs' }, agents: [
    { name: 'boss', tier: 'sol', grant: 100, charter: 'Synthetic superior only.' },
    { name: 'writer', tier: 'sol', parent: 'boss', grant: 0, charter: 'Synthetic app author only.' }] } }
}

export default async function (rig) {
  const p = new Proof('app-slugs'), root = '/api/orgs/' + rig.org
  const owner = process.env.ORGTREE_AGENT
  if (!owner || !/^[A-Za-z0-9_-]{1,64}$/.test(owner)) throw Error('explicit owner required')

  // 1. the native tests: a staged pre-0075 database, upgraded, used by its old ids
  if (process.env.ORGTREE_APP_SLUGS_EXE) {
    const native = ownedInput(process.env.ORGTREE_APP_SLUGS_EXE, owner)
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
    const slugs = run('slugs', ['migrate::app_slug_tests::'])
    p.check('staged pre-0075 upgrade and old ids through the Apps tool and listener sources (2 native tests)', passed(slugs, 2),
      { status: slugs.status, results: (slugs.stdout.match(/^test .*$/gm) || []).slice(0, 10) })
    for (const f of ['upgrade.json', 'tool.json']) {
      const file = path.join(output, 'app-slugs', f)
      if (fs.existsSync(file)) p.file(f, JSON.parse(fs.readFileSync(file, 'utf8')))
    }
  } else p.note('no ORGTREE_APP_SLUGS_EXE: the native staged-database tests did not run')

  // 2. the real engine: slugs from names, an English slug for a Hebrew name, listeners by slug
  const apps = input => rig.api('POST', root + '/apps', input)
  const tool = async (who, name, args) => { const r = await rig.tool(who, name, args); assert(r.ok, r.text); return r.json }
  const refused = async (who, name, args) => { const r = await rig.tool(who, name, args); return r.ok ? null : r.text }
  const definition = name => ({ name, html: '<p>board</p>', capabilities: ['events.fire'], events: [{ name: 'caption.ready' }], width: 420, height: 320 })
  const hebrew = await tool('writer', 'orgtree_apps', { action: 'app_create', definition: definition('לוח כתוביות'), slug: 'Caption board' })
  const plain = await tool('writer', 'orgtree_apps', { action: 'app_create', definition: definition('Caption board') })
  const bare = await tool('writer', 'orgtree_apps', { action: 'app_create', definition: definition('לוח שבועי') })
  p.check('an app\'s id is a slug: an English slug for a Hebrew name, the name\'s slug with -2 when taken, `app` with no Latin letters',
    hebrew.id === 'caption-board' && hebrew.name === 'לוח כתוביות' && plain.id === 'caption-board-2' && bare.id === 'app'
      && hebrew.ref === `@app:${rig.org}/caption-board`, { hebrew: [hebrew.id, hebrew.name, hebrew.ref], plain: plain.id, bare: bare.id })
  const closed = await tool('writer', 'orgtree_apps', { action: 'panel_open', app: 'caption-board' })
  const named = await tool('writer', 'orgtree_apps', { action: 'panel_open', app: 'caption-board', slug: 'studio-copy' })
  const opened = await apps({ action: 'panel_open', app: 'caption-board-2', new: true })
  p.check('a panel\'s id is its app\'s slug and label, or the slug asked for, unique in the org',
    closed.id === 'caption-board-panel-1' && closed.app === 'caption-board' && named.id === 'studio-copy' && opened.id === 'caption-board-2-panel-1'
      && closed.ref === `@panel:${rig.org}/caption-board-panel-1`, { closed: [closed.id, closed.ref], named: named.id, opened: opened.id })
  const refusals = {
    update: await refused('writer', 'orgtree_apps', { action: 'app_update', app: 'caption-board', expected_rev: hebrew.rev, definition: definition('x'), slug: 'renamed' }),
    hebrewSlug: await refused('writer', 'orgtree_apps', { action: 'app_create', definition: definition('x'), slug: 'לוח' }),
  }
  p.check('a slug is asked only when an app or panel is made, and must keep an ASCII letter or digit',
    /keeps its slug once made/.test(refusals.update ?? '') && /no ASCII letter or digit/.test(refusals.hebrewSlug ?? ''), refusals)
  // an app_listener by slug, stored by slug, and a fire naming the slugs
  const dog = await tool('writer', 'orgtree_watchdog', { action: 'create', kind: 'app_listener', target: 'caption-board', panel: 'caption-board-panel-1',
    event_name: 'caption.ready', name: 'captions', notice: true })
  const stored = rig.one(`SELECT target, memo->>'panel' AS panel FROM ot.watchdogs WHERE kind='app_listener' AND name='captions'`)
  p.check('an app_listener named by slugs stores them', stored?.target === 'caption-board' && stored?.panel === 'caption-board-panel-1', { dog: dog?.id ?? dog, stored })
  const fired = await apps({ action: 'fire_event', panel: 'caption-board-panel-1', name: 'caption.ready', payload: { line: 1 } })
  p.file('fired.json', fired)
  const delivered = await rig.waitFor(() => rig.sql(`SELECT 1 FROM ot.mail WHERE extra->'app_event'->>'event'='${fired.event}'`).length === 1,
    { what: 'the fire mail', timeout: 20000, every: 100 }).then(() => true, () => false)
  if (!delivered) p.file('undelivered.json', { fired, dogs: rig.sql(`SELECT id, name, state, target, memo, owner_agent_id FROM ot.watchdogs WHERE kind='app_listener'`),
    fires: rig.sql(`SELECT id, uid, app_id, panel_id, name, done FROM ot.app_event_fires`), recipients: rig.sql(`SELECT * FROM ot.app_event_recipients`) })
  const mail = delivered ? rig.one(`SELECT body FROM ot.mail WHERE extra->'app_event'->>'event'='${fired.event}'`) : null
  p.check('the fire mail names the app by name and slug and the panel by slug', fired.app === 'caption-board' && fired.panel === 'caption-board-panel-1'
    && /App: לוח כתוביות \(caption-board\); panel: "caption-board-panel-1"/.test(mail?.body ?? ''), { fired: [fired.app, fired.panel], body: (mail?.body ?? '').slice(0, 240) })
  const listed = await tool('writer', 'orgtree_apps', { action: 'listeners', app: 'caption-board' })
  p.check('the app\'s listeners list names the copy by slug', listed.items?.[0]?.panel === 'caption-board-panel-1', listed.items)
  p.file('runtime.json', { engine: rig.run.engineSource, run: rig.run.id, limits: 'Synthetic org and fake CLIs on an isolated cluster; native tests on their own staged databases.' })
  return p.summary()
}
