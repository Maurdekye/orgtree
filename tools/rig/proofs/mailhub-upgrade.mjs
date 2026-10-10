// Proof: Orgtree's hosted mail hub upgraded in place (decision 71). The run
// starts with an older hub binary (`--from`, e.g. a 2.0.3 build) as the
// engine's hosted hub; then the engine stops, the run's copy of the binary is
// replaced with the newer one (`--to`, by default the one `up --hub` would
// pick: your cargo target's, else the submodule's release build), and the
// engine starts again on the same data and database, as installing a newer
// Orgtree does.
//   before   the hosted hub reports the older version; its database is at
//            that version's schema; two orgs register and mail flows
//   upgrade  after the restart the hub runs the new binary from the run's
//            copy, reports the new version and its features (unifiedpush),
//            and its database moved to the new schema (device_push exists)
//   kept     the hub keeps both addresses as they were (same fingerprints and
//            registration times: nobody registered anew) and every message
//            sent before, with its receipts
//   after    new mail both ways arrives; receipts go read
//   back     the older binary again (going back to an older Orgtree): its
//            hosted hub refuses the newer database and exits and leaves it
//            as it was; the Mail hub panel's error carries hub.log's reason;
//            the engine keeps running, and an @net send is refused at once
//            saying this computer's mail hub is not running; with the newer
//            binary again the hub is healthy, nothing was lost, and mail
//            flows again
//   killed   a hub killed from outside leaves no reason of its own: the
//            error says it exited without borrowing the earlier run's reason
//            from hub.log
// Run: node tools/rig/rig.mjs run tools/rig/proofs/mailhub-upgrade.mjs --from <older orgtree-mailhub.exe> [--to <newer orgtree-mailhub.exe>]

import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { hubExe } from '../lib.mjs'
import { Proof } from '../proof.mjs'

const fileSha = f => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex')
const versionOf = exe => {
  const out = spawnSync(exe, ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 20000 }).stdout || ''
  const m = /^orgtree-mailhub (\S+)/.exec(out.trim())
  if (!m) throw new Error(`${exe} is not an orgtree-mailhub binary (${out.trim()})`)
  return m[1]
}

export async function setup(flags) {
  if (typeof flags.from !== 'string') throw new Error('--from <older orgtree-mailhub.exe> is required')
  return { hub: path.resolve(flags.from) }
}

