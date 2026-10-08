// Proof: Orgtree 4.0.2 against mail hub v2.0.0, through the real 4.x net
// client (src/net.rs) and the engine hosting the v2 binary (src/mailhub.rs).
// `up --hub`: the engine hosts orgtree-mailhub.exe inside the run, with its
// own role and database in the run's cluster and a free loopback port; the
// run's network mail reaches that hub and nothing else.
//   hosting  the hub runs from the engine and reports version 2.0.0; its role
//            and database exist and that role cannot connect to the engine's
//            database; its connections stay within HUB_DB_POOL=8; the earlier
//            hub's store (hub.sqlite3, written here in v1's schema) is
//            imported at the first start and kept, and a message v1 had
//            queued is delivered by v2
//   mail     two orgs register, long-poll and acknowledge; receipts go sent,
//            delivered, read; an attachment goes up and down byte-identical
//   people   a person registered over HTTP (as Hubchat does) is listed by
//            orgtree_list_orgs with kind person; each hub's version is shown
//            (Connections data, orgtree_list_orgs, the address probe)
//   replies  an agent's reply over @net, the org inbox panel's Reply, a
//            person's reply and a reply to a person all carry reply_to through
//            the hub and arrive quoted (IN REPLY TO); an internal reply; the
//            id at the end of each FROM line; refusals
//   long     30,000 characters and 100 KB from a person, 40,000 characters
//            between the two engines: they arrive whole (the longest as
//            message.txt beside its preview)
//   forgot   the hub forgets an org (remove-address): the engine registers
//            again by itself and mail flows
//   1 GiB    (--big) one whole 1 GiB file between the orgs through the hub,
//            sha256 checked and timed; with one byte of text more it is
//            refused at send (the limit is per message)
// Run: node tools/rig/rig.mjs run tools/rig/proofs/mailhub-v2.mjs [--hub <orgtree-mailhub.exe>] [--big]

import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import { DatabaseSync } from 'node:sqlite'

import { TOKEN_HEADER } from '../lib.mjs'
import { Proof } from '../proof.mjs'

const sha = b => crypto.createHash('sha256').update(b).digest('hex')
const LEGACY = {
  org: { slug: 'legacy-org.old.aaaaaa', secret: 'a1'.repeat(32) },
  chat: { slug: 'legacy-chat.old.bbbbbb', secret: 'b2'.repeat(32) },
}

/** The earlier hub's store as v1 left it in <data>\mailhub (v1's schema,
 * orgtree-mailhub at 79a7c51): two addresses and a message still queued. */
