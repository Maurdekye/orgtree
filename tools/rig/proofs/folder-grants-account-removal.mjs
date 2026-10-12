// Final-review correction proof. Synthetic Claude secondary + idle bound
// agent + matching org default. Real folder/removal routes, disposable DB.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { Proof } from '../proof.mjs'
export async function setup() { return { fixture: 'none' } }

export default async function (rig) {
  const p = new Proof('folder-grants-account-removal')
  p.note('provenance', { label: process.env.FOLDER_GRANT_PROOF_LABEL,
    engineSha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(rig.dir, 'bin', 'orgtree-engine.exe'))).digest('hex') })
  rig.scenario({ default: { turns: [{ name: 'default', steps: [{ text: 'OK.' }] }] } })
  const created = await rig.api('POST', '/api/orgs', { name: 'Removal folders', dirs: [], net_autoconnect: false })
  rig.run.org = created.slug
  const { writeRun } = await import('../lib.mjs')
  rig.run = writeRun(rig.dir, { org: created.slug })
  await rig.op({ op: 'hire', name: 'boss', tier: 'haiku', grant: 32, index: 0 })
  for (const name of ['bound', 'binder']) await rig.op({ op: 'hire', name, parent: 'boss', tier: 'haiku', index: 0 })
  // Keep the synthetic seat idle throughout account reconfiguration so no
  // asynchronous fake-session replacement can moot the controlled request.
  await rig.op({ op: 'halt', nodes: ['bound', 'binder'] })
  await rig.api('POST', `/api/orgs/${rig.org}/audiences`, { action: 'grant', node: 'bound', reason: 'Synthetic direct scope request' })
  const q = s => `'${String(s).replaceAll("'", "''")}'`
  const oid = rig.one(`SELECT id FROM ot.orgs WHERE slug=${q(rig.org)}`).id
  const settings = () => rig.one(`SELECT settings FROM ot.orgs WHERE id=${oid}`).settings
  const raw = () => rig.one(`SELECT scope FROM ot.agents WHERE org_id=${oid} AND name='bound'`).scope
  const snapshot = () => ({ settings: settings(), agents: rig.sql(`SELECT name,account,pending_account,pending_switch,scope,row_version FROM ot.agents WHERE org_id=${oid} ORDER BY id`),
    accounts: rig.sql('SELECT id,provider FROM ot.accounts ORDER BY id'), removed: rig.sql('SELECT id FROM ot.removed_accounts ORDER BY id'),
    events: rig.sql(`SELECT id,op,detail FROM ot.events WHERE org_id=${oid} ORDER BY id`) })
  const capture = fn => fn().then(out => ({ ok: true, out }), e => ({ ok: false, status: e.status, text: e.message }))
  async function account() { return (await rig.api('POST', '/api/accounts', { provider: 'claude', kind: 'managed' })).id }
  async function bind(k) {
    await rig.op({ op: 'account', node: 'bound', account: k })
    await rig.api('POST', `/api/orgs/${rig.org}/settings`, { default_account: k, auto_resume: false })
    await rig.waitFor(() => rig.sql('SELECT id FROM ot.turns WHERE ended_at IS NULL').length === 0, { what: 'bound idle Claude seat' })
  }
  function session() {
    const { port, password } = rig.pgConn()
    const child = spawn(path.join(rig.run.pgBin, 'psql.exe'), ['-X', '-q', '-At', '-v', 'ON_ERROR_STOP=1', '-h', '127.0.0.1',
      '-p', String(port), '-U', 'orgtree_admin', '-d', 'orgtree_engine'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PGPASSWORD: password, PGCLIENTENCODING: 'UTF8', PGCONNECT_TIMEOUT: '10' } })
    let stdout = '', stderr = ''
    child.stdout.on('data', b => { stdout += b }); child.stderr.on('data', b => { stderr += b })
    const exited = new Promise(resolve => child.on('close', code => resolve({ code, stdout, stderr })))
    return { child, exited, output: () => stdout }
  }
  async function barrier(key) {
    const s = session()
    s.child.stdin.write(`SELECT pg_advisory_lock(${key});\n\\echo READY\n`)
    await rig.waitFor(() => s.output().includes('READY'), { timeout: 10000, every: 50, what: 'synthetic late-scan barrier holder' })
    return async () => { s.child.stdin.end(`SELECT pg_advisory_unlock(${key});\n\\q\n`); const out = await s.exited; if (out.code !== 0) throw new Error(out.stderr) }
  }
  for (const [i, route] of ['approval', 'direct'].entries()) {
    const k = await account(), key = 89530 + i, dir = path.join(rig.data, 'removal-proof', route)
    await bind(k)
    p.check(`${route}: qualifying idle Claude K/P/O state exists`, settings().default_account === k
      && rig.one(`SELECT account,tier FROM ot.agents WHERE id=${rig.agentRow('bound').id}`).account === k
      && !rig.sql('SELECT id FROM ot.turns WHERE ended_at IS NULL').length)
    let row
    if (route === 'approval') {
      const ask = await rig.tool('bound', 'orgtree_request_scope', { items: [{ kind: 'dir', path: dir, mode: 'rw' }], reason: 'Synthetic removal schedule' })
      if (!ask.ok) throw new Error(ask.text)
      row = rig.one(`SELECT uid,rev,body FROM ot.asks WHERE agent_id=${rig.agentRow('bound').id} AND status='open' ORDER BY id DESC LIMIT 1`)
      if (!row) throw new Error(`scope request fixture has no open row: ${ask.text}`)
    }
    // This event is inserted after the bound agent's rebind and before the
    // org-default scan. The removal still owns K and P here.
    rig.exec(`CREATE FUNCTION ot.removal_barrier() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.op='account_removed' AND NEW.detail->>'removed_account'=${q(k)} THEN PERFORM pg_advisory_xact_lock(${key}); END IF;
      RETURN NEW; END $$;
      CREATE TRIGGER removal_barrier BEFORE INSERT ON ot.events FOR EACH ROW EXECUTE FUNCTION ot.removal_barrier()`)
    const release = await barrier(key)
    let removal, folder, binder
    try {
      removal = capture(() => rig.api('DELETE', `/api/accounts/${k}`))
      const paused = await rig.waitFor(() => rig.one(`SELECT pid FROM pg_locks WHERE locktype='advisory' AND objid=${key} AND NOT granted`),
        { timeout: 15000, every: 100, what: 'removal before late default-org scan' })
      folder = capture(() => row ? rig.api('POST', `/api/orgs/${rig.org}/nodes/bound/batch`, { revs: { scope: row.rev }, scope: row.body.items.map(() => 'approve') })
        : rig.api('POST', `/api/orgs/${rig.org}/nodes/bound/scope`, { add_dirs: [...raw().add_dirs, { path: dir, mode: 'rw' }] }))
      const wait = await rig.waitFor(() => rig.one(`SELECT pid,query,wait_event,pg_blocking_pids(pid) AS blockers FROM pg_stat_activity
        WHERE ${paused.pid}=ANY(pg_blocking_pids(pid)) AND wait_event='transactionid'`),
        { timeout: 15000, every: 100, what: 'folder owns org and waits for removal agent' })
      p.check(`${route}: controlled opposing acquisition is actually reached`, /FROM ot\.agents\b/i.test(wait.query), wait)
      // Cached stale binder enters while removal owns the account. It must
      // wait; then either get rebound on a removal retry or fail after delete.
      const s = session()
      s.child.stdin.end(`UPDATE ot.agents SET pending_account=jsonb_build_object('account',${q(k)}) WHERE org_id=${oid} AND name='binder';\n\\q\n`)
      binder = s.exited
      const blocked = await rig.waitFor(() => rig.one(`SELECT pid,query FROM pg_stat_activity WHERE ${paused.pid}=ANY(pg_blocking_pids(pid))
        AND query LIKE 'UPDATE ot.agents SET pending_account=%' AND wait_event='transactionid'`),
        { timeout: 10000, every: 100, what: 'account reference writer drains behind exclusive account lock' })
      p.check(`${route}: account-reference guard blocks stale concurrent binder`, !!blocked, blocked)
    } finally {
      await release()
      const results = await Promise.all([removal, folder].filter(Boolean))
      const reference = binder ? await binder : null
      rig.exec('DROP TRIGGER removal_barrier ON ot.events; DROP FUNCTION ot.removal_barrier()')
      p.check(`${route}: real removal and folder routes both commit`, results.length === 2 && results.every(r => r.ok), results)
      p.check(`${route}: folder intent and default rebound persist together`, settings().default_account === 'claude/primary'
        && settings().dirs.some(d => d.path === dir && d.mode === 'rw') && raw().add_dirs.some(d => d.path === dir), settings())
      const refs = rig.sql(`SELECT id FROM ot.agents WHERE account=${q(k)} OR pending_account->>'account'=${q(k)} OR pending_switch->>'account'=${q(k)}`)
      p.check(`${route}: tombstone and guards leave no dangling account references`, !rig.one(`SELECT id FROM ot.accounts WHERE id=${q(k)}`)
        && !!rig.one(`SELECT id FROM ot.removed_accounts WHERE id=${q(k)}`) && refs.length === 0
        && reference && (reference.code === 0 || /was removed/.test(reference.stderr)), { refs, binder: reference })
      p.check(`${route}: rolled-back retry emits only committed removal event`, rig.one(`SELECT count(*)::int AS n FROM ot.events WHERE op='account_removed' AND detail->>'removed_account'=${q(k)} AND subject_agent_id=${rig.agentRow('bound').id}`).n === 1)
    }
    if (route === 'approval') p.check('approval answer is durable and request settled', rig.one(`SELECT status FROM ot.asks WHERE uid=${q(row.uid)}`).status === 'answered'
      && !!rig.one(`SELECT uid FROM ot.mail WHERE recipient_agent_id=${rig.agentRow('bound').id} AND sender='@user' AND kind='decision' ORDER BY id DESC LIMIT 1`))
  }
  // Failure after rebind/default update must roll the entire removal back.
  const rollbackK = await account()
  await bind(rollbackK)
  rig.exec(`UPDATE ot.agents SET pending_account=jsonb_build_object('account',${q(rollbackK)}),pending_switch=jsonb_build_object('tier','haiku','account',${q(rollbackK)}) WHERE org_id=${oid} AND name='binder'`)
  const before = snapshot()
  rig.exec(`CREATE FUNCTION ot.removal_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF OLD.id=${q(rollbackK)} THEN RAISE EXCEPTION 'synthetic removal rollback'; END IF; RETURN OLD; END $$;
    CREATE TRIGGER removal_fail BEFORE DELETE ON ot.accounts FOR EACH ROW EXECUTE FUNCTION ot.removal_fail()`)
  let failed
  try { failed = await capture(() => rig.api('DELETE', `/api/accounts/${rollbackK}`)) }
  finally { rig.exec('DROP TRIGGER removal_fail ON ot.accounts; DROP FUNCTION ot.removal_fail()') }
  p.check('injected final removal failure refuses without partial commit', !failed.ok && failed.status >= 500, failed)
  p.check('removal rollback restores account/default/bindings/queues/versions/events/tombstone', JSON.stringify(snapshot()) === JSON.stringify(before))
  const success = await capture(() => rig.api('DELETE', `/api/accounts/${rollbackK}`))
  p.check('ordinary retry after injected failure clears current and queued references', success.ok && !rig.one(`SELECT id FROM ot.accounts WHERE id=${q(rollbackK)}`)
    && !rig.one(`SELECT id FROM ot.agents WHERE account=${q(rollbackK)} OR pending_account->>'account'=${q(rollbackK)} OR pending_switch->>'account'=${q(rollbackK)}`))
  let stale
  try { rig.exec(`UPDATE ot.agents SET account=${q(rollbackK)} WHERE org_id=${oid} AND name='binder'`); stale = false }
  catch (e) { stale = /was removed/.test(e.message) }
  p.check('deleted-account reference is still rejected', stale)
  // fixture:none does not populate the ambient registry rows. Seed only a
  // synthetic primary metadata row so this is the real primary refusal path.
  rig.exec("INSERT INTO ot.accounts(id,provider,kind,label) VALUES('claude/primary','claude','managed','Synthetic primary') ON CONFLICT(id) DO NOTHING")
  const primary = await capture(() => rig.api('DELETE', '/api/accounts/claude%2Fprimary'))
  p.check('primary account remains protected', !primary.ok && primary.status === 409, primary)
  // Contention beyond the existing four-attempt budget must refuse atomically.
  // Release after 500ms so the predecessor's blocking path also finishes; it
  // must not be mistaken for the corrected bounded-refusal behavior.
  const busyK = await account()
  await bind(busyK)
  const beforeBusy = snapshot(), held = session()
  held.child.stdin.write(`BEGIN; SELECT id FROM ot.orgs WHERE id=${oid} FOR NO KEY UPDATE;\n\\echo READY\n`)
  await rig.waitFor(() => held.output().includes('READY'), { timeout: 10000, every: 50, what: 'controlled prolonged org contention' })
  const released = new Promise(resolve => setTimeout(() => {
    held.child.stdin.end('COMMIT;\n\\q\n'); resolve(held.exited)
  }, 500))
  const started = Date.now()
  let busy
  try { busy = await capture(() => rig.api('DELETE', `/api/accounts/${busyK}`)) }
  finally { await released }
  p.check('retry budget exhaustion refuses with lock error rather than waiting for holder', !busy.ok && /could not obtain lock/.test(busy.text ?? ''), { busy, elapsedMs: Date.now()-started })
  p.check('exhausted removal retries preserve all atomic state', JSON.stringify(snapshot()) === JSON.stringify(beforeBusy))
  const afterContention = rig.one(`SELECT id FROM ot.accounts WHERE id=${q(busyK)}`)
    ? await capture(() => rig.api('DELETE', `/api/accounts/${busyK}`)) : { ok: true }
  p.check('removal succeeds once contention is gone', afterContention.ok && !rig.one(`SELECT id FROM ot.accounts WHERE id=${q(busyK)}`))
  p.keep(rig, { agents: ['bound'], grep: /deadlock|removal|conflicted|scope|batch/i })
  return p.summary()
}