export default async function (rig, { flags }) {
  const p = new Proof('mailhub-upgrade')
  const OLD = path.resolve(flags.from)
  const NEW = hubExe(typeof flags.to === 'string' ? path.resolve(flags.to) : undefined)
  const [oldV, newV] = [versionOf(OLD), versionOf(NEW)]
  p.note(`from ${oldV} (${OLD}) to ${newV} (${NEW})`)
  rig.scenario({ default: { turns: [{ steps: [{ text: 'OK.' }] }] } })
  const settle = (what = 'turns to settle') => rig.waitFor(() => rig.sql('SELECT 1 FROM ot.turns WHERE ended_at IS NULL').length === 0,
    { what, timeout: 90000 })
  await settle('seed turns to settle')
  const A = rig.org
  const hub = rig.hubUrl
  const q = s => s.replace(/'/g, "''")
  const orgId = slug => rig.one(`SELECT id FROM ot.orgs WHERE slug = '${q(slug)}' AND state = 'active'`).id
  const netSlug = slug => rig.one(`SELECT net->'identity'->>'slug' AS s FROM ot.orgs WHERE slug = '${q(slug)}' AND state = 'active'`).s
  const hubSql = query => rig.sql(query, { db: 'orgtree_mailhub' })
  const schema = () => Number(hubSql(`SELECT (v #>> '{}')::bigint AS v FROM mailhub.hub_meta WHERE k = 'schema_version'`)[0]?.v)
  const pushTable = () => hubSql(`SELECT to_regclass('mailhub.device_push') IS NOT NULL AS present`)[0]?.present === true
  const healthz = () => fetch(hub + '/healthz', { signal: AbortSignal.timeout(10000) }).then(r => r.json())
  const hosting = () => rig.api('GET', '/api/desktop/hub')
  const healthy = version => rig.waitFor(async () => {
    const h = await hosting()
    return h.status?.healthy && h.status.hub_version === version ? h : null
  }, { what: `the hosted hub to answer as ${version}`, timeout: 120000 })
  const inRow = (slug, like) => rig.one(`SELECT uid, body, peer FROM ot.org_inbox
    WHERE org_id = ${orgId(slug)} AND dir = 'in' AND body LIKE '${q(like)}' ORDER BY id DESC LIMIT 1`)
  const outRow = (slug, like) => rig.one(`SELECT uid, state, net_id, last_err, tries FROM ot.org_inbox
    WHERE org_id = ${orgId(slug)} AND dir = 'out' AND body LIKE '${q(like)}' ORDER BY id DESC LIMIT 1`)
  const readBy = (slug, like) => rig.waitFor(() => outRow(slug, like)?.state === 'read' ? outRow(slug, like) : null,
    { what: `${like} to reach read`, timeout: 90000 })
  const hubProc = () => spawnSync('powershell', ['-NoProfile', '-Command',
    `Get-CimInstance Win32_Process -Filter "Name='orgtree-mailhub.exe'" | Where-Object { $_.ExecutablePath -like '${rig.dir.replace(/'/g, "''")}*' } | ForEach-Object { $_.ProcessId }`],
  { encoding: 'utf8', windowsHide: true }).stdout.trim()
  const hubLog = path.join(rig.data, 'mailhub', 'hub.log')
  const logSize = () => { try { return fs.statSync(hubLog).size } catch { return 0 } }
  const logSince = at => { try { return fs.readFileSync(hubLog).subarray(at).toString('utf8') } catch { return '' } }

  // ------------------------------------------------------------- before
  const h0 = await healthy(oldV)
  const z0 = await healthz()
  const schemaOld = schema()
  p.check(`the engine hosts the older hub (${oldV}) from the run's copy; its database is at schema ${schemaOld}, without the push table`,
    h0.status.hub_name === 'rig hub' && fileSha(rig.run.hub) === fileSha(OLD) && /^\d+$/.test(hubProc()) && schemaOld > 0 && !pushTable()
      && !(z0.features ?? []).includes('unifiedpush'), { status: h0.status, schema: schemaOld, features: z0.features })
  const B = (await rig.api('POST', '/api/orgs', { name: 'Rig Hub Peer', dirs: [] })).slug
  await rig.op({ op: 'hire', name: 'zoe', tier: 'haiku', title: 'B lead', grant: 5 }, { org: B })
  await settle()
  await rig.api('POST', `/api/orgs/${A}/settings`, { net_autoconnect: true })
  const registered = (slug, version) => rig.api('GET', `/api/orgs/${slug}`).then(t => (t.net?.hubs ?? []).find(h => h.connected && h.version === version))
  await rig.waitFor(() => registered(A, oldV), { what: 'A to register on the older hub', timeout: 90000 })
  await rig.waitFor(() => registered(B, oldV), { what: 'B to register on the older hub', timeout: 90000 })
  const [nA, nB] = [netSlug(A), netSlug(B)]
  const ids = () => hubSql(`SELECT slug, fingerprint, registered_at FROM mailhub.identities WHERE slug IN ('${q(nA)}', '${q(nB)}') ORDER BY slug`)
  const ids0 = ids()
  p.check('both orgs registered on the older hub by themselves', ids0.length === 2, ids0)
  const s1 = await rig.tool('boss', 'orgtree_message', { to: `@net:${nB}`, body: 'PROOF-UP-1 before the upgrade, A to B' })
  await rig.waitFor(() => inRow(B, 'PROOF-UP-1%'), { what: 'B to receive PROOF-UP-1', timeout: 60000 })
  const read1 = await readBy(A, 'PROOF-UP-1%')
  p.check('mail A to B through the older hub arrives and its receipts go read', s1.ok && read1.state === 'read', read1)
  const msgs = () => hubSql(`SELECT id, state, delivered_at, read_at FROM mailhub.messages ORDER BY id`)
  const msgs0 = msgs()

  // ------------------------------------------------------------ upgrade
  let t0 = Date.now()
  await rig.restart({ hub: NEW })
  const h1 = await healthy(newV)
  const upMs = Date.now() - t0
  const z1 = await healthz()
  const schemaNew = schema()
  p.check(`after the restart the hosted hub runs the new binary from the run's copy and reports ${newV} with the unifiedpush feature`,
    fileSha(rig.run.hub) === fileSha(NEW) && /^\d+$/.test(hubProc()) && z1.version === newV && (z1.features ?? []).includes('unifiedpush'),
    { status: h1.status, features: z1.features })
  p.check(`its database moved from schema ${schemaOld} to ${schemaNew} (the push table exists)`, schemaNew > schemaOld && pushTable(),
    { before: schemaOld, after: schemaNew })
  p.note(`engine stop, binary swap, engine start and the upgraded hub healthy: ${upMs} ms`)
  const ids1 = ids()
  p.check('the hub kept both addresses as they were (same fingerprints and registration times: nobody registered anew)',
    JSON.stringify(ids1) === JSON.stringify(ids0), { before: ids0, after: ids1 })
  const msgs1 = msgs()
  p.check('every message sent before the upgrade is still on the hub with its receipts',
    msgs0.length > 0 && msgs0.every(m => msgs1.some(n => n.id === m.id && n.state === m.state && n.delivered_at === m.delivered_at && n.read_at === m.read_at)),
    { before: msgs0.length, after: msgs1.length })
  await rig.waitFor(() => registered(A, newV), { what: 'A to reconnect to the upgraded hub', timeout: 90000 })
  await rig.waitFor(() => registered(B, newV), { what: 'B to reconnect to the upgraded hub', timeout: 90000 })
  p.check('both orgs reconnect to the upgraded hub with the addresses they had', netSlug(A) === nA && netSlug(B) === nB, { A: nA, B: nB })

  // -------------------------------------------------------------- after
  const s2 = await rig.tool('boss', 'orgtree_message', { to: `@net:${nB}`, body: 'PROOF-UP-2 after the upgrade, A to B' })
  await rig.waitFor(() => inRow(B, 'PROOF-UP-2%'), { what: 'B to receive PROOF-UP-2', timeout: 60000 })
  const read2 = await readBy(A, 'PROOF-UP-2%')
  const s3 = await rig.tool('zoe', 'orgtree_message', { to: `@net:${nA}`, body: 'PROOF-UP-3 after the upgrade, B to A' }, { org: B })
  const got3 = await rig.waitFor(() => inRow(A, 'PROOF-UP-3%'), { what: 'A to receive PROOF-UP-3', timeout: 60000 })
  p.check('after the upgrade mail flows both ways and receipts go read', s2.ok && read2.state === 'read' && s3.ok && got3.peer === `@net:${nB}`,
    { a_to_b: read2, b_to_a: got3 })

  // --------------------------------------------------------------- back
  const msgs2 = msgs()
  const at = logSize()
  await rig.restart({ hub: OLD })
  const refused = await rig.waitFor(async () => {
    const h = await hosting()
    return !h.status?.running && h.error ? h : null
  }, { what: 'the older hub to give up on the newer database', timeout: 120000 })
  const why = logSince(at)
  p.check('going back to the older binary: the hosted hub refuses the newer database and exits; hub.log says why',
    /newer than this hub understands/.test(why) && !hubProc(), { error: refused.error, log: why.split(/\r?\n/).filter(l => /newer than/.test(l)).slice(0, 2) })
  p.check('the Mail hub panel\'s error names hub.log\'s reason (not a guess about the port)',
    /^the hub process exited \(code 1\): could not prepare the database: the database schema is version \d+, newer than this hub understands/.test(refused.error)
      && !/another service may already hold port/.test(refused.error), refused.error)
  p.check('the database was left as it was (still the new schema, same addresses and messages)',
    schema() === schemaNew && JSON.stringify(ids()) === JSON.stringify(ids0) && JSON.stringify(msgs()) === JSON.stringify(msgs2),
    { schema: schema(), messages: msgs2.length })
  // without its hub the engine knows no peer after a restart: @net mail is
  // refused at once (not queued), and everything else keeps working
  const down = await rig.api('GET', `/api/orgs/${A}`)
  t0 = Date.now()
  const s4 = await rig.tool('boss', 'orgtree_message', { to: `@net:${nB}`, body: 'PROOF-UP-4 while the hub is down' })
  const answeredMs = Date.now() - t0
  p.check('the engine keeps working without its hub: the org answers (no hub connected) and an @net send is refused at once, saying this computer\'s mail hub is not running',
    !(down.net?.hubs ?? []).some(h => h.connected) && answeredMs < 10000 && !s4.ok && /^this computer's mail hub is not running, so @net:/.test(s4.text)
      && !inRow(B, 'PROOF-UP-4%'), { ok: s4.ok, answer: s4.text, ms: answeredMs })
  t0 = Date.now()
  await rig.restart({ hub: NEW })
  await healthy(newV)
  await rig.waitFor(() => registered(A, newV), { what: 'A to reconnect once the hub is back', timeout: 90000 })
  await rig.waitFor(() => registered(B, newV), { what: 'B to reconnect once the hub is back', timeout: 90000 })
  const s5 = await rig.tool('boss', 'orgtree_message', { to: `@net:${nB}`, body: 'PROOF-UP-5 the hub is back' })
  await rig.waitFor(() => inRow(B, 'PROOF-UP-5%'), { what: 'B to receive PROOF-UP-5 once the hub is back', timeout: 90000 })
  p.check(`with the newer binary again the hub is healthy (${newV}, schema ${schema()}), nothing was lost, and mail flows again`,
    s5.ok && schema() === schemaNew && JSON.stringify(ids()) === JSON.stringify(ids0)
      && msgs2.every(m => msgs().some(n => n.id === m.id && n.state === m.state)), { ms: Date.now() - t0 })

  // ------------------------------------------------------------- killed
  // hub.log still ends this run's part with nothing fatal, and holds the older
  // hub's refusal from before: the error must not borrow that
  const pid = hubProc()
  spawnSync('taskkill', ['/F', '/PID', pid], { windowsHide: true })
  const killed = await rig.waitFor(async () => {
    const h = await hosting()
    return !h.status?.running && h.error ? h : null
  }, { what: 'the engine to notice the hub was killed', timeout: 60000 })
  p.check('a hub killed from outside: the error says it exited, without borrowing the earlier run\'s reason from hub.log',
    /^\d+$/.test(pid) && /^the hub process exited \(code [^)]*\) — see mailhub\/hub\.log/.test(killed.error) && !/newer than/.test(killed.error)
      && /newer than this hub understands/.test(fs.readFileSync(hubLog, 'utf8')), killed.error)

  p.keep(rig, { agents: ['boss', 'zoe'], grep: /mail hub|network|hub/i })
  return p.summary()
}