function v1Store(dir) {
  fs.mkdirSync(path.join(dir, 'blobs'), { recursive: true })
  const db = new DatabaseSync(path.join(dir, 'hub.sqlite3'))
  db.exec(`CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT);
    CREATE TABLE orgs (slug TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, org_name TEXT, username TEXT, blurb TEXT,
      registered_at TEXT NOT NULL, last_seen TEXT, kind TEXT NOT NULL DEFAULT 'org');
    CREATE TABLE messages (id TEXT PRIMARY KEY, from_slug TEXT NOT NULL, to_slug TEXT NOT NULL, body TEXT NOT NULL, kind TEXT,
      thread_id TEXT, sent_at TEXT, received_at TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'queued', fetched_at TEXT,
      delivered_at TEXT, read_at TEXT, receipts_pushed INTEGER NOT NULL DEFAULT 1, attachments TEXT NOT NULL DEFAULT '[]');
    CREATE TABLE attachments (id TEXT PRIMARY KEY, owner_slug TEXT NOT NULL, name TEXT NOT NULL, bytes INTEGER NOT NULL,
      created_at TEXT NOT NULL, message_id TEXT);`)
  const at = new Date(Date.now() - 3600_000).toISOString()
  const org = db.prepare('INSERT INTO orgs VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
  org.run(LEGACY.org.slug, sha(LEGACY.org.secret), 'Legacy Org', 'old', 'from the v1 store', at, at, 'org')
  org.run(LEGACY.chat.slug, sha(LEGACY.chat.secret), 'Legacy Chat', 'old', '', at, at, 'chat')
  db.prepare('INSERT INTO messages (id, from_slug, to_slug, body, kind, sent_at, received_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run('legacy-queued-1', LEGACY.chat.slug, LEGACY.org.slug, 'LEGACY-QUEUED from the v1 store', 'message', at, at)
  db.close()
}

export async function setup(flags) {
  return { hub: flags.hub ?? true, prepare: ({ data }) => v1Store(path.join(data, 'mailhub')) }
}

export default async function (rig, { flags }) {
  const p = new Proof('mailhub-v2')
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
  const call = async (method, route, { auth, body, raw } = {}) => {
    const res = await fetch(hub + route, {
      method, headers: { ...(auth ? { 'X-Org-Auth': `${auth.slug}:${auth.secret}` } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(60000),
    })
    const text = await res.text()
    let json = null
    try { json = JSON.parse(text) } catch { /* not JSON */ }
    return raw ? { status: res.status, json, text } : json
  }
  const tryApi = (method, route, body) => rig.api(method, route, body).then(json => ({ ok: true, json }),
    e => ({ ok: false, status: e.status, detail: String(e.body?.detail ?? e.message).slice(0, 300) }))
  const inRow = (slug, like) => rig.one(`SELECT uid, body, attachments, reply_to, net_id, peer FROM ot.org_inbox
    WHERE org_id = ${orgId(slug)} AND dir = 'in' AND body LIKE '${q(like)}' ORDER BY id DESC LIMIT 1`)
  const outRow = (slug, like) => rig.one(`SELECT uid, state, reply_to, net_id, last_err, tries FROM ot.org_inbox
    WHERE org_id = ${orgId(slug)} AND dir = 'out' AND body LIKE '${q(like)}' ORDER BY id DESC LIMIT 1`)
  const mailOf = (slug, agent, like) => rig.one(`SELECT m.uid, m.state, m.body, m.reply_to, m.ev->>'variant' AS variant, m.net_id
    FROM ot.mail m JOIN ot.agents a ON a.id = m.recipient_agent_id
    WHERE a.org_id = ${orgId(slug)} AND a.name = '${q(agent)}' AND m.body LIKE '${q(like)}' ORDER BY m.id DESC LIMIT 1`)
  // the text an agent was given with a mail: its turn's prompt, or the
  // mid-turn handover (the fake CLI logs both)
  const promptWith = (agent, token) => {
    for (const l of rig.fakeLog(agent)) {
      const text = l.kind === 'turn' ? l.prompt : l.kind === 'hook_mail' ? l.text : null
      if (typeof text === 'string' && text.includes(token)) return text
    }
    return ''
  }
  const unescape = s => s

  // ------------------------------------------------------------ hosting
  const hosting = await rig.waitFor(async () => {
    const h = await rig.api('GET', '/api/desktop/hub')
    return h.status?.healthy ? h : null
  }, { what: 'the hosted hub to answer', timeout: 120000 })
  p.check('the engine hosts orgtree-mailhub.exe on the run\'s port and it reports version 2.0.0',
    hosting.status.address === hub && hosting.status.hub_version === '2.0.0' && hosting.status.hub_name === 'rig hub', hosting.status)
  const pg = rig.sql(`SELECT (SELECT count(*) FROM pg_roles WHERE rolname = 'orgtree_mailhub' AND rolcanlogin AND NOT rolsuper) AS role,
      (SELECT count(*) FROM pg_database d JOIN pg_roles r ON r.oid = d.datdba WHERE d.datname = 'orgtree_mailhub' AND r.rolname = 'orgtree_mailhub') AS db,
      has_database_privilege('orgtree_mailhub', 'orgtree_engine', 'CONNECT') AS engine_connect`, { db: 'postgres' })[0]
  p.check('its own login role and database (orgtree_mailhub, owned by that role); the role cannot connect to the engine\'s database',
    Number(pg.role) === 1 && Number(pg.db) === 1 && pg.engine_connect === false, pg)
  const creds = JSON.parse(fs.readFileSync(path.join(rig.data, 'pg', 'cluster', 'secrets', 'credentials.json'), 'utf8'))
  p.check('the role\'s password is kept with the cluster\'s other secrets', /^[0-9a-f]{32,}$/.test(creds.orgtree_mailhub ?? ''),
    { keys: Object.keys(creds) })
  const proc = spawnSync('powershell', ['-NoProfile', '-Command',
    `Get-CimInstance Win32_Process -Filter "Name='orgtree-mailhub.exe'" | Where-Object { $_.ExecutablePath -like '${rig.dir.replace(/'/g, "''")}*' } | ForEach-Object { $_.ProcessId }`],
  { encoding: 'utf8', windowsHide: true }).stdout.trim()
  p.check('the hub runs from the run\'s own copy of the binary, as the engine\'s child', /^\d+$/.test(proc), proc)

  const report = hosting.v2_import
  p.check('the first start imported the earlier hub\'s store (v2_import on the hosting page) and kept the file',
    report?.orgs === 2 && report.messages === 1 && report.mode === 'empty' && fs.existsSync(path.join(rig.data, 'mailhub', 'hub.sqlite3')), report)
  const legacyPoll = await call('POST', '/api/poll?wait=0', { auth: LEGACY.org })
  p.check('an address from the v1 store still signs in, and the message v1 had queued for it is delivered by v2',
    legacyPoll?.messages?.some(m => m.id === 'legacy-queued-1' && m.body.startsWith('LEGACY-QUEUED')), legacyPoll?.messages)

  // ------------------------------------------------------- registration
  const B = (await rig.api('POST', '/api/orgs', { name: 'Rig Hub Peer', dirs: [] })).slug
  await rig.op({ op: 'hire', name: 'zoe', tier: 'haiku', title: 'B lead', grant: 5 }, { org: B })
  await settle()
  // the fixture made A without a connection (a rig default); the Connections
  // toggle turns it on: this computer's hub joins A's list, as in 3.x
  const auto = await rig.api('POST', `/api/orgs/${A}/settings`, { net_autoconnect: true })
  const aHubs = rig.one(`SELECT net->'hubs' AS h FROM ot.orgs WHERE slug = '${q(A)}' AND state = 'active'`).h
  p.check('turning auto-connect on (the Connections toggle) adds this computer\'s hub to A\'s list, as 3.x did',
    aHubs?.[0]?.id === 'local' && aHubs[0].address === hub, { auto, hubs: aHubs })
  const registered = slug => rig.api('GET', `/api/orgs/${slug}`).then(t => (t.net?.hubs ?? []).find(h => h.connected && h.version === '2.0.0'))
  const hubA = await rig.waitFor(() => registered(A), { what: 'A to register on the hosted hub', timeout: 90000 })
  const hubB = await rig.waitFor(() => registered(B), { what: 'B to register on the hosted hub', timeout: 90000 })
  const [nA, nB] = [netSlug(A), netSlug(B)]
  p.check('both orgs registered on the hosted hub by themselves; the Connections data shows each hub\'s version',
    hubA.address !== undefined && hubB.version === '2.0.0', { A: { slug: nA, hub: hubA }, B: { slug: nB, hub: hubB } })
  const hubIds = hubSql(`SELECT slug, kind FROM mailhub.identities WHERE slug IN ('${q(nA)}', '${q(nB)}') ORDER BY slug`)
  p.check('the hub holds both addresses (kind org)', hubIds.length === 2 && hubIds.every(r => r.kind === 'org'), hubIds)

  // ------------------------------------------------------- a person
  const pat = { slug: `pat.person.${crypto.randomBytes(3).toString('hex')}`, secret: crypto.randomBytes(32).toString('hex') }
  const reg = await call('POST', '/api/register', { auth: pat, body: { slug: pat.slug, org_name: 'Pat Example', username: 'pat', blurb: 'a person', kind: 'person' } })
  p.check('a person registers over HTTP (as Hubchat does); the answer carries the hub\'s version', reg?.ok === true && reg.version === '2.0.0',
    { version: reg?.version, roster: reg?.roster?.length })
  const listed = await rig.waitFor(async () => {
    const r = await rig.tool('boss', 'orgtree_list_orgs', {})
    const remote = (r.json ?? JSON.parse(r.text)).remote
    return remote.find(x => x.slug === `@net:${pat.slug}`) && remote.find(x => x.slug === `@net:${nB}`) ? remote : null
  }, { what: 'orgtree_list_orgs to list the person and B', timeout: 60000 })
  const patRow = listed.find(x => x.slug === `@net:${pat.slug}`)
  p.check('orgtree_list_orgs lists the person with kind person, and under "remote" the hub with its version',
    patRow.kind === 'person' && patRow.name === 'Pat Example' && patRow.hubs?.[0]?.version === '2.0.0' && patRow.hubs[0].name === 'rig hub', patRow)
  p.check('the v1 store\'s addresses are listed too (imported roster)', listed.some(x => x.slug === `@net:${LEGACY.org.slug}`),
    listed.map(x => x.slug))
  const probe = await rig.api('GET', `/api/net/probe?address=${encodeURIComponent(hub)}`)
  p.check('the address probe shows the hub\'s version', probe.ok === true && probe.version === '2.0.0', probe)

  // ------------------------------------------------- mail and receipts
  let t0 = Date.now()
  const s1 = await rig.tool('boss', 'orgtree_message', { to: `@net:${nB}`, body: 'PROOF-NET-1 hello B, from boss' })
  const got1 = await rig.waitFor(() => inRow(B, 'PROOF-NET-1%'), { what: 'B to receive PROOF-NET-1', timeout: 60000 })
  const ms1 = Date.now() - t0
  p.check('@net mail A to B: queued, sent through the hub, delivered into B\'s org inbox', s1.ok && got1.peer === `@net:${nA}`, { send: s1.text, ms: ms1 })
  const zoe1 = await rig.waitFor(() => { const m = mailOf(B, 'zoe', 'PROOF-NET-1%'); return m?.state === 'delivered' ? m : null },
    { what: 'zoe (B\'s holder) to read PROOF-NET-1', timeout: 60000 })
  const read1 = await rig.waitFor(() => outRow(A, 'PROOF-NET-1%')?.state === 'read' ? outRow(A, 'PROOF-NET-1%') : null,
    { what: 'A\'s copy to reach read', timeout: 90000 })
  p.check('receipts: A\'s outgoing row went sent, delivered, read (zoe\'s turn read it)', read1.state === 'read', { zoe: zoe1.state, row: read1 })
  const hubMsg1 = hubSql(`SELECT state, fetched_at IS NOT NULL AS fetched, delivered_at, read_at FROM mailhub.messages WHERE id = '${q(read1.net_id)}'`)[0]
  p.check('the hub recorded custody (acknowledged) and both receipts', hubMsg1?.state === 'fetched' && hubMsg1.delivered_at && hubMsg1.read_at, hubMsg1)
  p.note(`PROOF-NET-1 reached B's org inbox ${ms1} ms after orgtree_message returned`)

  // attachment, from the user through A's org inbox panel
  const file = crypto.randomBytes(300 * 1024 + 7)
  const up = await fetch(`${rig.url}/api/orgs/${A}/org_inbox/upload?name=proof-file.bin&to=${encodeURIComponent('@net:' + nB)}`,
    { method: 'POST', headers: { [TOKEN_HEADER]: rig.token }, body: file }).then(r => r.json())
  const sA = await rig.api('POST', `/api/orgs/${A}/org_inbox/send`, { to: `@net:${nB}`, body: 'PROOF-ATT-1 a file', attachments: [up.id] })
  const att = await rig.waitFor(() => inRow(B, 'PROOF-ATT-1%'), { what: 'B to receive the file', timeout: 60000 })
  const landed = att.attachments?.[0]
  const same = landed && fs.existsSync(landed.path) && sha(fs.readFileSync(landed.path)) === sha(file)
  p.check('an attachment goes up and down through the hub byte-identical', same && landed.bytes === file.length, { sent: sA, landed })

  // ------------------------------------------------------------ replies
  // (a) an agent's reply over @net: zoe answers the mail she got
  const r1 = await rig.tool('zoe', 'orgtree_message', { to: `@net:${nA}`, body: 'PROOF-REPLY-1 zoe answers', reply_to: zoe1.uid }, { org: B })
  const back1 = await rig.waitFor(() => inRow(A, 'PROOF-REPLY-1%'), { what: 'A to receive zoe\'s reply', timeout: 60000 })
  const hubR1 = hubSql(`SELECT reply_to FROM mailhub.messages WHERE body LIKE 'PROOF-REPLY-1%'`)[0]
  p.check('agent reply over @net: the hub carried reply_to = the answered message\'s hub id', r1.ok && hubR1?.reply_to === read1.net_id,
    { tool: r1.text, hub: hubR1, answered: read1.net_id })
  const outA1 = outRow(A, 'PROOF-NET-1%')
  p.check('…and A quotes its own message on arrival (the org inbox row links to it)', back1.reply_to?.id === outA1.uid
    && back1.reply_to.from === 'boss' && back1.reply_to.gist.startsWith('PROOF-NET-1') && back1.reply_to.box === 'org', back1.reply_to)
  const bossR1 = await rig.waitFor(() => { const m = mailOf(A, 'boss', 'PROOF-REPLY-1%'); return m?.state === 'delivered' ? m : null },
    { what: 'boss to read zoe\'s reply', timeout: 60000 })
  const pr1 = unescape(promptWith('boss', 'PROOF-REPLY-1'))
  p.check('boss (who wrote the answered message) reads "↩ IN REPLY TO your message … PROOF-NET-1" above the reply',
    !bossR1.reply_to.from && /↩ IN REPLY TO your message of \S+: “PROOF-NET-1/.test(pr1), pr1.slice(pr1.indexOf('FROM @net'), pr1.indexOf('FROM @net') + 400))
  p.check('each FROM line ends with the mail\'s id (what reply_to names)', pr1.includes(`· id ${bossR1.uid}`), bossR1.uid)

  // (b) the user's Reply from A's org inbox panel
  const r2 = await rig.api('POST', `/api/orgs/${A}/org_inbox/send`, { to: `@net:${nB}`, body: 'PROOF-REPLY-2 the user answers', reply_to: back1.uid })
  const back2 = await rig.waitFor(() => inRow(B, 'PROOF-REPLY-2%'), { what: 'B to receive the user\'s reply', timeout: 60000 })
  const hubR2 = hubSql(`SELECT reply_to FROM mailhub.messages WHERE body LIKE 'PROOF-REPLY-2%'`)[0]
  const zoeOut = outRow(B, 'PROOF-REPLY-1%')
  p.check('the org inbox panel\'s Reply: the hub carried reply_to = zoe\'s message', hubR2?.reply_to === zoeOut.net_id && back2.reply_to?.id === zoeOut.uid
    && back2.reply_to.gist.startsWith('PROOF-REPLY-1'), { sent: r2, hub: hubR2, quote: back2.reply_to })
  const list = await rig.api('GET', `/api/orgs/${A}/org_inbox`)
  const listed2 = list.entries.find(e => e.body.startsWith('PROOF-REPLY-2'))
  p.check('the org inbox list shows the reply\'s quote on the sent row', listed2?.reply_to?.gist?.startsWith('PROOF-REPLY-1'), listed2?.reply_to)
  const zoeR2 = await rig.waitFor(() => { const m = mailOf(B, 'zoe', 'PROOF-REPLY-2%'); return m?.state === 'delivered' ? m : null },
    { what: 'zoe to read the user\'s reply', timeout: 60000 })
  const pr2 = unescape(promptWith('zoe', 'PROOF-REPLY-2'))
  p.check('zoe reads "↩ IN REPLY TO your message … PROOF-REPLY-1"', /↩ IN REPLY TO your message of \S+: “PROOF-REPLY-1/.test(pr2),
    zoeR2.reply_to)

  // (c) a person's reply, and a reply to a person
  await rig.tool('boss', 'orgtree_message', { to: `@net:${pat.slug}`, body: 'PROOF-PERSON-1 hello Pat' })
  const patGot = await rig.waitFor(async () => {
    const r = await call('POST', '/api/poll?wait=5', { auth: pat })
    return r?.messages?.find(m => m.body.startsWith('PROOF-PERSON-1')) ?? null
  }, { what: 'Pat to receive PROOF-PERSON-1', timeout: 60000 })
  await call('POST', '/api/ack', { auth: pat, body: { ids: [patGot.id] } })
  const patReplyId = `pat-${crypto.randomBytes(8).toString('hex')}`
  const patSent = await call('POST', '/api/send', { auth: pat, raw: true, body: { id: patReplyId, to: nA, from: pat.slug, body: 'PROOF-PERSON-REPLY from Pat', kind: 'message',
    sent_at: new Date().toISOString(), attachments: [], reply_to: patGot.id } })
  const back3 = await rig.waitFor(() => inRow(A, 'PROOF-PERSON-REPLY%'), { what: 'A to receive Pat\'s reply', timeout: 60000 })
  p.check('a person\'s reply (reply_to from a v2 client) arrives quoting boss\'s message', patSent.status === 200
    && back3.reply_to?.gist?.startsWith('PROOF-PERSON-1') && back3.reply_to.from === 'boss', { status: patSent.status, quote: back3.reply_to })
  const bossR3 = await rig.waitFor(() => { const m = mailOf(A, 'boss', 'PROOF-PERSON-REPLY%'); return m?.state === 'delivered' ? m : null },
    { what: 'boss to read Pat\'s reply', timeout: 60000 })
  await rig.tool('boss', 'orgtree_message', { to: `@net:${pat.slug}`, body: 'PROOF-PERSON-2 boss answers Pat', reply_to: bossR3.uid })
  const patGot2 = await rig.waitFor(async () => {
    const r = await call('POST', '/api/poll?wait=5', { auth: pat })
    return r?.messages?.find(m => m.body.startsWith('PROOF-PERSON-2')) ?? null
  }, { what: 'Pat to receive boss\'s answer', timeout: 60000 })
  p.check('a reply to a person: Pat\'s client gets reply_to = the id of Pat\'s own message', patGot2.reply_to === patReplyId, patGot2)

  // (d) an internal reply, and refusals
  await rig.tool('boss', 'orgtree_message', { to: 'alice', body: 'PROOF-INT-1 boss asks alice' })
  const aliceGot = await rig.waitFor(() => { const m = mailOf(A, 'alice', 'PROOF-INT-1%'); return m?.state === 'delivered' ? m : null },
    { what: 'alice to read PROOF-INT-1', timeout: 60000 })
  const r4 = await rig.tool('alice', 'orgtree_message', { to: 'boss', body: 'PROOF-INT-2 alice answers', reply_to: `@mail:${aliceGot.uid}` })
  const bossR4 = await rig.waitFor(() => { const m = mailOf(A, 'boss', 'PROOF-INT-2%'); return m?.state === 'delivered' ? m : null },
    { what: 'boss to read alice\'s answer', timeout: 60000 })
  const pr4 = unescape(promptWith('boss', 'PROOF-INT-2'))
  p.check('internal reply: the existing IN REPLY TO quote and the typed reply.mail link', r4.ok && bossR4.variant === 'reply.mail'
    && bossR4.reply_to?.id === aliceGot.uid && /↩ IN REPLY TO boss's message of \S+: “PROOF-INT-1/.test(pr4), { variant: bossR4.variant, reply_to: bossR4.reply_to })
  const foreign = mailOf(B, 'zoe', 'PROOF-NET-1%')
  const r5 = await rig.tool('alice', 'orgtree_message', { to: 'boss', body: 'PROOF-INT-3', reply_to: foreign.uid })
  const r6 = await rig.tool('carol', 'orgtree_message', { to: 'boss', body: 'PROOF-INT-4', reply_to: aliceGot.uid })
  p.check('reply_to naming mail the agent never received or sent is refused, nothing sent', !r5.ok && !r6.ok && /no message/.test(r5.text + r6.text)
    && !mailOf(A, 'boss', 'PROOF-INT-3%') && !mailOf(A, 'boss', 'PROOF-INT-4%'), { r5: r5.text, r6: r6.text })
  const r7 = await rig.tool('boss', 'orgtree_message', { to: `@net:${nB}`, body: 'PROOF-NET-LOCAL boss forwards', reply_to: bossR4.uid })
  const back7 = await rig.waitFor(() => inRow(B, 'PROOF-NET-LOCAL%'), { what: 'B to receive the local-reply message', timeout: 60000 })
  p.check('a reply over @net to mail that never crossed a hub is sent without a hub link, and the agent is told so',
    r7.ok && /did not come over the mail hub/.test(r7.text) && !back7.reply_to && !hubSql(`SELECT reply_to FROM mailhub.messages WHERE body LIKE 'PROOF-NET-LOCAL%'`)[0]?.reply_to,
    r7.text)

  // ---------------------------------------------------------- long mail
  const words = n => { let s = ''; let i = 0; while (s.length < n) s += `w${i++} `; return s.slice(0, n) }
  const long30 = 'PROOF-LONG-30 ' + words(30000 - 14)
  const send = (body) => call('POST', '/api/send', { auth: pat, raw: true, body: { id: `pat-${crypto.randomBytes(8).toString('hex')}`, to: nA, from: pat.slug, body,
    kind: 'message', sent_at: new Date().toISOString(), attachments: [] } })
  const l1 = await send(long30)
  const got30 = await rig.waitFor(() => inRow(A, 'PROOF-LONG-30%'), { what: 'A to receive 30,000 characters', timeout: 60000 })
  const boss30 = await rig.waitFor(() => mailOf(A, 'boss', 'PROOF-LONG-30%'), { what: 'boss\'s copy', timeout: 60000 })
  p.check('30,000 characters from a person arrive whole (the v1 poll gave 20,000 and body_bytes; the engine fetched the rest)',
    l1.status === 200 && got30.body === long30 && boss30.body === long30, { status: l1.status, got: got30.body.length, boss: boss30.body.length })
  const long100 = 'PROOF-LONG-100 ' + words(100 * 1024 - 15)
  await send(long100)
  const got100 = await rig.waitFor(() => inRow(A, 'PROOF-LONG-100%'), { what: 'A to receive 100 KB', timeout: 60000 })
  const whole = got100.attachments?.find(a => a.name === 'message.txt')
  p.check('100 KB from a person: the 20,000-character preview and the whole text attached as message.txt (byte-identical)',
    whole && fs.readFileSync(whole.path, 'utf8') === long100 && got100.body.startsWith(long100.slice(0, 20000))
    && got100.body.endsWith(`[this message is ${Buffer.byteLength(long100)} bytes long: the whole of it is attached as message.txt]`),
    { preview: got100.body.length, file: whole })
  const long40 = 'PROOF-LONG-40 ' + words(40000 - 14)
  await rig.tool('boss', 'orgtree_message', { to: `@net:${nB}`, body: long40 })
  const got40 = await rig.waitFor(() => inRow(B, 'PROOF-LONG-40%'), { what: 'B to receive 40,000 characters', timeout: 60000 })
  const hub40 = hubSql(`SELECT length(body) AS n, body_bytes FROM mailhub.messages WHERE body LIKE 'PROOF-LONG-40%'`)[0]
  p.check('40,000 characters between the two engines: the hub keeps it whole and B gets it whole', got40.body === long40 && Number(hub40?.n) === 40000,
    { got: got40.body.length, hub: hub40 })

  // ------------------------------------------ the hub forgets an address
  const before = rig.one(`SELECT net->'state' AS s FROM ot.orgs WHERE slug = '${q(A)}'`).s
  const attach = JSON.parse(fs.readFileSync(path.join(rig.data, 'pg', 'cluster', 'pg-attach.json'), 'utf8'))
  const rm = spawnSync(rig.run.hub, ['remove-address', nA], { encoding: 'utf8', windowsHide: true, timeout: 60000,
    env: { ...process.env, HUB_DATA: path.join(rig.data, 'mailhub'), HUB_DATABASE_URL: `postgres://orgtree_mailhub@127.0.0.1:${attach.port}/orgtree_mailhub`,
      HUB_DATABASE_PASSWORD: creds.orgtree_mailhub } })
  p.check('the operator takes A off the hub (orgtree-mailhub remove-address)', rm.status === 0
    && hubSql(`SELECT 1 FROM mailhub.identities WHERE slug = '${q(nA)}'`).length === 0, (rm.stdout + rm.stderr).trim().slice(0, 300))
  t0 = Date.now()
  await rig.waitFor(() => hubSql(`SELECT 1 FROM mailhub.identities WHERE slug = '${q(nA)}'`).length === 1,
    { what: 'A to register again by itself', timeout: 120000, every: 1000 })
  const after = rig.one(`SELECT net->'state' AS s FROM ot.orgs WHERE slug = '${q(A)}'`).s
  // A shares one poll with B, which the hub answers (it knows B): no 401;
  // A's address missing from the hub's roster is what the engine notices
  p.check('the engine noticed (A missing from the hub\'s roster) and registered A again by itself, with the same address', JSON.stringify(after) !== JSON.stringify(before)
    && netSlug(A) === nA, { ms: Date.now() - t0, before, after })
  await rig.tool('zoe', 'orgtree_message', { to: `@net:${nA}`, body: 'PROOF-AFTER-FORGET zoe again' }, { org: B })
  const back8 = await rig.waitFor(() => inRow(A, 'PROOF-AFTER-FORGET%'), { what: 'mail to flow again', timeout: 90000 })
  p.check('mail flows to A again', !!back8)

  // ------------------------------------------------- the pool, the version
  const conns = hubSql(`SELECT count(*) AS n FROM pg_stat_activity WHERE usename = 'orgtree_mailhub'`)[0]
  p.check('the hub holds at most HUB_DB_POOL=8 connections', Number(conns.n) >= 1 && Number(conns.n) <= 8, conns)

  // ------------------------------------------------------ 1 GiB, whole
  if (flags.big) {
    const GiB = 1024 * 1024 * 1024
    const big = path.join(rig.dir, 'big-1GiB.bin')
    const h = crypto.createHash('sha256')
    const fd = fs.openSync(big, 'w')
    const chunk = crypto.randomBytes(8 * 1024 * 1024)
    for (let i = 0; i < GiB / chunk.length; i++) {
      chunk.writeUInt32LE(i, 0)
      fs.writeSync(fd, chunk)
      h.update(chunk)
    }
    fs.closeSync(fd)
    const want = h.digest('hex')
    const upload = async () => fetch(`${rig.url}/api/orgs/${A}/org_inbox/upload?name=big-1GiB.bin&to=${encodeURIComponent('@net:' + nB)}`,
      { method: 'POST', headers: { [TOKEN_HEADER]: rig.token }, body: Readable.toWeb(fs.createReadStream(big)), duplex: 'half' })
      .then(r => r.json())
    t0 = Date.now()
    const staged = await upload()
    const stagedMs = Date.now() - t0
    const over = await tryApi('POST', `/api/orgs/${A}/org_inbox/send`, { to: `@net:${nB}`, body: 'x', attachments: [staged.id] })
    p.check('1 GiB with one byte of text is refused at send (the limit is per message: text and files together)', !over.ok
      && /per message/.test(over.detail) && !outRow(A, 'x'), over)
    t0 = Date.now()
    await rig.api('POST', `/api/orgs/${A}/org_inbox/send`, { to: `@net:${nB}`, body: '', attachments: [staged.id] })
    const sent = await rig.waitFor(() => rig.one(`SELECT state FROM ot.org_inbox WHERE org_id = ${orgId(A)} AND dir = 'out'
      AND attachments::text LIKE '%big-1GiB.bin%' AND state <> 'queued'`), { what: 'the 1 GiB upload to the hub', timeout: 900000, every: 1000 })
    const upMs = Date.now() - t0
    const arrived = await rig.waitFor(() => rig.one(`SELECT attachments FROM ot.org_inbox WHERE org_id = ${orgId(B)} AND dir = 'in'
      AND attachments::text LIKE '%big-1GiB.bin%'`), { what: 'B to download 1 GiB', timeout: 900000, every: 1000 })
    const allMs = Date.now() - t0
    const got = arrived.attachments[0]
    const h2 = crypto.createHash('sha256')
    for await (const c of fs.createReadStream(got.path)) h2.update(c)
    const peak = spawnSync('powershell', ['-NoProfile', '-Command', `(Get-Process -Id ${proc}).PeakWorkingSet64`], { encoding: 'utf8', windowsHide: true }).stdout.trim()
    p.check('one whole 1 GiB file from A to B through the hub: sha256 identical', got.bytes === GiB && h2.digest('hex') === want && sent.state !== 'queued',
      { staged_ms: stagedMs, upload_to_hub_ms: upMs, sent_to_downloaded_ms: allMs, hub_peak_working_set_mib: Math.round(Number(peak) / 1048576) })
    p.note(`1 GiB: staged into the org inbox in ${stagedMs} ms; engine to hub ${upMs} ms; send to B's whole copy ${allMs} ms; hub peak working set ${Math.round(Number(peak) / 1048576)} MiB`)
    fs.rmSync(big, { force: true })
    fs.rmSync(got.path, { force: true })
  }

  p.keep(rig, { agents: ['boss', 'zoe', 'alice'], grep: /mail hub|network|hub/i })
  return p.summary()
}
