// Proof: a Muse removal that releases a freeze gives back the request it
// held (independent review R4, 2026-10-13), on the reviewer's schedule and
// the real routes, on the fake `muse serve`:
//   1. s1 and s2 (Wonder Full on A1 and A2) hit a quota wall: each limit
//      freeze holds its request, and marks its login limited; s3 (on A1) is
//      idle. Removing A1 and A2 while no other login can take Full leaves all
//      three unbound and frozen (cause `account`), s1's and s2's freezes
//      keeping their requests, s3's holding none.
//   2. The ordinary account operation binds each to B (which offers Full):
//      it keeps that freeze, request included.
//   3. With C offering Full too, B (also the org's default) is removed while
//      an org-first writer holds the org row: the removal's first attempt
//      reaches its late `FOR UPDATE NOWAIT` org scan, rolls back and retries
//      (a barrier in an event trigger orders the two, as the base's
//      folder-grants-account-removal proof does). The seats move to C, their
//      freezes released: s1's and s2's requests come back as exactly one
//      wake mail each, committed with the move (none from the rolled-back
//      attempt); s1 runs on C with its request; s2, halted, stays halted with
//      its wake waiting, and runs it once when unhalted; s3 gets no mail.
// Run: node tools/rig/rig.mjs run tools/rig/proofs/muse-held-replay.mjs

import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { Proof } from '../proof.mjs'

const ALL = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']
const W = 'muse-wonder-1.0', F = 'muse-wonder-full-1.0'
/** a catalog of [modelId, variants] rows, the first the default */
const catalogOf = (...rows) => JSON.stringify({ source: 'providerCatalog', models: rows.map(([id, variants = ALL], i) => ({
  modelId: id, profileId: 'tbh', isDefault: i === 0, variants, defaultReasoningEffort: 'high', contextLimit: 1007997, outputLimit: 128000 })) })
const AGENTS = ['s1', 's2', 's3']
const GIVEN_BACK = 'was removed; you now run on the account'

