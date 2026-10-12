// R1 regressions: duplicate-equivalent folder intent and controlled staffing
// lock schedules. Only disposable rig state and fake CLIs are used.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { Proof } from '../proof.mjs'

export async function setup() { return { fixture: 'none' } }

export default async function (rig) {
  const p = new Proof('approved-folder-grants-round2')
  p.note('provenance', { label: process.env.FOLDER_GRANT_PROOF_LABEL,
    engineSha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(rig.dir, 'bin', 'orgtree-engine.exe'))).digest('hex') })
  rig.scenario({ default: { turns: [{ name: 'default', steps: [{ text: 'OK.' }] }] } })
  const created = await rig.api('POST', '/api/orgs', { name: 'Folder R2', dirs: [], net_autoconnect: false })
  rig.run.org = created.slug
  const { writeRun } = await import('../lib.mjs')
  rig.run = writeRun(rig.dir, { org: created.slug })
  await rig.op({ op: 'hire', name: 'boss', tier: 'haiku', grant: 48, index: 0 })
  const q = s => `'${String(s).replaceAll("'", "''")}'`
  const oid = rig.one(`SELECT id FROM ot.orgs WHERE slug=${q(rig.org)}`).id
  const raw = () => rig.one(`SELECT scope FROM ot.agents WHERE org_id=${oid} AND name='boss'`).scope
  const settings = () => rig.one(`SELECT settings FROM ot.orgs WHERE id=${oid}`).settings
  const folder = name => path.join(rig.data, 'r2-folders', name)
  const has = dir => settings().dirs.some(d => path.resolve(d.path).toLowerCase() === path.resolve(dir).toLowerCase())
  const save = b => rig.api('POST', `/api/orgs/${rig.org}/nodes/boss/scope`, b)
  const capture = fn => fn().then(out => ({ ok: out.ok !== false, out }), e => ({ ok: false, status: e.status, text: e.message }))
  const ask = async dir => {
    const out = await rig.tool('boss', 'orgtree_request_scope', { items: [{ kind: 'dir', path: dir, mode: 'rw' }], reason: 'R2 synthetic' })
    if (!out.ok) throw new Error(out.text)
    return rig.one(`SELECT rev FROM ot.asks WHERE agent_id=${rig.agentRow('boss').id} AND status='open' ORDER BY id DESC LIMIT 1`)
  }
  const approve = row => rig.api('POST', `/api/orgs/${rig.org}/nodes/boss/batch`, { revs: { scope: row.rev }, scope: ['approve'] })
  for (const order of ['ro-rw', 'rw-ro']) {
    const dir = folder(order), slash = dir.replaceAll('\\', '/'), alias = `${slash.toUpperCase()}/child/../.`
    const modes = order.split('-')
    const dirs = [{ path: slash, mode: modes[0] }, { path: alias, mode: modes[1] }]
    rig.exec(`UPDATE ot.agents SET scope=jsonb_set(scope,'{add_dirs}',${q(JSON.stringify(dirs))}::jsonb) WHERE org_id=${oid} AND name='boss'`)
    await save({ effort: 'high' })
    p.check(`${order}: omitted folders do not absorb latent aliases`, !has(dir), settings().dirs)
    await save({ add_dirs: dirs })
    p.check(`${order}: unchanged mixed-mode whole list does not absorb aliases`, !has(dir), settings().dirs)
    await save({ add_dirs: [{ path: dir, mode: 'rw' }] })
    p.check(`${order}: equivalent aggregate RW list remains unchanged intent`, !has(dir), settings().dirs)
    const row = await ask(dir)
    await approve(row)
    p.check(`${order}: explicit clamped reapproval still absorbs RW`, has(dir) && settings().dirs.some(d => d.mode === 'rw' && path.resolve(d.path).toLowerCase() === path.resolve(dir).toLowerCase()))
  }
  const upgrade = folder('true-upgrade'), addition = folder('true-addition')
  rig.exec(`UPDATE ot.agents SET scope=jsonb_set(scope,'{add_dirs}',${q(JSON.stringify([{ path: upgrade, mode: 'ro' }, { path: upgrade.replaceAll('\\', '/'), mode: 'ro' }]))}::jsonb) WHERE org_id=${oid} AND name='boss'`)
  await save({ add_dirs: [{ path: upgrade, mode: 'rw' }, { path: addition, mode: 'ro' }] })
  p.check('genuine aggregate RO-to-RW upgrade and new RO addition enter org', has(upgrade) && has(addition), settings().dirs)
  await rig.waitFor(() => rig.sql('SELECT id FROM ot.turns WHERE ended_at IS NULL').length === 0, { what: 'settled fake turns' })

  // Hold an advisory lock in a separate synthetic database session. A trigger
  // stops staffing after its node locks. Inspect the competing real HTTP
  // route's wait: it must be on the org, not a parent held before the org.
  async function barrier(key) {
    const { port, password } = rig.pgConn()
    const child = spawn(path.join(rig.run.pgBin, 'psql.exe'), ['-X', '-q', '-At', '-v', 'ON_ERROR_STOP=1',
      '-h', '127.0.0.1', '-p', String(port), '-U', 'orgtree_admin', '-d', 'orgtree_engine'],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, PGPASSWORD: password, PGCLIENTENCODING: 'UTF8', PGCONNECT_TIMEOUT: '10' } })
    let stdout = '', stderr = ''
    child.stdout.on('data', b => { stdout += b })
    child.stderr.on('data', b => { stderr += b })
    const exited = new Promise(resolve => child.on('close', code => resolve({ code, stderr })))
    child.stdin.write(`SELECT pg_advisory_lock(${key});\n\\echo READY\n`)
    await rig.waitFor(() => stdout.includes('READY'), { timeout: 10000, every: 50, what: 'synthetic advisory holder' })
    return async () => { child.stdin.end(`SELECT pg_advisory_unlock(${key});\n\\q\n`); const out = await exited; if (out.code !== 0) throw new Error(out.stderr) }
  }
  const schedules = [
    { actor: 'user', op: 'hire', route: 'approval' },
    { actor: 'agent', op: 'hire', route: 'direct' },
    { actor: 'user', op: 'rehire', route: 'direct' },
    { actor: 'agent', op: 'rehire', route: 'approval' },
  ]
  for (const [i, s] of schedules.entries()) {
    const name = `seat${i}`, key = 87310 + i, dir = folder(`schedule${i}`), label = `${s.actor} ${s.op} + audience / ${s.route}`
    if (s.op === 'rehire') {
      await rig.op({ op: 'hire', name, parent: 'boss', tier: 'haiku', index: 0 })
      await rig.op({ op: 'retire', node: name })
    }
    const row = s.route === 'approval' ? await ask(dir) : null
    rig.exec(`CREATE FUNCTION ot.r2_staff_barrier() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.name=${q(name)} AND (TG_OP='INSERT' OR (OLD.state <> 'live' AND NEW.state='live')) THEN PERFORM pg_advisory_xact_lock(${key}); END IF;
      RETURN NEW; END $$;
      CREATE TRIGGER r2_staff_barrier BEFORE INSERT OR UPDATE ON ot.agents FOR EACH ROW EXECUTE FUNCTION ot.r2_staff_barrier()`)
    const release = await barrier(key)
    let staff, edit, waiting
    try {
      const req = s.op === 'hire' ? { name, tier: 'haiku', parent: 'boss', index: 0 } : { node: name }
      staff = capture(() => s.actor === 'user' ? rig.op({ op: s.op, ...req, audiences: ['user'] })
        : rig.tool('boss', `orgtree_${s.op}`, { ...req, audiences: ['user'] }))
      const paused = await rig.waitFor(() => rig.one(`SELECT pid FROM pg_locks WHERE locktype='advisory' AND objid=${key} AND NOT granted`), { timeout: 15000, every: 100, what: `${label} staffing barrier` })
      edit = capture(() => row ? approve(row) : save({ add_dirs: [...raw().add_dirs, { path: dir, mode: 'rw' }] }))
      waiting = await rig.waitFor(() => rig.one(`SELECT pid,query,wait_event,pg_blocking_pids(pid) AS blockers FROM pg_stat_activity
        WHERE ${paused.pid}=ANY(pg_blocking_pids(pid)) AND wait_event='transactionid'`), { timeout: 15000, every: 100, what: `${label} competing route wait` })
      p.check(`${label}: competing folder route waits on org before node`, /FROM ot\.orgs\b/i.test(waiting.query), waiting)
    } finally {
      await release()
      const results = await Promise.all([staff, edit].filter(Boolean))
      rig.exec('DROP TRIGGER r2_staff_barrier ON ot.agents; DROP FUNCTION ot.r2_staff_barrier()')
      p.check(`${label}: both routes settle with grant and audience intact`, results.length === 2 && results.every(r => r.ok) && has(dir)
        && rig.agentRow(name)?.state === 'live' && !!rig.one(`SELECT 1 FROM ot.audiences WHERE org_id=${oid} AND grantee=${q(name)} AND grantor='@user' AND revoked_at IS NULL`), results)
    }
    await rig.waitFor(() => rig.sql('SELECT id FROM ot.turns WHERE ended_at IS NULL').length === 0, { what: 'settled schedule turns' })
  }
  const positive = await capture(() => rig.op({ op: 'hire', name: 'plain', parent: 'boss', tier: 'haiku', index: 0, audiences: ['user'] }))
  p.check('uncontended hire with audience remains supported', positive.ok && rig.agentRow('plain')?.state === 'live', positive)
  p.keep(rig, { agents: ['boss'], grep: /deadlock|conflicted|scope|batch|r2_staff_barrier/i })
  return p.summary()
}
