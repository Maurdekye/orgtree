// R2 implicit-FK regression: real routes paused before agent/event INSERT's
// FK check. Synthetic rig state and fake CLI only; no production test hooks.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { Proof } from '../proof.mjs'
export async function setup() { return { fixture: 'none' } }

export default async function (rig) {
  const p = new Proof('approved-folder-grants-round3')
  p.note('provenance', { label: process.env.FOLDER_GRANT_PROOF_LABEL,
    engineSha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(rig.dir, 'bin', 'orgtree-engine.exe'))).digest('hex') })
  rig.scenario({ default: { turns: [{ name: 'default', steps: [{ text: 'OK.' }] }] } })
  const created = await rig.api('POST', '/api/orgs', { name: 'Folder FK', dirs: [], net_autoconnect: false })
  rig.run.org = created.slug
  const { writeRun } = await import('../lib.mjs')
  rig.run = writeRun(rig.dir, { org: created.slug })
  await rig.op({ op: 'hire', name: 'boss', tier: 'haiku', grant: 48, index: 0 })
  await rig.op({ op: 'hire', name: 'child', parent: 'boss', tier: 'haiku', grant: 16, index: 0 })
  const q = s => `'${String(s).replaceAll("'", "''")}'`
  const oid = rig.one(`SELECT id FROM ot.orgs WHERE slug=${q(rig.org)}`).id
  const raw = () => rig.one(`SELECT scope FROM ot.agents WHERE org_id=${oid} AND name='boss'`).scope
  const settings = () => rig.one(`SELECT settings FROM ot.orgs WHERE id=${oid}`).settings
  const has = dir => settings().dirs.some(d => path.resolve(d.path).toLowerCase() === path.resolve(dir).toLowerCase())
  const capture = fn => fn().then(out => ({ ok: out.ok !== false, out }), e => ({ ok: false, status: e.status, text: e.message }))
  async function barrier(key) {
    const { port, password } = rig.pgConn()
    const child = spawn(path.join(rig.run.pgBin, 'psql.exe'), ['-X', '-q', '-At', '-v', 'ON_ERROR_STOP=1', '-h', '127.0.0.1',
      '-p', String(port), '-U', 'orgtree_admin', '-d', 'orgtree_engine'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PGPASSWORD: password, PGCLIENTENCODING: 'UTF8', PGCONNECT_TIMEOUT: '10' } })
    let stdout = '', stderr = ''
    child.stdout.on('data', b => { stdout += b }); child.stderr.on('data', b => { stderr += b })
    const exited = new Promise(resolve => child.on('close', code => resolve({ code, stderr })))
    child.stdin.write(`SELECT pg_advisory_lock(${key});\n\\echo READY\n`)
    await rig.waitFor(() => stdout.includes('READY'), { timeout: 10000, every: 50, what: 'synthetic advisory holder' })
    return async () => { child.stdin.end(`SELECT pg_advisory_unlock(${key});\n\\q\n`); const out = await exited; if (out.code !== 0) throw new Error(out.stderr) }
  }
  const schedules = [
    { actor: 'user', op: 'hire', audience: 'omitted', route: 'approval' },
    { actor: 'agent', op: 'hire', audience: 'empty', route: 'direct' },
    { actor: 'agent', op: 'rehire', audience: 'omitted', route: 'approval' },
    { actor: 'agent', op: 'retool', audience: 'omitted', route: 'direct' },
  ]
  for (const [i, s] of schedules.entries()) {
    const name = `fkseat${i}`, key = 88420 + i, dir = path.join(rig.data, 'fk-folders', name)
    const label = `${s.actor} ${s.op} ${s.audience} audience / ${s.route}`
    if (s.op === 'rehire') {
      await rig.op({ op: 'hire', name, parent: 'boss', tier: 'haiku', index: 0 })
      await rig.op({ op: 'retire', node: name })
    }
    if (s.op === 'retool') await rig.op({ op: 'hire', name, parent: 'boss', tier: 'haiku', index: 0 })
    // A predecessor HTTP victim leaves its request open; approve all retained
    // explicit items if the next schedule amends that same request.
    let row
    if (s.route === 'approval') {
      const ask = await rig.tool('boss', 'orgtree_request_scope', { items: [{ kind: 'dir', path: dir, mode: 'rw' }], reason: 'FK schedule' })
      if (!ask.ok) throw new Error(ask.text)
      row = rig.one(`SELECT rev,body FROM ot.asks WHERE agent_id=${rig.agentRow('boss').id} AND status='open' ORDER BY id DESC LIMIT 1`)
      // A restored seat is archived before the operation. Bind this synthetic
      // pending ask before its row is locked; the approval route stays real.
      if (s.op === 'rehire') rig.exec(`UPDATE ot.asks SET agent_id=${rig.agentRow(name).id} WHERE agent_id=${rig.agentRow('boss').id} AND status='open'`)
    }
    const table = s.op === 'hire' ? 'agents' : 'events'
    const predicate = table === 'agents' ? `NEW.name=${q(name)}`
      : `NEW.org_id=${oid} AND NEW.op=${q(s.op)} AND NEW.subject_agent_id=${rig.agentRow(name).id}`
    rig.exec(`CREATE FUNCTION ot.fk_staff_barrier() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF ${predicate} THEN PERFORM pg_advisory_xact_lock(${key}); END IF; RETURN NEW; END $$;
      CREATE TRIGGER fk_staff_barrier BEFORE INSERT ON ot.${table} FOR EACH ROW EXECUTE FUNCTION ot.fk_staff_barrier()`)
    const release = await barrier(key)
    let writer, edit
    try {
      const req = s.op === 'hire' ? { name, tier: 'haiku', parent: 'boss', index: 0, grant: 0, charter: 'Synthetic FK control.',
        add_dirs: [], tools: { bash: false, web: false, edit: false, subagents: false, mcp: [] }, org_visibility: 'self' }
        : s.op === 'rehire' ? { node: name } : { node: name, effort: 'high' }
      if (s.audience === 'empty') req.audiences = []
      writer = capture(() => s.actor === 'user' ? rig.op({ op: s.op, ...req }) : rig.tool('boss', `orgtree_${s.op}`, req))
      const paused = await rig.waitFor(() => rig.one(`SELECT pid FROM pg_locks WHERE locktype='advisory' AND objid=${key} AND NOT granted`),
        { timeout: 15000, every: 100, what: `${label} before FK barrier` })
      const target = s.op === 'hire' ? 'boss' : name
      edit = capture(() => row ? rig.api('POST', `/api/orgs/${rig.org}/nodes/${target}/batch`,
        { revs: { scope: row.rev }, scope: row.body.items.map(() => 'approve') })
        : rig.api('POST', `/api/orgs/${rig.org}/nodes/${target}/scope`, { add_dirs: [...(s.op === 'hire' ? raw().add_dirs : []), { path: dir, mode: 'rw' }] }))
      const wait = await rig.waitFor(() => rig.one(`SELECT pid,query,wait_event,pg_blocking_pids(pid) AS blockers FROM pg_stat_activity
        WHERE ${paused.pid}=ANY(pg_blocking_pids(pid)) AND wait_event='transactionid'`),
        { timeout: 15000, every: 100, what: `${label} competing real route` })
      p.check(`${label}: org admission precedes node waiting`, /FROM ot\.orgs\b/i.test(wait.query), wait)
    } finally {
      await release()
      const results = await Promise.all([writer, edit].filter(Boolean))
      rig.exec(`DROP TRIGGER fk_staff_barrier ON ot.${table}; DROP FUNCTION ot.fk_staff_barrier()`)
      p.check(`${label}: both routes commit with folder and operation intact`, results.length === 2 && results.every(r => r.ok) && has(dir)
        && rig.agentRow(name)?.state === 'live', results)
    }
    await rig.waitFor(() => rig.sql('SELECT id FROM ot.turns WHERE ended_at IS NULL').length === 0, { what: 'settled synthetic turns' })
  }
  const plain = await capture(() => rig.tool('boss', 'orgtree_retool', { node: 'child', effort: 'high' }))
  p.check('uncontended ordinary event writer remains supported', plain.ok, plain)
  // Two distinct node operations must both reach the event barrier while the
  // other transaction is still open: the early org pin is mutually compatible.
  await rig.op({ op: 'hire', name: 'parallel', parent: 'boss', tier: 'haiku', index: 0 })
  const key = 88429
  const ids = ['child', 'parallel'].map(n => rig.agentRow(n).id)
  rig.exec(`CREATE FUNCTION ot.fk_staff_barrier() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.org_id=${oid} AND NEW.op='rename' AND NEW.subject_agent_id IN (${ids.join(',')}) THEN PERFORM pg_advisory_xact_lock(${key}); END IF;
    RETURN NEW; END $$;
    CREATE TRIGGER fk_staff_barrier BEFORE INSERT ON ot.events FOR EACH ROW EXECUTE FUNCTION ot.fk_staff_barrier()`)
  const release = await barrier(key)
  const parallel = ['child', 'parallel'].map(node => capture(() => rig.tool('boss', 'orgtree_rename', { node, name: `${node}renamed` })))
  try {
    const paused = await rig.waitFor(() => {
      const rows = rig.sql(`SELECT pid FROM pg_locks WHERE locktype='advisory' AND objid=${key} AND NOT granted`)
      return rows.length === 2 ? rows : null
    }, { timeout: 15000, every: 100, what: 'two ordinary operations concurrently inside transaction' })
    p.check('ordinary operations on separate nodes share org admission concurrently', paused.length === 2, paused)
  } finally {
    await release()
    const results = await Promise.all(parallel)
    rig.exec('DROP TRIGGER fk_staff_barrier ON ot.events; DROP FUNCTION ot.fk_staff_barrier()')
    p.check('both compatible ordinary operations commit', results.every(r => r.ok), results)
  }
  p.keep(rig, { agents: ['boss'], grep: /deadlock|conflicted|scope|batch|fk_staff_barrier/i })
  return p.summary()
}
