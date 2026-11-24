// Export, import and duplicate of agents, teams and projects
// (docs/rust-engine/agent-export.md; docket agent-team-project-export-import-and-duplication).
// Scratch rig only: fake CLIs, the rig's own database and folders, two synthetic
// organizations in one engine, no provider calls.
//
// Proves, through the routes the windows use and the tools the agents use:
//   1. the estimate; the user's export stops for confirmation when it found
//      secrets and took none out, hands its file out only afterwards, and is an
//      event of the organization; the file is a zip other programs can list
//   2. the plan of an import into another organization (numbered names, cost,
//      where the file came from), and that applying it creates exactly that:
//      parents and order, grants, transcript below the actor's range, files,
//      documents, the cost ledger, the docket item under its new owner, mail
//      only between the imported nodes, everything else in imported-history,
//      paused watchdogs, a notice to each agent, nobody left halted
//   3. undo and redo of the import as one entry: plain when nobody worked,
//      asked first when an imported agent took a turn, refused when somebody
//      was hired under it since
//   4. the imported agent's first turn: on its own carried session, told what
//      happened, writing above the imported rows
//   5. the user's own import clamps grants by the app's default strategy when
//      credits do not bubble up, and by the one the dialog names
//   6. the strip setting: secrets out of text, credential files left out
//   7. the agents' tools: export inside the own subtree only, import refused
//      without a strategy when the grants do not fit and done with one, no
//      undo entry for an agent's import, duplicate
//   8. the user's duplicate: no file, no docket items, no cost, paused
//      watchdogs, one undo entry
//   9. a file that is cut short is refused before anything is created
//  13. a project's own watchdogs travel with it (a relay follows its source
//      project's new name), and the org mailbox never does: not into the
//      file, not onto an imported node, not onto a copy, and never off the
//      node that holds it
//  14. a watchdog's fire action that names a credentials file travels only in
//      the user's own export that strips nothing; a transcript row that
//      names a file in a carried folder names it where it lies after the
//      import, and no other path changes
// RED controls: counts are read before each step and compared after it; a
// refusal is checked to have created nothing.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

import { TOKEN_HEADER } from '../lib.mjs'
import { Proof } from '../proof.mjs'
import { SEED_SETTLE_TIMEOUT } from '../seed-settle.mjs'

/** The entries of a zip as this engine writes one (ZIP64 records always). */
function zipEntries(buf) {
  const loc = buf.length - 22 - 20
  if (loc < 0 || buf.readUInt32LE(loc) !== 0x07064b50) throw new Error('no ZIP64 locator before the end record')
  const end = Number(buf.readBigUInt64LE(loc + 8))
  if (buf.readUInt32LE(end) !== 0x06064b50) throw new Error('no ZIP64 end record')
  const count = Number(buf.readBigUInt64LE(end + 32))
  let at = Number(buf.readBigUInt64LE(end + 48))
  const out = new Map()
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(at) !== 0x02014b50) throw new Error(`central entry ${i} has no signature`)
    const method = buf.readUInt16LE(at + 10), nameLen = buf.readUInt16LE(at + 28), extraLen = buf.readUInt16LE(at + 30), commentLen = buf.readUInt16LE(at + 32)
    const name = buf.toString('utf8', at + 46, at + 46 + nameLen)
    const extra = at + 46 + nameLen
    out.set(name, { method, size: Number(buf.readBigUInt64LE(extra + 4)), packed: Number(buf.readBigUInt64LE(extra + 12)), offset: Number(buf.readBigUInt64LE(extra + 20)) })
    at = extra + extraLen + commentLen
  }
  return out
}

function zipRead(buf, entry) {
  const start = entry.offset + 30 + buf.readUInt16LE(entry.offset + 26) + buf.readUInt16LE(entry.offset + 28)
  const data = buf.subarray(start, start + entry.packed)
  return entry.method === 8 ? zlib.inflateRawSync(data) : Buffer.from(data)
}

const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex')