export default async function (rig) {
  const p = new Proof('muse-held-replay')
  const resetMs = Date.now() + 2 * 3600 * 1000
  rig.scenario({ agents: Object.fromEntries(AGENTS.map((n) => [n, { turns: [
    { name: 'given back', match: GIVEN_BACK, steps: [{ text: 'Picking the held request up again.' }] },
    { name: 'wall', match: 'PROOF-WALL', once: true, steps: [{ text: 'Trying.' }, { quota: { resetsAtMs: resetMs } }] },
  ] }])), default: { turns: [{ name: 'default', steps: [{ text: 'OK.' }] }] } })
  await rig.waitFor(() => rig.sql('SELECT 1 FROM ot.turns WHERE ended_at IS NULL').length === 0, { what: 'seed turns to settle', timeout: 60000 })
  await rig.waitFor(async () => (await rig.api('GET', '/api/providers'))?.providers?.find((x) => x.id === 'muse' && x.muse?.catalog),
    { what: 'Muse discovery', timeout: 60000 })

  // ---------------------------------------------------------------- fixtures
  // the user's own login offers Wonder only: never a target for Full
  fs.writeFileSync(path.join(rig.fakeDir, 'muse-catalog.json'), catalogOf([W]))
  await rig.api('GET', '/api/muse/usage?force=true')
  const profile = async (rows) => {
    const id = (await rig.api('POST', '/api/accounts', { provider: 'muse', kind: 'managed' })).id
    const dir = rig.one(`SELECT config_dir FROM ot.accounts WHERE id = '${id}'`)?.config_dir
    fs.mkdirSync(path.join(dir, 'config'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'config', 'muse-catalog.json'), catalogOf(...rows))
    await rig.api('GET', `/api/accounts/${id}/identity`)
    return { id, dir }
  }
  const settled = (pr) => pr.then((r) => ({ ok: true, r }), (e) => ({ ok: false, status: e.status, detail: e.body?.detail ?? e.message }))
  const op = (body) => settled(rig.op(body))
  const row = (name) => rig.one(`SELECT id, account, frozen, halt, session_id FROM ot.agents WHERE name = '${name}' AND state = 'live'`) ?? {}
  const held = (frozen) => JSON.stringify(frozen?.resume_texts ?? []).includes('PROOF-WALL')
  /** the wake mails that gave a seat's held request back */
  const givenBack = (id) => rig.sql(`SELECT uid, state, body FROM ot.mail WHERE recipient_agent_id = ${id} AND sender = '@system'
    AND body LIKE '%${GIVEN_BACK}%' ORDER BY id`)
  const prompts = (name) => rig.fakeLog(name).filter((l) => l.kind === 'turn').map((l) => l.prompt ?? '')
  const q = (s) => `'${String(s).replaceAll("'", "''")}'`

  /** a psql session of the run's cluster (stdin-driven) */
  function session() {
    const { port, password } = rig.pgConn()
    const child = spawn(path.join(rig.run.pgBin, 'psql.exe'), ['-X', '-q', '-At', '-v', 'ON_ERROR_STOP=1', '-h', '127.0.0.1',
      '-p', String(port), '-U', 'orgtree_admin', '-d', 'orgtree_engine'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PGPASSWORD: password, PGCLIENTENCODING: 'UTF8', PGCONNECT_TIMEOUT: '10' } })
    let stdout = '', stderr = ''
    child.stdout.on('data', (b) => { stdout += b }); child.stderr.on('data', (b) => { stderr += b })
    const exited = new Promise((resolve) => child.on('close', (code) => resolve({ code, stdout, stderr })))
    return { child, exited, output: () => stdout }
  }

  const PW = await profile([[W]])
  // a quota wall marks its login limited for the model: each walled seat gets its own login
  const A1 = await profile([[F]])
  const A2 = await profile([[F]])
  const hires = {}
  for (const [n, login] of [['s1', A1], ['s2', A2], ['s3', A1]]) {
    hires[n] = await op({ op: 'hire', name: n, parent: 'boss', tier: 'wonder-full', title: 'Muse replay agent', account: login.id })
  }
  const ids = Object.fromEntries(AGENTS.map((n) => [n, row(n).id]))

  // ---------------------------------------------------------------- 1. quota walls, then A1 and A2 removed with no Full login left
  for (const n of ['s1', 's2']) {
    await rig.userMail(n, `PROOF-WALL: ${n}, please do the thing.`)
    await rig.waitFor(() => row(n).frozen, { what: `${n}'s wall`, timeout: 45000 })
  }
  const walls = { s1: row('s1').frozen, s2: row('s2').frozen }
  // each limited login is no target for the other's seats
  const dA = [await settled(rig.api('DELETE', `/api/accounts/${A1.id}`)), await settled(rig.api('DELETE', `/api/accounts/${A2.id}`))]
  const stranded = Object.fromEntries(AGENTS.map((n) => [n, row(n)]))

  // ---------------------------------------------------------------- 2. the ordinary account operation binds them to B
  const B = await profile([[F]])
  const binds = {}
  for (const n of AGENTS) binds[n] = await op({ op: 'account', node: n, account: B.id })
  const bound = Object.fromEntries(AGENTS.map((n) => [n, row(n)]))
  p.check('setup, on the routes: a quota wall holds the request; removing A1 and A2 with no Full login left freezes s1/s2 (cause account) keeping it, s3 holding none; the account operation binds all to B and keeps those freezes',
    AGENTS.every((n) => hires[n].ok && binds[n].ok) && ['s1', 's2'].every((n) => walls[n]?.limit === true && held(walls[n]))
      && dA.every((d) => d.ok) && AGENTS.every((n) => stranded[n].account === null && stranded[n].frozen?.cause === 'account')
      && held(stranded.s1.frozen) && held(stranded.s2.frozen) && !held(stranded.s3.frozen)
      && AGENTS.every((n) => bound[n].account === B.id && bound[n].frozen?.cause === 'account')
      && held(bound.s1.frozen) && held(bound.s2.frozen),
    { walls, dA, stranded, binds, bound })

  // ---------------------------------------------------------------- 3. B removed (C offers Full) through a rolled-back first attempt
  const C = await profile([[F]])
  await op({ op: 'halt', nodes: ['s2'] })
  const halted = row('s2').halt
  await rig.api('POST', `/api/orgs/${rig.org}/settings`, { default_account: B.id })
  const oid = rig.one(`SELECT id FROM ot.orgs WHERE slug = ${q(rig.org)}`).id
  const mailsBefore = Object.fromEntries(AGENTS.map((n) => [n, givenBack(ids[n]).length]))
  const turnsBefore = { s1: rig.turns('s1').length, s2: rig.turns('s2').length }
  const key = 90417
  rig.exec(`CREATE FUNCTION ot.replay_barrier() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.op = 'account_removed' AND NEW.detail->>'removed_account' = ${q(B.id)} THEN PERFORM pg_advisory_xact_lock(${key}); END IF;
    RETURN NEW; END $$;
    CREATE TRIGGER replay_barrier BEFORE INSERT ON ot.events FOR EACH ROW EXECUTE FUNCTION ot.replay_barrier()`)
  const holder = session()
  holder.child.stdin.write(`SELECT pg_advisory_lock(${key});\n\\echo READY\n`)
  let removal, writer, paused, blocked
  try {
    await rig.waitFor(() => holder.output().includes('READY'), { timeout: 10000, every: 50, what: 'barrier holder' })
    removal = settled(rig.api('DELETE', `/api/accounts/${B.id}`))
    // the removal holds the seats' rows and waits at its first event, its
    // released freezes and their given-back mail written but not committed
    paused = await rig.waitFor(() => rig.one(`SELECT pid FROM pg_locks WHERE locktype = 'advisory' AND objid = ${key} AND NOT granted`),
      { timeout: 15000, every: 100, what: 'removal at its first event' })
    // an org-first writer (as a settings or folder save): the org row, then a seat row the removal holds
    const w = session()
    w.child.stdin.end(`BEGIN;\nSELECT 1 FROM ot.orgs WHERE id = ${oid} FOR NO KEY UPDATE;\nUPDATE ot.agents SET row_version = row_version WHERE id = ${ids.s1};\nCOMMIT;\n\\q\n`)
    writer = w.exited
    blocked = await rig.waitFor(() => rig.one(`SELECT pid, query FROM pg_stat_activity WHERE ${paused.pid} = ANY(pg_blocking_pids(pid))
      AND wait_event = 'transactionid'`), { timeout: 15000, every: 100, what: 'org-first writer waiting on the removal' })
  } finally {
    holder.child.stdin.end(`SELECT pg_advisory_unlock(${key});\n\\q\n`)
    await holder.exited
  }
  const dB = await removal
  const wrote = await writer
  rig.exec('DROP TRIGGER replay_barrier ON ot.events; DROP FUNCTION ot.replay_barrier()')
  // the only removal in this run that met a conflict
  const retried = /account removal conflicted; retrying entire transaction/.test(rig.engineLog())
  const events = rig.sql(`SELECT a.name FROM ot.events e JOIN ot.agents a ON a.id = e.subject_agent_id
    WHERE e.op = 'account_removed' AND e.detail->>'removed_account' = ${q(B.id)}`).map((r) => r.name).sort()
  const s1mail = givenBack(ids.s1)
  p.check("replay: B's removal, retried after its first attempt rolled back (NOWAIT on the org-first writer's row), moves s1 to C and gives back its request in exactly one wake mail",
    !!blocked && wrote?.code === 0 && retried && dB.ok && JSON.stringify(events) === JSON.stringify(['s1', 's2', 's3'])
      && row('s1').account === C.id && row('s1').frozen === null && s1mail.length - mailsBefore.s1 === 1
      && s1mail.at(-1)?.body.includes('PROOF-WALL') && (dB.r?.rebound ?? []).some((x) => x.node === 's1' && x.replayed === true),
    { blocked, writer: wrote, retried, dB, events, s1: row('s1'), s1mail })
  await rig.waitTurns('s1', turnsBefore.s1 + 1, { timeout: 45000 }).catch(() => null)
  const start = rig.fakeLog('s1').filter((l) => l.kind === 'start').at(-1)
  const s1replays = prompts('s1').slice(1).filter((t) => t.includes('PROOF-WALL'))
  p.check('replay: s1 runs on C with its held request, once',
    s1replays.length === 1 && s1replays[0].includes(GIVEN_BACK) && (start?.xdg_config ?? '').includes(path.basename(C.dir))
      && givenBack(ids.s1).length - mailsBefore.s1 === 1, { prompts: prompts('s1'), start: start?.xdg_config ?? null })
  const s2mid = { row: row('s2'), mail: givenBack(ids.s2), turns: rig.turns('s2').length }
  await op({ op: 'unhalt', nodes: ['s2'] })
  await rig.waitTurns('s2', turnsBefore.s2 + 1, { timeout: 45000 }).catch(() => null)
  const s2replays = prompts('s2').slice(1).filter((t) => t.includes('PROOF-WALL'))
  p.check('halt: s2, halted, stays halted with its freeze released and its request waiting as one mail (no turn); unhalted, it runs it once',
    !!halted && JSON.stringify(s2mid.row.halt) === JSON.stringify(halted) && s2mid.row.account === C.id && s2mid.row.frozen === null
      && s2mid.mail.length - mailsBefore.s2 === 1 && s2mid.mail.at(-1)?.state === 'pending' && s2mid.turns === turnsBefore.s2
      && s2replays.length === 1 && givenBack(ids.s2).length - mailsBefore.s2 === 1, { halted, s2mid, prompts: prompts('s2') })
  p.check('control: s3, whose freeze held no request, is moved and released with no wake mail',
    row('s3').account === C.id && row('s3').frozen === null && givenBack(ids.s3).length === mailsBefore.s3, { s3: row('s3') })

  await rig.api('POST', `/api/orgs/${rig.org}/settings`, { default_account: '' })
  p.keep(rig, { agents: AGENTS, grep: /muse|account|removed|frozen|replay|retrying/i })
  return p.summary()
}