export default async function (rig) {
  const p = new Proof('agent-export')
  rig.scenario({ default: { turns: [{ name: 'default', steps: [{ text: 'OK.' }] }] } })
  await rig.waitFor(() => rig.sql('SELECT 1 FROM ot.turns WHERE ended_at IS NULL').length === 0,
    { what: 'seed turns settle', timeout: SEED_SETTLE_TIMEOUT })
  const A = rig.org
  const orgId = slug => rig.one(`SELECT id FROM ot.orgs WHERE slug='${slug}' AND state='active'`).id
  const aId = orgId(A)
  const api = (method, route, body) => rig.api(method, route, body)
    .then(json => ({ ok: true, json }), e => ({ ok: false, status: e.status, json: e.body, text: e.message }))
  const raw = async (method, route, body) => {
    const res = await fetch(rig.url + route, { method, headers: { [TOKEN_HEADER]: rig.token }, body, signal: AbortSignal.timeout(120000) })
    return { ok: res.ok, status: res.status, buf: Buffer.from(await res.arrayBuffer()), headers: res.headers }
  }
  const tool = (agent, name, args, org = A) => rig.tool(agent, name, args, { org })
  const ended = (org, kind, id) => rig.waitFor(async () => {
    const s = await rig.api('GET', `/api/orgs/${org}/${kind}/${id}`)
    return s.state !== 'running' ? s : null
  }, { what: `${kind} job ${id} to end`, timeout: 120000, every: 300 })
  const row = (org, name) => rig.one(`SELECT a.id, a.name, a.state, a.kind, a.tier, a.parent_id, p.name AS parent, a.sibling_order, a.seat::float8 AS seat,
      a.grant_credits::float8 AS grant, a.halt, a.session_id, a.provider, a.extra, a.charter
    FROM ot.agents a LEFT JOIN ot.agents p ON p.id = a.parent_id WHERE a.org_id=${org} AND a.name='${name}' AND a.state <> 'deleted'`)
  const live = org => rig.one(`SELECT count(*)::int AS n FROM ot.agents WHERE org_id=${org} AND state='live'`).n
  const tree = org => rig.sql(`SELECT a.name, p.name AS parent FROM ot.agents a LEFT JOIN ot.agents p ON p.id=a.parent_id
      WHERE a.org_id=${org} AND a.state='live' ORDER BY a.parent_id NULLS FIRST, a.sibling_order, a.id`).map(r => `${r.name}<${r.parent ?? 'user'}`).join(' ')
  const turnsOf = id => rig.one(`SELECT count(*) FILTER (WHERE ended_at IS NOT NULL)::int AS done, count(*) FILTER (WHERE ended_at IS NULL)::int AS open,
      coalesce(sum(cost_usd), 0)::float8 AS cost FROM ot.turns WHERE agent_id=${id}`)
  const convoOf = id => rig.one(`SELECT count(DISTINCT seq)::int AS n, count(DISTINCT seq) FILTER (WHERE seq <= 0)::int AS old, coalesce(max(seq), 0)::int AS top,
      count(*) FILTER (WHERE (body->>'seq')::bigint IS DISTINCT FROM seq)::int AS off FROM ot.convo WHERE agent_id=${id}`)
  const oneTurn = async (org, slug, name) => {
    const id = row(org, name).id
    const before = turnsOf(id).done
    await rig.userMail(name, `Export proof: answer OK only (${name}).`, { org: slug })
    await rig.waitFor(() => { const t = turnsOf(id); return t.done > before && t.open === 0 ? t : null }, { what: `${name} to finish a turn`, timeout: 90000 })
  }
  const scratch = (slug, name) => path.join(rig.data, 'scratch', slug, name)
  const runtime = body => rig.api('PUT', '/api/app-settings/runtime', body)
  const hist = slug => rig.api('GET', `/api/orgs/${slug}/undo-history`)
  const undo = (slug, id, confirm) => api('POST', `/api/orgs/${slug}/undo-history/undo`, confirm ? { id, confirm } : { id })
  const redo = (slug, id) => api('POST', `/api/orgs/${slug}/undo-history/redo`, { id })
  const entries = org => rig.one(`SELECT count(*)::int AS n FROM ot.undo_entries WHERE org_id=${org}`).n
  const section = async (name, fn) => {
    try { await fn() } catch (e) { p.check(`${name}: ran to its end`, false, String(e?.stack ?? e).slice(0, 1500)) }
  }

  // ---- 0. what there is to export: turns, files with secrets, a document, a question, a watchdog, waiting mail
  for (const name of ['boss', 'alice', 'bob']) await oneTurn(aId, A, name)
  const aliceDir = scratch(A, 'alice')
  fs.mkdirSync(path.join(aliceDir, 'sub', 'deeper'), { recursive: true })
  fs.mkdirSync(path.join(aliceDir, 'emptydir'), { recursive: true })
  const blob = crypto.randomBytes(300 * 1024)
  fs.writeFileSync(path.join(aliceDir, 'notes.md'), '# Notes\n\nThe staging database: password = "correct-horse-battery"\n\nNothing else here is secret.\n')
  fs.writeFileSync(path.join(aliceDir, 'sub', 'deeper', 'data.bin'), blob)
  fs.writeFileSync(path.join(aliceDir, '.env'), 'API_TOKEN=abc123def456ghi789\n')
  fs.writeFileSync(path.join(aliceDir, 'watched.log'), 'started\n')
  fs.mkdirSync(scratch(A, 'bob'), { recursive: true })
  fs.writeFileSync(path.join(scratch(A, 'bob'), 'todo.txt'), 'one thing\n')
  let r = await tool('boss', 'orgtree_present', { title: 'Export proof report', body: '# Report\n\nThe body of the report.' })
  p.check('0. boss presented a document', r.ok, r.text)
  r = await tool('boss', 'orgtree_ask', { question: 'Export proof: which colour?', options: [{ label: 'Red' }, { label: 'Blue' }] })
  p.check('0. boss has a question open to the user', r.ok, r.text)
  r = await tool('alice', 'orgtree_watchdog', { action: 'create', kind: 'file', target: path.join(aliceDir, 'watched.log'), name: 'log-watch', pattern: 'ERROR' })
  p.check('0. alice armed a file watchdog', r.ok, r.text)
  r = await tool('alice', 'orgtree_message', { to: 'boss', body: 'Late note from alice, still waiting at the export.', notice: true })
  p.check('0. a notice waits for boss', r.ok, r.text)
  const before = {}
  for (const name of ['boss', 'alice', 'bob', 'carol']) {
    const a = row(aId, name)
    before[name] = { row: a, convo: convoOf(a.id), turns: turnsOf(a.id) }
  }
  p.check('0. RED control: the agents have transcripts, turns and a session to carry', before.alice.convo.n > 0 && before.alice.turns.done > 0
    && typeof before.alice.row.session_id === 'string', { convo: before.alice.convo, turns: before.alice.turns, session: before.alice.row.session_id })

  // ---- 1. estimate, export, confirmation, file, event
  let zip = null
  await section('1', async () => {
    const est = await rig.api('GET', `/api/orgs/${A}/nodes/boss/export-estimate?subtree=true`)
    p.check('1. the estimate counts the team and its bytes before anything is written', est.agents === 4 && est.nodes === 4
      && est.bytes?.scratch >= blob.length && est.bytes?.total >= est.bytes?.scratch && est.limit === 256 * 1024 ** 3 && est.strip_secrets === false, est)
    const alone = await rig.api('GET', `/api/orgs/${A}/nodes/boss/export-estimate`)
    p.check('1. alone, the estimate is one node', alone.nodes === 1 && alone.bytes?.total < est.bytes?.total, alone)
    const eventsBefore = rig.one(`SELECT count(*)::int AS n FROM ot.events WHERE org_id=${aId} AND op='export'`).n
    const started = await rig.api('POST', `/api/orgs/${A}/nodes/boss/export`, { subtree: true })
    p.check('1. an export answers at once with its job', typeof started.id === 'string' && started.kind === 'export' && started.name === 'boss-team.orgtree.zip', started)
    const job = await ended(A, 'exports', started.id)
    p.file('export-job.json', job)
    p.check('1. with secrets found and none taken out, the export waits for the user', job.state === 'confirm' && job.result?.secrets?.stripped === false
      && job.result?.secrets?.detected >= 1 && job.result?.counts?.agents === 4, { state: job.state, error: job.error, secrets: job.result?.secrets, counts: job.result?.counts })
    p.check('1. the report names the kinds and the places', Object.keys(job.result?.secrets?.kinds ?? {}).length >= 1
      && JSON.stringify(job.result?.secrets ?? {}).includes('notes.md'), job.result?.secrets)
    let file = await raw('GET', `/api/orgs/${A}/exports/${started.id}/file`)
    p.check('1. the file is not handed out before the confirmation (409)', file.status === 409, { status: file.status, body: file.buf.toString('utf8').slice(0, 200) })
    const confirmed = await rig.api('POST', `/api/orgs/${A}/exports/${started.id}/confirm`)
    file = await raw('GET', `/api/orgs/${A}/exports/${started.id}/file`)
    p.check('1. after it, the file is a zip of the size the job said, named after the node', confirmed.state === 'done' && file.ok
      && file.buf.subarray(0, 2).toString('latin1') === 'PK' && file.buf.length === job.result?.file_bytes
      && /boss-team\.orgtree\.zip/.test(file.headers.get('content-disposition') ?? ''), { state: confirmed.state, status: file.status, bytes: file.buf.length,
      said: job.result?.file_bytes, disposition: file.headers.get('content-disposition') })
    zip = file.buf
    p.file('boss-team.orgtree.zip', zip)
    const names = zipEntries(zip)
    const manifest = JSON.parse(zipRead(zip, names.get('manifest.json')).toString('utf8'))
    const nodes = JSON.parse(zipRead(zip, names.get('nodes.json')).toString('utf8'))
    const list = Array.isArray(nodes) ? nodes : nodes.nodes
    const aliceNode = list.find(n => n.name === 'alice')
    p.check('1. the file holds the manifest, the four nodes and their folders', manifest.kind === 'orgtree-export' && manifest.root === 'boss' && manifest.subtree === true
      && list.length === 4 && typeof manifest.orgtree_version === 'string' && names.has(`${aliceNode?.dir}/scratch/notes.md`) && names.has(`${aliceNode?.dir}/scratch/.env`)
      && names.has(`${aliceNode?.dir}/scratch/sub/deeper/data.bin`) && names.has(`${aliceNode?.dir}/convo.jsonl`),
      { manifest: { kind: manifest.kind, root: manifest.root, version: manifest.orgtree_version, secrets: manifest.secrets }, dir: aliceNode?.dir, entries: names.size })
    p.check('1. a file comes out of it byte for byte', sha(zipRead(zip, names.get(`${aliceNode.dir}/scratch/sub/deeper/data.bin`))) === sha(blob))
    p.check('1. nothing was taken out: the secret is in the file', zipRead(zip, names.get(`${aliceNode.dir}/scratch/notes.md`)).toString('utf8').includes('correct-horse-battery'))
    const ev = rig.sql(`SELECT actor, detail FROM ot.events WHERE org_id=${aId} AND op='export' ORDER BY id`)
    p.check("1. the export is an event of the organization, by the user", ev.length === eventsBefore + 1 && ev.at(-1).actor === '@user'
      && ev.at(-1).detail?.nodes === 4 && ev.at(-1).detail?.node === 'boss', ev.at(-1))
    const gone = await rig.api('DELETE', `/api/orgs/${A}/exports/${started.id}`)
    const after = await api('GET', `/api/orgs/${A}/exports/${started.id}`)
    p.check("1. forgetting the job takes the engine's copy away", gone.removed === true && !after.ok && after.status === 404
      && !fs.existsSync(path.join(rig.data, 'exports', started.id)), { gone, status: after.status })
  })
  if (!zip) return p.summary()

  // ---- 2. a second organization; the plan; the import
  const second = await rig.api('POST', '/api/orgs', { name: 'Second Org', dirs: [], net_autoconnect: false })
  const B = second.slug
  const bId = orgId(B)
  await rig.op({ op: 'hire', name: 'host', tier: 'opus', grant: 40, title: 'Host' }, { org: B })
  await rig.op({ op: 'hire', name: 'alice', parent: 'host', tier: 'haiku', title: 'Another alice' }, { org: B })
  await rig.op({ op: 'hire', name: 'inn', tier: 'opus', grant: 12, title: 'A small host' }, { org: B })
  let imported = null
  const upload = async (bytes, name = 'boss-team.orgtree.zip') => {
    const res = await raw('PUT', `/api/orgs/${B}/imports/upload?name=${encodeURIComponent(name)}`, bytes)
    return { status: res.status, ...(res.ok ? JSON.parse(res.buf.toString('utf8')) : { error: res.buf.toString('utf8').slice(0, 300) }) }
  }
  await section('2', async () => {
    const treeBefore = tree(bId)
    const up = await upload(zip)
    p.check('2. the file is sent up and kept for the plan', typeof up.id === 'string' && up.bytes === zip.length, up)
    const plan = await rig.api('POST', `/api/orgs/${B}/imports/${up.id}/plan`, { dest: 'host' })
    p.file('plan-host.json', plan)
    const names = plan.nodes?.map(n => `${n.was}>${n.name}<${n.parent ?? 'host'}`).join(' ')
    p.check('2. the plan names every node, numbering the taken name', plan.ok === true && plan.refusal === null && plan.agents === 4 && plan.retired === 0
      && names === 'boss>boss<host alice>alice-2<boss bob>bob<alice-2 carol>carol<boss' && JSON.stringify(plan.renamed) === JSON.stringify([{ from: 'alice', to: 'alice-2' }]), { names, renamed: plan.renamed, refusal: plan.refusal })
    p.check('2. it says what it costs, what was made here, and which strategy would be used', plan.full_cost === 28 && plan.cost === 28 && plan.shrunk_by === null
      && plan.file?.foreign === false && plan.file?.root === 'boss' && plan.file?.from?.organization === 'Rig Org' && plan.strategy === 'bottom-up'
      && plan.default_strategy === 'bottom-up' && typeof plan.digest === 'string', { cost: plan.cost, full: plan.full_cost, seats: plan.seats_cost, available: plan.available,
      file: plan.file, strategy: plan.strategy })
    p.check('2. RED control: a plan creates nothing', tree(bId) === treeBefore, tree(bId))
    const stale = await rig.api('POST', `/api/orgs/${B}/imports/${up.id}/apply`, { dest: 'host', expect: 'not-the-digest' })
    const staleEnd = await ended(B, 'imports', stale.id)
    p.check('2. an import whose plan changed since the preview is refused and creates nothing', staleEnd.state === 'failed' && staleEnd.refused === true
      && /preview it again/.test(staleEnd.error ?? '') && tree(bId) === treeBefore, staleEnd)
    // the refused job ended: the file is sent up again for the real one
    const up2 = await upload(zip)
    const plan2 = await rig.api('POST', `/api/orgs/${B}/imports/${up2.id}/plan`, { dest: 'host' })
    const started = await rig.api('POST', `/api/orgs/${B}/imports/${up2.id}/apply`, { dest: 'host', expect: plan2.digest })
    const job = await ended(B, 'imports', started.id)
    p.file('import-job.json', job)
    p.check('2. the import ends done and complete, with nobody held', job.state === 'done' && job.result?.complete === true && job.result?.leftovers?.length === 0
      && job.result?.held?.length === 0 && job.result?.root === 'boss' && JSON.stringify(job.result?.nodes) === JSON.stringify(['boss', 'alice-2', 'bob', 'carol']),
      { state: job.state, error: job.error, leftovers: job.result?.leftovers, held: job.result?.held, nodes: job.result?.nodes, notes: job.result?.notes })
    if (job.state !== 'done') return
    imported = { job, entry: job.result.history_entry }
    p.check('2. it is one entry of the undo history', imported.entry?.kind === 'import' && /^Import boss/.test(imported.entry?.label ?? ''), imported.entry)
    const again = await api('POST', `/api/orgs/${B}/imports/${up2.id}/apply`, { dest: 'host' })
    p.check('2. the same upload is not imported twice (409)', !again.ok && again.status === 409, again.json ?? again.text)
    p.check('2. parents and order are the exported ones, under the node it was imported under',
      tree(bId) === 'host<user inn<user alice<host boss<host alice-2<boss carol<boss bob<alice-2', tree(bId))
    const got = {}
    for (const [was, name] of [['boss', 'boss'], ['alice', 'alice-2'], ['bob', 'bob'], ['carol', 'carol']]) got[was] = row(bId, name)
    imported.ids = Object.fromEntries(Object.entries(got).map(([was, a]) => [was, a.id]))
    p.check('2. grants and seats are the saved ones', got.boss.grant === 24 && got.alice.grant === 6 && got.bob.grant === 0 && got.boss.seat === 4 && got.alice.seat === 2,
      Object.fromEntries(Object.entries(got).map(([was, a]) => [was, { grant: a.grant, seat: a.seat }])))
    p.check('2. each keeps where it came from, and none carries the 3.x mark', Object.entries(got).every(([was, a]) => a.extra?.ported?.was === was
      && a.extra?.ported?.duplicate !== true && typeof a.extra?.ported?.at === 'string' && !('imported_from' in (a.extra ?? {}))),
      Object.fromEntries(Object.entries(got).map(([was, a]) => [was, a.extra?.ported])))
    p.check('2. nobody is left halted, and each is live', Object.values(got).every(a => a.state === 'live' && a.halt === null), Object.values(got).map(a => [a.name, a.state, a.halt]))
    p.check('2. the charter came along', got.boss.charter === before.boss.row.charter && (got.alice.charter ?? null) === (before.alice.row.charter ?? null),
      { boss: got.boss.charter, alice: got.alice.charter })
    for (const was of ['boss', 'alice', 'bob']) {
      const c = convoOf(got[was].id)
      const mark = rig.one(`SELECT body->>'text' AS text, body->>'kind' AS kind FROM ot.convo WHERE agent_id=${got[was].id} AND seq=0`)
      p.check(`2. ${was}'s transcript is below the actor's range, row for row, and ends with the line that says where it happened`,
        (c.old === before[was].convo.n + 1 || c.old === before[was].convo.n + 2) && c.top === 0 && c.off === 0 && c.n === c.old
        && mark?.kind === 'ported' && /^Imported from the organization "Rig Org"\. Everything above happened there\.$/.test(mark?.text ?? ''), { there: before[was].convo, here: c, mark })
      const t = turnsOf(got[was].id)
      p.check(`2. ${was}'s cost ledger came along, every turn ended`, t.done === before[was].turns.done && t.open === 0 && Math.abs(t.cost - before[was].turns.cost) < 1e-9,
        { there: before[was].turns, here: t })
    }
    const to = scratch(B, 'alice-2')
    p.check("2. alice's folder came along whole: text, bytes, the credential file, the empty folder", fs.existsSync(path.join(to, 'notes.md'))
      && sha(fs.readFileSync(path.join(to, 'sub', 'deeper', 'data.bin'))) === sha(blob) && fs.readFileSync(path.join(to, '.env'), 'utf8').includes('abc123def456ghi789')
      && fs.existsSync(path.join(to, 'emptydir')) && fs.existsSync(path.join(scratch(B, 'bob'), 'todo.txt')), fs.existsSync(to) ? fs.readdirSync(to) : 'no folder')
    p.check('2. no part file is left behind', !JSON.stringify(fs.readdirSync(to, { recursive: true })).includes('.orgtree-part'))
    const docs = rig.sql(`SELECT title, node_name, slug, viewed_at IS NOT NULL AS seen, body FROM ot.documents WHERE org_id=${bId}`)
    p.check("2. boss's document is a document of this organization, already seen", docs.length === 1 && docs[0].title === 'Export proof report' && docs[0].node_name === 'boss'
      && docs[0].seen === true && /body of the report/.test(docs[0].body ?? '') && typeof docs[0].slug === 'string', docs.map(d => ({ ...d, body: undefined })))
    const items = rig.sql(`SELECT w.slug, w.title, w.owner, w.owner_agent_id, w.status, (SELECT count(*)::int FROM ot.work_events e WHERE e.work_id=w.id AND e.op='imported') AS marked
      FROM ot.work_items w WHERE w.org_id=${bId}`)
    p.check('2. the docket item came along under its owner here', items.length === 1 && items[0].title === 'Rig smoke item' && items[0].owner_agent_id === got.alice.id
      && JSON.stringify(items[0].owner).includes('alice-2') && items[0].marked === 1, items)
    const ids = Object.values(imported.ids).join(',')
    const between = rig.sql(`SELECT sender, recipient_name, state, body FROM ot.mail WHERE org_id=${bId} AND sender_agent_id IN (${ids}) AND recipient_agent_id IN (${ids})`)
    p.check('2. mail between two imported nodes is mail between them here, under their names here', between.length >= 1
      && between.some(m => m.sender === 'alice-2' && m.recipient_name === 'boss' && /Seeded note/.test(m.body)) && between.every(m => ['delivered', 'read', 'retracted'].includes(m.state)), between)
    const waiting = rig.sql(`SELECT sender, recipient_name, body FROM ot.mail WHERE org_id=${bId} AND recipient_agent_id IN (${ids}) AND state IN ('pending','delivering') AND sender <> '@system'`)
    p.check('2. nothing waits here that waited there', waiting.length === 0, waiting)
    const kept = name => { const f = path.join(scratch(B, name), 'imported-history', 'mail.jsonl'); return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '' }
    p.check("2. mail with the user and the waiting notice are files of the agents' own, with the note that says what they are", /Export proof: answer OK only \(alice\)/.test(kept('alice-2'))
      && /Late note from alice/.test(kept('boss')) && /Late note from alice/.test(kept('alice-2'))
      && fs.existsSync(path.join(scratch(B, 'boss'), 'imported-history', 'README.md')), { alice: kept('alice-2').length, boss: kept('boss').length })
    const asked = path.join(scratch(B, 'boss'), 'imported-history', 'questions.jsonl')
    p.check("2. boss's open question is a file, and no question is open here", fs.existsSync(asked) && /which colour/.test(fs.readFileSync(asked, 'utf8'))
      && rig.one(`SELECT count(*)::int AS n FROM ot.asks WHERE org_id=${bId}`).n === 0)
    const dogs = rig.sql(`SELECT name, kind, state, target FROM ot.watchdogs WHERE org_id=${bId} AND owner_agent_id=${got.alice.id}`)
    p.check("2. alice's watchdog came along paused, watching the file in her folder here", dogs.length === 1 && dogs[0].name === 'log-watch' && dogs[0].state === 'paused'
      && path.resolve(dogs[0].target) === path.resolve(path.join(to, 'watched.log')) && job.result?.watchdogs?.created === 1 && job.result?.watchdogs?.armed === 0,
      { dogs, result: job.result?.watchdogs })
    const system = rig.sql(`SELECT recipient_name, notice, state, body FROM ot.mail WHERE org_id=${bId} AND sender='@system' AND recipient_agent_id IN (${ids}) ORDER BY id`)
    p.file('notices.json', system)
    const notices = system.filter(n => /exported from the organization/.test(n.body))
    const told = name => notices.find(n => n.recipient_name === name)?.body ?? ''
    const [forAlice, forBoss, forCarol] = [told('alice-2'), told('boss'), told('carol')]
    p.check('2. each agent is told what happened, without being woken', notices.length === 4 && notices.every(n => n.notice === true)
      && /exported from the organization "Rig Org"/.test(forAlice) && /Your name here is alice-2 \(it was alice\)/.test(forAlice) && /you are under boss/.test(forAlice)
      && /1 watchdog\(s\) came along paused/.test(forAlice) && /message\(s\) were waiting/.test(forBoss) && /question open to the user/.test(forBoss)
      && /you are under host/.test(forBoss), { alice: forAlice, boss: forBoss })
    p.check('2. an agent that never ran is not told of an earlier conversation, and is not marked for a handoff', forCarol.length > 0 && !/fresh session/.test(forCarol)
      && !('handoff_due' in (got.carol.extra ?? {})), { carol: forCarol, extra: got.carol.extra })
    const hostTold = rig.sql(`SELECT body FROM ot.mail WHERE org_id=${bId} AND sender='@system' AND recipient_name='host' AND body LIKE 'lifecycle.hired: boss%'`)
    p.check('2. the node it went under hears of its new report; the imported nodes are not told of each other as hires', hostTold.length === 1
      && !system.some(n => /^lifecycle\./.test(n.body)), { host: hostTold, system: system.map(n => `${n.recipient_name}: ${n.body.slice(0, 60)}`) })
    p.check('2. importing started no turn', Object.values(got).every(a => turnsOf(a.id).open === 0) && turnsOf(got.alice.id).done === before.alice.turns.done)
  })

  // ---- 3. undo, redo; 4. the imported agent's first turn
  if (imported?.ids) await section('3', async () => {
    const id = imported.entry.id
    const ids = Object.values(imported.ids).join(',')
    const states = () => rig.sql(`SELECT name, state FROM ot.agents WHERE id IN (${ids}) ORDER BY id`).map(a => `${a.name}:${a.state}`).join(' ')
    const t0 = tree(bId)
    let h = await hist(B)
    p.check('3. the import is the undo target, and nobody has worked since', h.undo?.id === id && h.undo?.confirm_required === false, h.undo)
    let r = await undo(B, id)
    p.check('3. undo retires what was created, in one step', r.ok && r.json?.status === 'undone' && states() === 'boss:archived alice-2:archived bob:archived carol:archived'
      && tree(bId) === 'host<user inn<user alice<host', { r: r.json ?? r.text, states: states(), tree: tree(bId) })
    r = await redo(B, id)
    p.check('3. redo brings exactly those nodes back in their places', r.ok && r.json?.status === 'redone' && tree(bId) === t0
      && states() === 'boss:live alice-2:live bob:live carol:live', { r: r.json ?? r.text, tree: tree(bId) })
    // ---- 4. the first turn here
    const alice = imported.ids.alice
    const carried = row(bId, 'alice-2')
    const c0 = convoOf(alice)
    await oneTurn(bId, B, 'alice-2')
    const log = rig.fakeLog('alice-2')
    p.file('fakecli-alice-2.jsonl', log.map(l => JSON.stringify(l)).join('\n'))
    const start = log.find(l => l.kind === 'start')
    const startText = JSON.stringify(start ?? {})
    p.check('4. the imported agent goes on with its own carried session, under a new id', imported.job.result?.sessions_carried >= 1 && typeof carried.session_id === 'string'
      && carried.session_id !== before.alice.row.session_id && carried.provider === 'claude' && startText.includes('--resume') && startText.includes(carried.session_id)
      && row(bId, 'alice-2').session_id === carried.session_id, { carried: imported.job.result?.sessions_carried, session: carried.session_id, was: before.alice.row.session_id,
      provider: carried.provider, resumed: start?.resumed, args: start?.args })
    p.check('4. its first turn tells it what happened', JSON.stringify(log).includes('exported from the organization'), log.filter(l => l.kind !== 'start').slice(0, 3))
    const c1 = convoOf(alice)
    p.check('4. what it writes here starts at 1, above the imported rows, which stay as they were', c1.old === c0.old && c0.top === 0 && c1.top >= 1 && c1.n > c0.n && c1.off === 0
      && rig.one(`SELECT count(*)::int AS n FROM ot.convo WHERE agent_id=${alice} AND seq=1`).n === 1, { before: c0, after: c1 })
    // ---- 3 again: asked first now; then refused once somebody was hired under it
    h = await hist(B)
    p.check('3. once an imported agent has worked, the undo target says so', h.undo?.id === id && h.undo?.confirm_required === true, h.undo)
    r = await undo(B, id)
    const token = r.json?.confirm
    p.check('3. undo then asks first and changes nothing', r.ok && r.json?.status === 'confirm' && typeof token === 'string' && states().includes('alice-2:live'), r.json ?? r.text)
    r = await undo(B, id, token)
    p.check('3. with the confirmation it retires them', r.ok && r.json?.status === 'undone' && states() === 'boss:archived alice-2:archived bob:archived carol:archived', r.json ?? r.text)
    r = await redo(B, id)
    p.check('3. and redo brings them back once more', r.ok && r.json?.status === 'redone' && tree(bId) === t0, { r: r.json ?? r.text, tree: tree(bId) })
    const hired = await tool('boss', 'orgtree_hire', { name: 'zed', tier: 'haiku', grant: 0, charter: 'A hire made after the import.', index: 0, add_dirs: [], org_visibility: 'self',
      tools: { bash: false, web: false, edit: false, subagents: false, mcp: [] } }, B)
    const t1 = tree(bId)
    r = await undo(B, id)
    // an imported agent has worked: it asks first, as before, and is refused when it comes to it
    if (r.ok && r.json?.status === 'confirm') r = await undo(B, id, r.json.confirm)
    p.check('3. once somebody was hired under it, the undo is refused with its reason and changes nothing', hired.ok && !r.ok && r.status === 409
      && r.json?.code === 'history_conflict' && typeof r.json?.reason === 'string' && tree(bId) === t1, { hired: hired.text?.slice(0, 200), r: r.json ?? r.text })
  })

  // ---- 5. the user's own import when credits do not bubble up
  await section('5', async () => {
    const up = await upload(zip)
    let plan = await rig.api('POST', `/api/orgs/${B}/imports/${up.id}/plan`, { dest: 'inn' })
    p.check('5. with bubbling on, the user can import under a small host: its grant is raised', plan.ok === true && plan.shrunk_by === null && plan.cost === 28, { ok: plan.ok,
      refusal: plan.refusal, available: plan.available, shrunk: plan.shrunk_by })
    await runtime({ credit_bubble_hire_enabled: false })
    plan = await rig.api('POST', `/api/orgs/${B}/imports/${up.id}/plan`, { dest: 'inn' })
    const grants = pl => Object.fromEntries(pl.nodes.map(n => [n.was, n.grant]))
    p.check("5. with bubbling off, the grants are clamped by the app's default strategy, bottom-up", plan.ok === true && plan.shrunk_by === 'bottom-up' && plan.strategy === 'bottom-up'
      && plan.available === 12 && plan.cost <= 12 && plan.full_cost === 28 && grants(plan).alice < 6, { ok: plan.ok, refusal: plan.refusal, cost: plan.cost, available: plan.available,
      shrunk: plan.shrunk_by, grants: grants(plan) })
    const bottomUp = grants(plan)
    const other = await rig.api('POST', `/api/orgs/${B}/imports/${up.id}/plan`, { dest: 'inn', strategy: 'top-down' })
    p.check('5. the dialog can name another strategy, and the grants differ', other.ok === true && other.shrunk_by === 'top-down' && other.cost <= 12
      && JSON.stringify(grants(other)) !== JSON.stringify(bottomUp) && other.digest !== plan.digest, { bottomUp, topDown: grants(other) })
    await runtime({ import_shrink_strategy: 'top-down' })
    const byDefault = await rig.api('POST', `/api/orgs/${B}/imports/${up.id}/plan`, { dest: 'inn' })
    p.check("5. the app's setting chooses the default", byDefault.strategy === 'top-down' && byDefault.default_strategy === 'top-down' && byDefault.digest === other.digest,
      { strategy: byDefault.strategy })
    const innBefore = row(bId, 'inn').grant
    const started = await rig.api('POST', `/api/orgs/${B}/imports/${up.id}/apply`, { dest: 'inn', expect: other.digest })
    const job = await ended(B, 'imports', started.id)
    const made = Object.fromEntries((job.result?.plan?.nodes ?? []).map(n => [n.was, row(bId, n.name)?.grant]))
    p.check("5. the import creates the clamped grants and leaves the host's own grant alone", job.state === 'done' && JSON.stringify(made) === JSON.stringify(grants(other))
      && row(bId, 'inn').grant === innBefore && JSON.stringify(job.result?.plan?.nodes?.map(n => n.name)) === JSON.stringify(['boss-2', 'alice-3', 'bob-2', 'carol-2'])
      && job.result.plan.nodes.some(n => n.warnings.some(w => /grant shrunk from/.test(w))), { state: job.state, error: job.error, made, want: grants(other),
      names: job.result?.plan?.nodes?.map(n => n.name) })
    await runtime({ credit_bubble_hire_enabled: true, import_shrink_strategy: 'bottom-up' })
    // the top level: the organization's cap, no pool above
    const top = await upload(zip)
    const atTop = await rig.api('POST', `/api/orgs/${B}/imports/${top.id}/plan`, {})
    p.check("5. at the top level nothing bounds the cost but the organization's cap", atTop.ok === true && atTop.available === null && atTop.nodes[0].parent === null
      && atTop.nodes[0].name === 'boss-3', { ok: atTop.ok, refusal: atTop.refusal, available: atTop.available, root: atTop.nodes?.[0] })
    await rig.api('DELETE', `/api/orgs/${B}/imports/${top.id}`)
  })

  // ---- 6. the strip setting
  await section('6', async () => {
    await runtime({ export_strip_secrets: true })
    const started = await rig.api('POST', `/api/orgs/${A}/nodes/alice/export`, { subtree: false })
    const job = await ended(A, 'exports', started.id)
    const file = await raw('GET', `/api/orgs/${A}/exports/${started.id}/file`)
    p.check('6. with the setting on, the export is ready at once and says what it took out', job.state === 'done' && job.result?.secrets?.stripped === true
      && job.result?.secrets?.detected >= 1 && file.ok, { state: job.state, error: job.error, secrets: job.result?.secrets, status: file.status })
    if (file.ok) {
      const names = zipEntries(file.buf)
      const dir = [...names.keys()].find(n => n.endsWith('/scratch/notes.md'))?.replace(/\/scratch\/notes\.md$/, '')
      const notes = zipRead(file.buf, names.get(`${dir}/scratch/notes.md`)).toString('utf8')
      p.check('6. the secret is out of the text and the credential file is left out', notes.includes('[secret removed]') && !notes.includes('correct-horse-battery')
        && !names.has(`${dir}/scratch/.env`) && names.has(`${dir}/scratch/sub/deeper/data.bin`) && JSON.stringify(job.result.secrets.left_out).includes('.env'),
        { notes, left_out: job.result?.secrets?.left_out })
      p.check('6. the original file is untouched', fs.readFileSync(path.join(aliceDir, 'notes.md'), 'utf8').includes('correct-horse-battery'))
      const convo = zipRead(file.buf, names.get(`${dir}/convo.jsonl`)).toString('utf8')
      p.check('6. the transcript is in the file', convo.includes('Export proof: answer OK only (alice)'))
    }
    const viaTool = await tool('alice', 'orgtree_export', { node: 'bob', path: 'bob-stripped.zip' })
    p.check("6. an agent's export follows the setting too", viaTool.ok && viaTool.json?.state === 'done' && viaTool.json?.result?.secrets?.stripped === true,
      viaTool.json ?? viaTool.text)
    await runtime({ export_strip_secrets: false })
    await rig.api('DELETE', `/api/orgs/${A}/exports/${started.id}`)
  })

  // ---- 7. the agents' tools
  await section('7', async () => {
    const eventsBefore = rig.one(`SELECT count(*)::int AS n FROM ot.events WHERE org_id=${aId} AND op='export'`).n
    let r = await tool('alice', 'orgtree_export', { node: 'bob', path: 'bob-export.zip' })
    const made = path.join(aliceDir, 'bob-export.zip')
    p.check('7. an agent exports a node below it into its own folder, with no confirmation, and is told what was detected', r.ok && r.json?.state === 'done'
      && fs.existsSync(made) && path.resolve(r.json?.result?.path ?? '') === path.resolve(made) && r.json?.result?.secrets?.stripped === false
      && r.json?.result?.counts?.agents === 1, r.json ?? r.text)
    const ev = rig.sql(`SELECT actor, detail FROM ot.events WHERE org_id=${aId} AND op='export' ORDER BY id`)
    p.check("7. the agent's export is an event too, by the agent", ev.length === eventsBefore + 1 && ev.at(-1).actor === 'alice' && ev.at(-1).detail?.node === 'bob', ev.at(-1))
    r = await tool('alice', 'orgtree_export', { node: 'bob', path: 'bob-export.zip' })
    p.check('7. it never writes over a file that is there', !r.ok && /already there/.test(r.text), r.text)
    r = await tool('alice', 'orgtree_export', {})
    const own = r.json?.result?.path ?? ''
    p.check('7. with no path, its own export goes to its exports folder', r.ok && r.json?.state === 'done' && own.includes('.orgtree-exports') && fs.existsSync(own)
      && r.json?.result?.root === 'alice', r.json ?? r.text)
    for (const node of ['carol', 'boss']) {
      r = await tool('alice', 'orgtree_export', { node })
      p.check(`7. it cannot export ${node}, who is not below it`, !r.ok && /not below you/.test(r.text), r.text)
    }
    // import: preview, apply, no undo entry
    const undoBefore = entries(aId)
    let plan = await tool('alice', 'orgtree_import', { file: 'bob-export.zip', preview: true })
    p.check("7. an agent's plan: under itself, a numbered name, and no strategy unless it names one", plan.ok && plan.json?.ok === true && plan.json?.nodes?.[0]?.was === 'bob'
      && plan.json?.nodes?.[0]?.name === 'bob-2' && plan.json?.strategy === null && plan.json?.file?.foreign === false, plan.json ?? plan.text)
    const liveBefore = live(aId)
    r = await tool('alice', 'orgtree_import', { file: 'bob-export.zip', expect: plan.json?.digest })
    const copy = row(aId, 'bob-2')
    p.check('7. the agent imports it under itself', r.ok && r.json?.state === 'done' && r.json?.result?.complete === true && copy?.parent === 'alice' && copy?.state === 'live'
      && copy?.halt === null && live(aId) === liveBefore + 1 && convoOf(copy.id).old >= before.bob.convo.n && fs.existsSync(path.join(scratch(A, 'bob-2'), 'todo.txt')),
      { r: r.json ?? r.text, copy })
    p.check("7. an agent's import is not in the user's undo history", entries(aId) === undoBefore && !r.json?.result?.history_entry, { before: undoBefore, after: entries(aId) })
    r = await tool('alice', 'orgtree_import', { file: 'bob-export.zip', dest: 'carol' })
    p.check('7. it cannot import under a node that is not its own', !r.ok && /only import under itself or its reports/.test(r.text) && live(aId) === liveBefore + 1, r.text)
    // the grants do not fit and the seats do: refused without a strategy, done with one
    r = await tool('boss', 'orgtree_export', { node: 'alice', subtree: true, path: 'alice-team.zip' })
    p.check('7. boss exports the team below it', r.ok && r.json?.state === 'done' && r.json?.result?.counts?.agents === 3, r.json ?? r.text)
    plan = await tool('boss', 'orgtree_import', { file: 'alice-team.zip', preview: true })
    const { full_cost: full, seats_cost: seats, available } = plan.json ?? {}
    // leave boss with seats + 1 credits free: a filler hire holds the rest
    const filler = Math.floor(available - 0.5 - (seats + 1))
    await rig.op({ op: 'hire', name: 'dora', parent: 'boss', tier: 'haiku', grant: filler, title: 'Holds credits' })
    plan = await tool('boss', 'orgtree_import', { file: 'alice-team.zip', preview: true })
    p.check('7. RED control: the seats fit under boss and the saved grants do not', plan.json?.available >= seats && plan.json?.available < full && plan.json?.ok === false
      && /name a shrink strategy/.test(plan.json?.refusal ?? ''), { full, seats, available: plan.json?.available, refusal: plan.json?.refusal })
    const liveNow = live(aId)
    r = await tool('boss', 'orgtree_import', { file: 'alice-team.zip' })
    p.check('7. with no strategy the import is refused and creates nothing', !r.ok && /name a shrink strategy/.test(r.text) && live(aId) === liveNow, r.text)
    r = await tool('boss', 'orgtree_import', { file: 'alice-team.zip', strategy: 'sideways' })
    p.check('7. a strategy that is none is refused', !r.ok && /bottom-up/.test(r.text) && live(aId) === liveNow, r.text)
    r = await tool('boss', 'orgtree_import', { file: 'alice-team.zip', strategy: 'top-down' })
    const root = r.json?.result?.plan?.nodes?.[0]
    const bossRow = row(aId, 'boss')
    const held = rig.one(`SELECT coalesce(sum(seat + grant_credits), 0)::float8 AS n FROM ot.agents WHERE parent_id=${bossRow.id} AND state='live'`).n
    p.check('7. with one, the grants are shrunk to what boss can draw, in whole credits', r.ok && r.json?.state === 'done' && r.json?.result?.plan?.shrunk_by === 'top-down'
      && root?.grant < root?.saved_grant && Number.isInteger(root?.grant) && row(aId, root.name)?.grant === root.grant && held <= bossRow.grant + 1e-9
      && live(aId) === liveNow + 3 && root.warnings.some(w => /grant shrunk from/.test(w)), { r: r.json?.result?.plan ?? r.text, held, grant: bossRow.grant })
    // duplicate
    r = await tool('alice', 'orgtree_duplicate', { node: 'bob' })
    const twin = row(aId, r.json?.result?.root ?? 'no-such-node')
    p.check('7. an agent duplicates a node below it, beside the original', r.ok && r.json?.state === 'done' && twin?.parent === 'alice' && twin?.extra?.ported?.duplicate === true
      && twin?.extra?.ported?.was === 'bob' && turnsOf(twin.id).done === 0 && convoOf(twin.id).old >= before.bob.convo.n, { r: r.json ?? r.text, twin })
    r = await tool('alice', 'orgtree_duplicate', { node: 'carol' })
    p.check('7. it cannot duplicate a node that is not below it', !r.ok && /not below you/.test(r.text), r.text)
    r = await tool('alice', 'orgtree_duplicate', { node: 'alice' })
    p.check('7. nor itself, beside itself: that is under its superior', !r.ok && /only import under itself or its reports/.test(r.text), r.text)
  })

  // ---- 8. the user's duplicate
  await section('8', async () => {
    const aliceRow = row(aId, 'alice')
    const itemsBefore = rig.one(`SELECT count(*)::int AS n FROM ot.work_items WHERE org_id=${aId}`).n
    const teamSize = rig.one(`WITH RECURSIVE t AS (SELECT id FROM ot.agents WHERE id=${aliceRow.id} UNION ALL SELECT a.id FROM ot.agents a JOIN t ON a.parent_id=t.id WHERE a.state='live')
      SELECT count(*)::int AS n FROM t`).n
    const plan = await rig.api('POST', `/api/orgs/${A}/nodes/alice/duplicate`, { subtree: true, preview: true })
    p.check('8. the plan of a duplicate is the plan of an import of the same nodes, beside the original', plan.ok === true && plan.nodes?.length === teamSize
      && plan.nodes[0].was === 'alice' && plan.nodes[0].parent === null && typeof plan.digest === 'string', { ok: plan.ok, refusal: plan.refusal, names: plan.nodes?.map(n => n.name), teamSize })
    const liveBefore = live(aId)
    const started = await rig.api('POST', `/api/orgs/${A}/nodes/alice/duplicate`, { subtree: true, expect: plan.digest })
    const job = await ended(A, 'imports', started.id)
    p.file('duplicate-job.json', job)
    const copy = row(aId, job.result?.root ?? 'no-such-node')
    p.check('8. the copy stands beside the original with its team', job.state === 'done' && started.kind === 'duplicate' && copy?.parent === 'boss' && live(aId) === liveBefore + teamSize
      && copy?.grant === plan.nodes[0].grant && copy?.extra?.ported?.duplicate === true && job.result?.complete === true, { state: job.state, error: job.error, copy,
      leftovers: job.result?.leftovers })
    if (job.state !== 'done') return
    const c = convoOf(copy.id)
    const mark = rig.one(`SELECT body->>'text' AS text FROM ot.convo WHERE agent_id=${copy.id} AND seq=0`)?.text ?? ''
    p.check('8. its transcript ends with the line that says whose it was', /^Copied from alice\. Everything above is alice's conversation up to the copy\.$/.test(mark), mark)
    p.check('8. it has the transcript and the folder, the credential file included: no secrets step', (c.old === before.alice.convo.n + 1 || c.old === before.alice.convo.n + 2)
      && fs.readFileSync(path.join(scratch(A, copy.name), '.env'), 'utf8').includes('abc123def456ghi789')
      && sha(fs.readFileSync(path.join(scratch(A, copy.name), 'sub', 'deeper', 'data.bin'))) === sha(blob), { convo: c, there: before.alice.convo })
    p.check("8. the agent's own exports are not copied into the copy", !fs.existsSync(path.join(scratch(A, copy.name), '.orgtree-exports')))
    p.check('8. no docket item and no cost is copied', rig.one(`SELECT count(*)::int AS n FROM ot.work_items WHERE org_id=${aId}`).n === itemsBefore
      && turnsOf(copy.id).done === 0 && rig.one(`SELECT count(*)::int AS n FROM ot.work_items WHERE owner_agent_id=${copy.id}`).n === 0, turnsOf(copy.id))
    const dogs = rig.sql(`SELECT name, state, target FROM ot.watchdogs WHERE owner_agent_id=${copy.id}`)
    const original = rig.sql(`SELECT name, state FROM ot.watchdogs WHERE owner_agent_id=${aliceRow.id}`)
    p.check("8. the copy's watchdog is paused, watching the copy's own file, and the original's is still armed", dogs.length === 1 && dogs[0].state === 'paused'
      && path.resolve(dogs[0].target) === path.resolve(path.join(scratch(A, copy.name), 'watched.log')) && original.length === 1 && original[0].state === 'armed',
      { dogs, original })
    const told = rig.one(`SELECT body FROM ot.mail WHERE org_id=${aId} AND sender='@system' AND recipient_agent_id=${copy.id} ORDER BY id DESC LIMIT 1`)?.body ?? ''
    p.check('8. the copy is told it is a copy', /You are a copy of alice/.test(told) && /goes on as before/.test(told), told)
    p.check("8. the engine's own copy of the nodes is gone", !fs.existsSync(path.join(rig.data, 'exports', started.id, 'file.zip')))
    const entry = job.result.history_entry
    let h = await hist(A)
    p.check('8. it is one entry of the undo history', entry?.kind === 'import' && /^Duplicate alice/.test(entry?.label ?? '') && h.undo?.id === entry?.id
      && h.undo?.confirm_required === false, { entry, undo: h.undo })
    const r = await undo(A, entry.id)
    p.check('8. undo retires the copy and its team', r.ok && r.json?.status === 'undone' && row(aId, copy.name).state === 'archived' && live(aId) === liveBefore, r.json ?? r.text)
    // a top-level agent alone: its documents come along, at the top level
    const solo = await rig.api('POST', `/api/orgs/${A}/nodes/boss/duplicate`, {})
    const soloJob = await ended(A, 'imports', solo.id)
    const twin = row(aId, soloJob.result?.root ?? 'no-such-node')
    const docs = rig.sql(`SELECT title, slug FROM ot.documents WHERE org_id=${aId} AND agent_id=${twin?.id ?? 0}`)
    p.check('8. a top-level agent is copied alone to the top level, with its documents', soloJob.state === 'done' && twin?.parent === null && twin?.name === 'boss-2'
      && docs.length === 1 && docs[0].title === 'Export proof report' && rig.one(`SELECT count(*)::int AS n FROM ot.agents WHERE parent_id=${twin.id}`).n === 0,
      { state: soloJob.state, error: soloJob.error, twin, docs })
  })

  // ---- 9. a file that is cut short
  await section('9', async () => {
    const treeBefore = tree(bId)
    const up = await upload(zip.subarray(0, Math.floor(zip.length / 2)), 'cut.zip')
    const plan = await api('POST', `/api/orgs/${B}/imports/${up.id}/plan`, { dest: 'host' })
    p.check('9. a file cut short is refused at the plan, in words', !plan.ok && plan.status >= 400 && plan.status < 500 && typeof (plan.json?.detail ?? plan.text) === 'string',
      { status: plan.status, detail: plan.json?.detail ?? plan.text })
    const started = await api('POST', `/api/orgs/${B}/imports/${up.id}/apply`, { dest: 'host' })
    const job = started.ok ? await ended(B, 'imports', started.json.id) : null
    p.check('9. and importing it creates nothing', (!started.ok || job?.state === 'failed') && tree(bId) === treeBefore, { started: started.json ?? started.text, job })
    const text = await upload(Buffer.from('this is not an export at all'), 'notes.zip')
    const notZip = await api('POST', `/api/orgs/${B}/imports/${text.id}/plan`, {})
    p.check('9. a file that is no export is refused the same way', !notZip.ok && notZip.status >= 400 && notZip.status < 500, { status: notZip.status, detail: notZip.json?.detail ?? notZip.text })
  })

  // ---- 10. a project: its description, settings, folder, the agent under it and what was presented to it
  await section('10', async () => {
    let r = await api('POST', `/api/orgs/${A}/ops`, { op: 'create_project', name: 'lab', parent: 'boss', description: 'The lab. Ask @dana for the keys.', settings: { slots: 2 } })
    p.check('10. a project with a description and slots', r.ok, r.json ?? r.text)
    await rig.op({ op: 'hire', name: 'dana', parent: 'lab', tier: 'haiku', title: 'Lab hand' })
    const lab = row(aId, 'lab')
    const labScope = rig.one(`SELECT scope FROM ot.agents WHERE id=${lab.id}`).scope
    const labDir = path.join(scratch(A, '_teams'), String(lab.id))
    fs.mkdirSync(labDir, { recursive: true })
    fs.writeFileSync(path.join(labDir, 'plan.md'), '# The plan of the lab\n')
    r = await tool('boss', 'orgtree_present', { title: 'Lab plan', body: '# Lab plan\n\nFor everybody in the lab.', project: 'lab' })
    p.check('10. boss presented a document to the project', r.ok, r.text)
    await oneTurn(aId, A, 'dana')
    const started = await rig.api('POST', `/api/orgs/${A}/nodes/lab/export`, { subtree: true })
    const job = await ended(A, 'exports', started.id)
    const file = await raw('GET', `/api/orgs/${A}/exports/${started.id}/file`)
    p.check('10. an export that found no secret is ready at once, with no confirmation', job.state === 'done' && job.result?.secrets?.detected === 0
      && job.result?.counts?.projects === 1 && job.result?.counts?.agents === 1 && file.ok && started.name === 'lab-team.orgtree.zip',
      { state: job.state, error: job.error, secrets: job.result?.secrets, counts: job.result?.counts, status: file.status })
    if (!file.ok) return
    p.file('lab-team.orgtree.zip', file.buf)
    await rig.op({ op: 'hire', name: 'dana', parent: 'host', tier: 'haiku', title: 'Another dana' }, { org: B })
    const up = await upload(file.buf, 'lab-team.orgtree.zip')
    const plan = await rig.api('POST', `/api/orgs/${B}/imports/${up.id}/plan`, { dest: 'host' })
    p.check('10. the plan: a project and the agent under it, numbered where its name is taken', plan.ok === true && plan.projects === 1 && plan.agents === 1
      && plan.nodes?.map(n => `${n.kind}:${n.was}>${n.name}<${n.parent ?? 'host'}`).join(' ') === 'project:lab>lab<host agent:dana>dana-2<lab' && plan.full_cost === 0.5,
      { ok: plan.ok, refusal: plan.refusal, nodes: plan.nodes?.map(n => `${n.kind}:${n.was}>${n.name}`), cost: plan.full_cost })
    const done = await ended(B, 'imports', (await rig.api('POST', `/api/orgs/${B}/imports/${up.id}/apply`, { dest: 'host', expect: plan.digest })).id)
    const labB = row(bId, 'lab')
    const danaB = row(bId, 'dana-2')
    p.check('10. the project is a project here, under the node it was imported under, with the agent under it', done.state === 'done' && done.result?.complete === true
      && labB?.kind === 'project' && labB?.parent === 'host' && labB?.state === 'live' && danaB?.parent === 'lab' && danaB?.state === 'live' && danaB?.halt === null,
      { state: done.state, error: done.error, leftovers: done.result?.leftovers, lab: labB, dana: danaB && { parent: danaB.parent, halt: danaB.halt } })
    if (done.state !== 'done') return
    const scopeB = rig.one(`SELECT scope FROM ot.agents WHERE id=${labB.id}`).scope
    p.check('10. its description follows the new name of a node it mentions, and its settings came along', labB.charter === 'The lab. Ask @dana-2 for the keys.'
      && JSON.stringify(scopeB) === JSON.stringify(labScope) && labScope?.slots_capacity === 2, { charter: labB.charter, there: labScope, here: scopeB })
    const planB = path.join(scratch(B, '_teams'), String(labB.id), 'plan.md')
    p.check("10. the project's folder came along", fs.existsSync(planB) && fs.readFileSync(planB, 'utf8') === '# The plan of the lab\n', fs.existsSync(path.dirname(planB))
      ? fs.readdirSync(path.dirname(planB)) : 'no folder')
    const docs = rig.sql(`SELECT title, node_name, presented_by, agent_id FROM ot.documents WHERE org_id=${bId} AND title='Lab plan'`)
    // boss presented it and did not come along: the name is one of the organization it left, and is not kept as a name here
    p.check("10. what was presented to the project came along with it, as the project's own", docs.length === 1 && docs[0].node_name === 'lab' && docs[0].agent_id === labB.id
      && docs[0].presented_by === null, docs)
    const told = rig.one(`SELECT body FROM ot.mail WHERE org_id=${bId} AND sender='@system' AND recipient_agent_id=${danaB.id} AND body LIKE '%exported from%' LIMIT 1`)?.body ?? ''
    p.check('10. the agent in the project is told where it is', /Your name here is dana-2 \(it was dana\), and you are under lab\./.test(told), told)
    p.check('10. a project has no transcript of its own', rig.one(`SELECT count(*)::int AS n FROM ot.convo WHERE agent_id=${labB.id}`).n === 0)
    const copy = await ended(A, 'imports', (await rig.api('POST', `/api/orgs/${A}/nodes/lab/duplicate`, { subtree: true })).id)
    const lab2 = row(aId, copy.result?.root ?? 'no-such-node')
    const under = rig.sql(`SELECT name FROM ot.agents WHERE parent_id=${lab2?.id ?? 0} AND state='live'`)
    const docs2 = rig.sql(`SELECT d.title FROM ot.documents d WHERE d.org_id=${aId} AND d.title='Lab plan'`)
    p.check('10. the user duplicates the project with what is under it and what was presented to it', copy.state === 'done' && lab2?.kind === 'project' && lab2?.name === 'lab-2'
      && lab2?.parent === 'boss' && under.length === 1 && docs2.length === 2, { state: copy.state, error: copy.error, lab2: lab2 && { name: lab2.name, kind: lab2.kind, parent: lab2.parent },
      under, docs: docs2.length })
  })

  // ---- 11. retired agents: left out unless asked for, and then they come in retired and can be rehired
  await section('11', async () => {
    const child = rig.one(`SELECT c.name, c.id FROM ot.agents c JOIN ot.agents a ON a.id=c.parent_id WHERE a.org_id=${aId} AND a.name='alice' AND c.state='live' AND c.name <> 'bob' ORDER BY c.id LIMIT 1`)
    await rig.op({ op: 'retire', node: child.name })
    const without = await rig.api('GET', `/api/orgs/${A}/nodes/alice/export-estimate?subtree=true`)
    const withThem = await rig.api('GET', `/api/orgs/${A}/nodes/alice/export-estimate?subtree=true&retired=true`)
    p.check('11. the estimate counts retired agents only when they are asked for', without.retired === 0 && withThem.retired >= 1 && withThem.nodes === without.nodes + withThem.retired,
      { without: without.nodes, with: withThem.nodes, retired: withThem.retired })
    const started = await rig.api('POST', `/api/orgs/${A}/nodes/alice/export`, { subtree: true, include: { scratch: true, team: true, transcript: true, native_sessions: true, retired: true } })
    let job = await ended(A, 'exports', started.id)
    if (job.state === 'confirm') job = await rig.api('POST', `/api/orgs/${A}/exports/${started.id}/confirm`)
    const file = await raw('GET', `/api/orgs/${A}/exports/${started.id}/file`)
    p.check('11. the export holds them', job.state === 'done' && job.result?.counts?.retired === withThem.retired && file.ok, { state: job.state, error: job.error, counts: job.result?.counts })
    if (!file.ok) return
    const up = await upload(file.buf, 'alice-team.orgtree.zip')
    const plan = await rig.api('POST', `/api/orgs/${B}/imports/${up.id}/plan`, { dest: 'host' })
    const gone = plan.nodes?.find(n => n.was === child.name)
    p.check('11. the plan says who arrives retired', plan.ok === true && plan.retired === withThem.retired && gone?.retired === true && gone?.seat === 0,
      { ok: plan.ok, refusal: plan.refusal, retired: plan.retired, gone })
    const done = await ended(B, 'imports', (await rig.api('POST', `/api/orgs/${B}/imports/${up.id}/apply`, { dest: 'host', expect: plan.digest })).id)
    const here = row(bId, gone?.name ?? 'no-such-node')
    const above = plan.nodes?.[0]?.name
    p.check('11. it comes in retired under its superior, with its transcript and its folder, and is told nothing', done.state === 'done' && done.result?.complete === true
      && here?.state === 'archived' && here?.parent === above && convoOf(here.id).old >= 1 && fs.existsSync(path.join(scratch(B, here.name), 'todo.txt'))
      && rig.one(`SELECT count(*)::int AS n FROM ot.mail WHERE recipient_agent_id=${here?.id ?? 0}`).n === 0,
      { state: done.state, error: done.error, leftovers: done.result?.leftovers, here: here && { name: here.name, state: here.state, parent: here.parent, seat: here.seat } })
    if (!here) return
    const back = await api('POST', `/api/orgs/${B}/ops`, { op: 'rehire', node: here.name })
    p.check('11. and can be rehired like any retired agent', back.ok && row(bId, here.name).state === 'live', back.json ?? back.text)
  })

  // ---- 12. an export sent to another organization by mail, and imported there by the agent that received it
  await section('12', async () => {
    const inbox = path.join(rig.data, 'uploads', B, '@org-inbox')
    const copies = () => (fs.existsSync(inbox) ? fs.readdirSync(inbox).length : 0)
    let r = await tool('boss', 'orgtree_export', { node: 'bob', path: 'bob-for-second.zip' })
    p.check('12. boss exports an agent below it', r.ok && r.json?.state === 'done', r.json ?? r.text)
    const before12 = copies()
    r = await tool('alice', 'orgtree_message', { to: `@org:${B}`, body: 'Not allowed to write outside.', attachments: ['notes.md'] })
    p.check('12. an agent without the org-mailbox audience is refused before anything is copied', !r.ok && /org-mailbox audience/.test(r.text) && copies() === before12, r.text)
    r = await tool('boss', 'orgtree_message', { to: '@org:no-such-org', body: 'Nobody there.', attachments: ['bob-for-second.zip'] })
    p.check('12. and so is mail to an organization that is not there', !r.ok && /no organization @org:no-such-org/.test(r.text) && copies() === before12, r.text)
    r = await tool('boss', 'orgtree_message', { to: `@org:${B}`, body: 'Here is bob, with everything he has.', attachments: ['bob-for-second.zip'] })
    p.check('12. mail to another organization on this computer carries the file', r.ok && copies() === before12 + 1, r.text)
    const mail = await rig.waitFor(() => rig.one(`SELECT m.recipient_name, m.attachments FROM ot.mail m WHERE m.org_id=${bId} AND m.body LIKE '%Here is bob%'
      AND m.recipient_kind='agent' ORDER BY m.id DESC LIMIT 1`), { what: 'the mail to arrive in the other organization', timeout: 30000 })
    const att = mail.attachments?.[0]
    p.check("12. it arrives with a copy in that organization's own mailbox folder", att?.name === 'bob-for-second.zip' && att?.bytes > 0 && fs.existsSync(att?.path ?? '')
      && path.resolve(att.path).toLowerCase().startsWith(path.resolve(inbox).toLowerCase()), { to: mail.recipient_name, att })
    // the copy stays when the sender's file goes
    fs.rmSync(path.join(scratch(A, 'boss'), 'bob-for-second.zip'))
    const holder = mail.recipient_name
    const other = holder === 'host' ? 'inn' : 'host'
    r = await tool(other, 'orgtree_import', { file: att.path, preview: true }, B)
    p.check('12. an agent it was not sent to cannot import it', !r.ok && /outside your working folder/.test(r.text), r.text)
    const plan = await tool(holder, 'orgtree_import', { file: att.path, preview: true }, B)
    p.check('12. the agent that received it can: the plan', plan.ok && plan.json?.ok === true && plan.json?.nodes?.[0]?.was === 'bob', plan.json ?? plan.text)
    const liveBefore = live(bId)
    r = await tool(holder, 'orgtree_import', { file: att.path, expect: plan.json?.digest }, B)
    const made = row(bId, r.json?.result?.root ?? 'no-such-node')
    p.check('12. and imports it under itself', r.ok && r.json?.state === 'done' && made?.parent === holder && live(bId) === liveBefore + 1,
      { r: r.json ?? r.text, made: made && { name: made.name, parent: made.parent } })
  })

  // ---- 13. a project's own watchdogs come along; the org mailbox stays where it is
  // USER 2026-11-24 m516cde3ebdef "the two sub-projects are missing watchdogs from the top inbox project";
  // USER 2026-11-24 m63824e37d3d6 "the org inbox audience should never move / be saved with an import"
  await section('13', async () => {
    const holders = org => rig.sql(`SELECT grantee FROM ot.audiences WHERE org_id=${org} AND grantor='@extern' AND revoked_at IS NULL ORDER BY grantee`).map(a => a.grantee).join(' ')
    const dogsOf = id => rig.sql(`SELECT name, kind, state, target, owner_kind, memo->>'project_delivery' AS delivery FROM ot.watchdogs
      WHERE owner_agent_id=${id ?? 0} AND state IN ('armed', 'paused') ORDER BY id`)
    let r = await api('POST', `/api/orgs/${A}/ops`, { op: 'create_project', name: 'desk13', parent: 'boss', description: 'The front desk.' })
    p.check('13. a project', r.ok, r.json ?? r.text)
    r = await api('POST', `/api/orgs/${A}/ops`, { op: 'create_project', name: 'crew13', parent: 'desk13', description: 'Takes its jobs from @desk13.' })
    p.check('13. and a project under it', r.ok, r.json ?? r.text)
    r = await tool('boss', 'orgtree_watchdog', { action: 'create', project: 'crew13', name: 'from-desk', kind: 'fair_queue', target: 'desk13' })
    const crew = row(aId, 'crew13')
    p.check('13. the lower project has its own watchdog on the upper one: a relay of its mail queue', r.ok && dogsOf(crew.id).map(d => `${d.name}:${d.kind}:${d.owner_kind}:${d.target}:${d.state}`).join(' ')
      === 'from-desk:fair_queue:project:desk13:armed', { r: r.json ?? r.text, dogs: dogsOf(crew.id) })
    r = await api('POST', `/api/orgs/${A}/audiences`, { action: 'grant', node: 'desk13', target: 'extern', reason: 'proof: the project queues the org mailbox' })
    p.check('13. the upper project holds the org mailbox there', r.ok && holders(aId) === 'desk13', { r: r.json ?? r.text, holders: holders(aId) })
    r = await api('POST', `/api/orgs/${B}/audiences`, { action: 'grant', node: 'host', target: 'extern', reason: 'proof: host holds the org mailbox here' })
    p.check('13. and an agent holds it in the other organization', r.ok && holders(bId) === 'host', { r: r.json ?? r.text, holders: holders(bId) })

    const started = await rig.api('POST', `/api/orgs/${A}/nodes/desk13/export`, { subtree: true })
    let job = await ended(A, 'exports', started.id)
    if (job.state === 'confirm') job = await rig.api('POST', `/api/orgs/${A}/exports/${started.id}/confirm`)
    const file = await raw('GET', `/api/orgs/${A}/exports/${started.id}/file`)
    p.check('13. the export of both', job.state === 'done' && file.ok && job.result?.counts?.projects === 2, { state: job.state, error: job.error, counts: job.result?.counts })
    if (!file.ok) return
    p.file('desk13-team.orgtree.zip', file.buf)
    const names = zipEntries(file.buf)
    const links = JSON.parse(zipRead(file.buf, names.get('links.json')).toString('utf8'))
    const nodes = JSON.parse(zipRead(file.buf, names.get('nodes.json')).toString('utf8')).nodes
    const dog = links.watchdogs?.[0]
    p.check("13. the file holds the project's watchdog, with its owner and its delivery form", links.watchdogs?.length === 1 && nodes[dog?.owner]?.name === 'crew13'
      && dog?.args?.kind === 'fair_queue' && dog?.args?.target === 'desk13' && dog?.args?.project_delivery === 'queue' && dog?.paused === false
      && !JSON.stringify(links.left_out ?? []).includes('owned by a project'), { watchdogs: links.watchdogs?.map(d => ({ owner: d.owner, args: d.args })), left_out: links.left_out })
    p.check('13. the file holds no audience with the org mailbox, and does not name one as left behind', !JSON.stringify(links.audiences ?? []).includes('extern')
      && !/extern|org mailbox/i.test(JSON.stringify(links.left_out ?? [])), { audiences: links.audiences, left_out: links.left_out })

    // into the other organization, where the names are free: armed because the importer asked
    const up = await upload(file.buf, 'desk13-team.orgtree.zip')
    const plan = await rig.api('POST', `/api/orgs/${B}/imports/${up.id}/plan`, { dest: 'host' })
    p.check('13. the plan counts the watchdog', plan.ok === true && plan.file?.watchdogs === 1 && plan.nodes?.map(n => n.name).join(' ') === 'desk13 crew13',
      { ok: plan.ok, refusal: plan.refusal, file: plan.file, nodes: plan.nodes?.map(n => n.name) })
    const done = await ended(B, 'imports', (await rig.api('POST', `/api/orgs/${B}/imports/${up.id}/apply`, { dest: 'host', expect: plan.digest, resume_watchdogs: true })).id)
    const crewB = row(bId, 'crew13')
    p.check("13. the imported project has its watchdog, the project's own, on the imported upper project, armed as asked", done.state === 'done' && done.result?.complete === true
      && dogsOf(crewB?.id).map(d => `${d.name}:${d.kind}:${d.owner_kind}:${d.target}:${d.delivery}:${d.state}`).join(' ') === 'from-desk:fair_queue:project:desk13:queue:armed'
      && done.result?.watchdogs?.created === 1 && done.result?.watchdogs?.armed === 1,
      { state: done.state, error: done.error, leftovers: done.result?.leftovers, dogs: dogsOf(crewB?.id), result: done.result?.watchdogs })
    p.check('13. the import gave the org mailbox to nobody and took it from nobody', holders(bId) === 'host' && holders(aId) === 'desk13', { there: holders(aId), here: holders(bId) })

    // a copy beside the original: numbered names, the relay follows its source, the original keeps the org mailbox
    const copy = await ended(A, 'imports', (await rig.api('POST', `/api/orgs/${A}/nodes/desk13/duplicate`, { subtree: true })).id)
    const desk2 = row(aId, copy.result?.root ?? 'no-such-node')
    const crew2 = rig.one(`SELECT id, name FROM ot.agents WHERE parent_id=${desk2?.id ?? 0} AND kind='project' AND state='live'`)
    p.check("13. the copy's lower project has the watchdog paused, on the copy of the upper project", copy.state === 'done' && desk2?.name === 'desk13-2' && crew2?.name === 'crew13-2'
      && dogsOf(crew2?.id).map(d => `${d.name}:${d.kind}:${d.owner_kind}:${d.target}:${d.delivery}:${d.state}`).join(' ') === 'from-desk:fair_queue:project:desk13-2:queue:paused'
      && dogsOf(crew.id).map(d => `${d.target}:${d.state}`).join(' ') === 'desk13:armed',
      { state: copy.state, error: copy.error, desk2: desk2?.name, crew2: crew2?.name, dogs: dogsOf(crew2?.id), original: dogsOf(crew.id), result: copy.result?.watchdogs })
    p.check('13. the original still holds the org mailbox, and the copy does not', holders(aId) === 'desk13', holders(aId))
  })

  // ---- 14. fire actions that hold credentials; paths in the transcript
  // USER 2026-11-24 mf7c65a1b2403 "can watchdogs be shipped with those secrets if we choose to retain secrets in the export?
  // can we do 2 only if the paths refer to locations in the saved scratch folders in the export?"
  await section('14', async () => {
    await runtime({ export_strip_secrets: false })
    const carolDir = scratch(A, 'carol')
    fs.mkdirSync(path.join(carolDir, 'ws'), { recursive: true })
    fs.writeFileSync(path.join(carolDir, 'ws', 'feed.json'), '{"bearer":"proof-only-not-a-real-token"}\n')
    fs.writeFileSync(path.join(carolDir, 'fired.log'), 'started\n')
    const action = { tool: 'orgtree_watchdog', args: { action: 'create', kind: 'websocket', name: 'feed', target: 'ws://127.0.0.1:9/feed', credentials: 'ws/feed.json' } }
    let r = await tool('carol', 'orgtree_watchdog', { action: 'create', kind: 'file', target: path.join(carolDir, 'fired.log'), name: 'on-fire', pattern: 'GO', fire_actions: [action] })
    const carol = row(aId, 'carol')
    const stored = id => rig.one(`SELECT state, memo->'fire_actions' AS actions, memo->>'template_needs_credentials' AS needs FROM ot.watchdogs
      WHERE owner_agent_id=${id ?? 0} AND name='on-fire' AND state IN ('armed', 'paused')`)
    p.check('14. an agent has a watchdog whose fire action names a credentials file', r.ok && stored(carol.id)?.actions?.[0]?.args?.credentials === 'ws/feed.json', { r: r.json ?? r.text, stored: stored(carol.id) })
    // three paths in its transcript: in its own folder, in a folder that is not exported, and in one whose name only begins like its own
    const own = path.join(carolDir, 'notes', 'plan.md')
    const other = path.join(scratch(A, 'boss'), 'plan.md')
    const alike = path.join(`${carolDir}-old`, 'plan.md')
    const turns = turnsOf(carol.id).done
    await rig.userMail('carol', `Path proof: read ${own} then ${other} then ${alike} and answer OK.`, { org: A })
    await rig.waitFor(() => { const t = turnsOf(carol.id); return t.done > turns && t.open === 0 ? t : null }, { what: 'carol to finish a turn', timeout: 90000 })
    const said = id => rig.sql(`SELECT body->>'text' AS text FROM ot.convo WHERE agent_id=${id ?? 0} AND body->>'text' LIKE '%Path proof: read%' ORDER BY seq`).map(c => c.text)
    p.check('14. its transcript names the three paths', said(carol.id).length >= 1 && said(carol.id).every(t => t.includes(own) && t.includes(other) && t.includes(alike)), said(carol.id))

    const linksOf = buf => JSON.parse(zipRead(buf, zipEntries(buf).get('links.json')).toString('utf8'))
    // an agent's export: the fire action stays behind
    r = await tool('boss', 'orgtree_export', { node: 'carol', path: 'carol-by-boss.zip' })
    const byBoss = r.ok ? linksOf(fs.readFileSync(path.join(scratch(A, 'boss'), 'carol-by-boss.zip'))) : null
    const dogBoss = byBoss?.watchdogs?.find(d => d.args?.name === 'on-fire')
    p.check("14. an agent's export leaves the fire action out, and the watchdog says it needs credentials", r.ok && dogBoss && dogBoss.fire_actions === undefined
      && dogBoss.args.fire_actions === undefined && dogBoss.needs_credentials === true, { r: r.json ?? r.text, dog: dogBoss })
    // the user's own, nothing taken out: asked first, then carried
    const started = await rig.api('POST', `/api/orgs/${A}/nodes/carol/export`, { subtree: false })
    let job = await ended(A, 'exports', started.id)
    const asked = job.state
    if (job.state === 'confirm') job = await rig.api('POST', `/api/orgs/${A}/exports/${started.id}/confirm`)
    const file = await raw('GET', `/api/orgs/${A}/exports/${started.id}/file`)
    p.check("14. the user's export stops for the watchdog's credentials before it hands the file out", asked === 'confirm' && job.state === 'done' && file.ok
      && job.result?.secrets?.watchdog_credentials === 1, { asked, state: job.state, error: job.error, secrets: job.result?.secrets })
    if (!file.ok) return
    const dogUser = linksOf(file.buf).watchdogs?.find(d => d.args?.name === 'on-fire')
    p.check('14. and its file holds the fire action whole, beside the definition and not in it', JSON.stringify(dogUser?.fire_actions) === JSON.stringify([action])
      && dogUser?.args?.fire_actions === undefined && dogUser?.needs_credentials === false, dogUser && { args: dogUser.args, fire_actions: dogUser.fire_actions, needs: dogUser.needs_credentials })

    const up = await upload(file.buf, 'carol.orgtree.zip')
    const plan = await rig.api('POST', `/api/orgs/${B}/imports/${up.id}/plan`, { dest: 'host' })
    const done = await ended(B, 'imports', (await rig.api('POST', `/api/orgs/${B}/imports/${up.id}/apply`, { dest: 'host', expect: plan.digest })).id)
    const carolB = row(bId, done.result?.root ?? 'no-such-node')
    p.check('14. the imported watchdog has its fire action again, and arrives paused like any other', done.state === 'done' && done.result?.complete === true
      && JSON.stringify(stored(carolB?.id)?.actions) === JSON.stringify([action]) && stored(carolB?.id)?.state === 'paused' && stored(carolB?.id)?.needs !== 'true',
      { state: done.state, error: done.error, leftovers: done.result?.leftovers, notes: done.result?.watchdogs?.notes, stored: stored(carolB?.id) })
    const ownB = path.join(scratch(B, carolB?.name ?? 'no-such-node'), 'notes', 'plan.md')
    p.check('14. its transcript names the file in its own folder where that lies now, and the two other paths as they were written',
      said(carolB?.id).length >= 1 && said(carolB?.id).every(t => t.includes(ownB) && !t.includes(own) && t.includes(other) && t.includes(alike)) && ownB !== own,
      { here: ownB, rows: said(carolB?.id) })
    p.check('14. the transcript where it was exported is untouched', said(carol.id).every(t => t.includes(own)), said(carol.id))

    // a copy: the folder follows, the fire action does not
    const copy = await ended(A, 'imports', (await rig.api('POST', `/api/orgs/${A}/nodes/carol/duplicate`, { subtree: false })).id)
    const carol2 = row(aId, copy.result?.root ?? 'no-such-node')
    const own2 = path.join(scratch(A, carol2?.name ?? 'no-such-node'), 'notes', 'plan.md')
    p.check("14. a copy's watchdog has no fire action and says it needs credentials; its transcript names the copy's own folder", copy.state === 'done'
      && (stored(carol2?.id)?.actions ?? null) === null && stored(carol2?.id)?.needs === 'true' && stored(carol2?.id)?.state === 'paused'
      && said(carol2?.id).length >= 1 && said(carol2?.id).every(t => t.includes(own2) && !t.includes(`${own} `) && t.includes(other) && t.includes(alike)),
      { state: copy.state, error: copy.error, stored: stored(carol2?.id), rows: said(carol2?.id), own2 })
  })

  p.keep(rig, { agents: ['alice', 'boss'], grep: /export|import|portable|duplicate|ported/i })
  return p.summary()
}
