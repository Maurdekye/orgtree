// Proof: documents an agent presents to the user (orgtree_present) and files
// it delivers (orgtree_send_file).
//   pia (holds a user audience): presents markdown (the user reads it back),
//       replaces it in place, presents an .html mockup; refusals for no
//       title, a body over 64 KB, both body and path, another's card. She
//       sends a file from her folder (a snapshot: a later edit does not
//       reach the copy), retries with the same delivery_id (one delivery),
//       sends from a folder she holds, and is refused a file outside her
//       folders, a folder, and a path that climbs out of her folder.
//   max (no audience): cannot present (it is not routed), can send a file.
//   lea (under mgr): may use the team folder while mgr holds it; once the
//       user takes it from mgr, lea's own stale grant no longer lets her
//       send or present from it (P17: the superior chain caps her).
// Run: node tools/rig/rig.mjs run tools/rig/proofs/documents.mjs

import fs from 'node:fs'
import path from 'node:path'

import { Proof } from '../proof.mjs'

export default async function (rig) {
  const p = new Proof('documents')
  rig.scenario({ default: { turns: [{ name: 'default', steps: [{ text: 'OK.' }] }] } })
  await rig.waitFor(() => rig.sql(`SELECT 1 FROM ot.turns WHERE ended_at IS NULL`).length === 0, { what: 'seed turns to settle', timeout: 60000 })
  const shared = path.join(rig.data, 'rig-shared')
  const piaDir = path.join(shared, 'pia')
  const team = path.join(shared, 'team')
  const outside = path.join(rig.data, 'rig-outside')
  for (const d of [piaDir, team, outside]) fs.mkdirSync(d, { recursive: true })
  fs.writeFileSync(path.join(piaDir, 'granted.txt'), 'from a folder pia holds\n')
  fs.writeFileSync(path.join(team, 'team.txt'), 'team notes\n')
  fs.writeFileSync(path.join(team, 'team.html'), '<!doctype html><html><body><h1>Team mockup</h1></body></html>')
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'not for agents\n')
  await rig.api('POST', `/api/orgs/${rig.org}/settings`, { org_dirs: [{ path: shared, mode: 'rw' }] })
  const rw = d => [{ path: d, mode: 'rw' }]
  await rig.op({ op: 'hire', name: 'pia', parent: 'boss', tier: 'haiku', title: 'Presenter' })
  await rig.op({ op: 'hire', name: 'max', parent: 'boss', tier: 'haiku', title: 'Sender without audience' })
  await rig.op({ op: 'hire', name: 'mgr', parent: 'boss', tier: 'haiku', title: 'Team lead' })
  await rig.op({ op: 'hire', name: 'lea', parent: 'mgr', tier: 'haiku', title: 'Team member' })
  // folders the user grants (the user's grant raises the chain above, as in 3.x D-106)
  const grantDirs = (name, dirs) => rig.api('POST', `/api/orgs/${rig.org}/nodes/${name}/scope`, { add_dirs: dirs })
  await grantDirs('pia', rw(piaDir))
  await grantDirs('lea', rw(team))
  await rig.api('POST', `/api/orgs/${rig.org}/audiences`, { action: 'grant', node: 'pia', reason: 'proof: may present' })
  await rig.api('POST', `/api/orgs/${rig.org}/audiences`, { action: 'grant', node: 'lea', reason: 'proof: may present' })
  const scratch = name => path.join(rig.data, 'scratch', rig.org, name)
  for (const n of ['pia', 'max', 'lea']) fs.mkdirSync(scratch(n), { recursive: true })
  const tool = (name, t, args) => rig.tool(name, `orgtree_${t}`, args)
  const tryApi = (method, route, body) => rig.api(method, route, body).then(json => ({ ok: true, json }),
    e => ({ ok: false, status: e.status, detail: String(e.body?.detail ?? e.message).slice(0, 200) }))
  const idOf = text => (text ?? '').match(/\(id (d[0-9a-z]+)/)?.[1]

  // ---------------------------------------------------------------- pia presents
  const md = '# Plan\n\nStep one, then step two.\n'
  const pr = await tool('pia', 'present', { title: 'The plan', body: md })
  const did = idOf(pr.text)
  const doc = did && await tryApi('GET', `/api/orgs/${rig.org}/documents/${did}`)
  p.check('pia: a markdown document is presented and the user reads it back', pr.ok && doc?.ok && (doc.json?.body ?? doc.json?.document?.body) === md,
    { text: pr.text, doc })
  const re = await tool('pia', 'present', { title: 'The plan, revised', body: '# Plan\n\nRevised.\n', replaces: did })
  const rows = rig.sql(`SELECT uid, title FROM ot.documents WHERE node_name = 'pia' ORDER BY id`)
  p.check('pia: replaces updates the same card instead of adding one', re.ok && rows.length === 1 && rows[0].uid === did
    && rows[0].title === 'The plan, revised', rows)
  fs.writeFileSync(path.join(scratch('pia'), 'mock.html'), '<!doctype html><html><body><p>Mockup</p></body></html>')
  const html = await tool('pia', 'present', { title: 'Mockup', path: 'mock.html' })
  const hrow = rig.one(`SELECT format FROM ot.documents WHERE uid = '${idOf(html.text)}'`)
  p.check('pia: an .html mockup from her folder is presented as html', html.ok && hrow?.format === 'html', { text: html.text, hrow })
  const refusals = {
    noTitle: await tool('pia', 'present', { body: 'x' }),
    tooBig: await tool('pia', 'present', { title: 'Big', body: 'x'.repeat(64 * 1024 + 1) }),
    both: await tool('pia', 'present', { title: 'Both', body: 'x', path: 'mock.html' }),
    unknown: await tool('pia', 'present', { title: 'Other', body: 'x', replaces: 'd-not-mine' }),
  }
  p.check('pia: no title, a body over 64 KB, both body and path, and an unknown card to replace are each refused',
    Object.values(refusals).every(r => !r.ok), Object.fromEntries(Object.entries(refusals).map(([k, r]) => [k, r.ok ? 'ok' : r.text?.slice(0, 90)])))

  // ---------------------------------------------------------------- pia sends files
  fs.writeFileSync(path.join(scratch('pia'), 'report.txt'), 'version one\n')
  const s1 = await tool('pia', 'send_file', { path: 'report.txt', note: 'the report' })
  const d1 = rig.one(`SELECT uid, name, path, bytes FROM ot.deliveries WHERE name = 'report.txt' ORDER BY id DESC LIMIT 1`)
  fs.writeFileSync(path.join(scratch('pia'), 'report.txt'), 'version two, edited later\n')
  p.check('pia: a file from her folder is delivered as a copy that a later edit does not change', s1.ok && d1?.bytes === 12
    && fs.readFileSync(d1.path, 'utf8') === 'version one\n' && /outbox/.test(d1.path), { text: s1.text, d1 })
  const again1 = await tool('pia', 'send_file', { path: 'report.txt', delivery_id: 'proof-delivery-1' })
  const again2 = await tool('pia', 'send_file', { path: 'report.txt', delivery_id: 'proof-delivery-1' })
  const once = rig.one(`SELECT count(*)::int AS n FROM ot.deliveries WHERE uid = 'proof-delivery-1'`).n
  p.check('pia: a retry with the same delivery_id delivers once', again1.ok && again2.ok && /Already delivered/.test(again2.text ?? '') && once === 1,
    { first: again1.text, second: again2.text, rows: once })
  const held = await tool('pia', 'send_file', { path: path.join(piaDir, 'granted.txt') })
  p.check('pia: a file from a folder she holds is delivered', held.ok, held.text)
  const bad = {
    outside: await tool('pia', 'send_file', { path: path.join(outside, 'secret.txt') }),
    folder: await tool('pia', 'send_file', { path: piaDir }),
    climb: await tool('pia', 'send_file', { path: '../../../rig-outside/secret.txt' }),
  }
  p.check('pia: a file outside her folders, a folder, and a path climbing out of her folder are refused', Object.values(bad).every(r => !r.ok),
    Object.fromEntries(Object.entries(bad).map(([k, r]) => [k, r.ok ? 'ok' : r.text?.slice(0, 90)])))
  fs.writeFileSync(path.join(scratch('pia'), 'empty.txt'), '')
  const big = path.join(scratch('pia'), 'huge.bin')
  const fd = fs.openSync(big, 'w'); fs.ftruncateSync(fd, 257 * 1024 * 1024); fs.closeSync(fd)
  const before = rig.one(`SELECT count(*)::int AS n FROM ot.deliveries`).n
  const empty = await tool('pia', 'send_file', { path: 'empty.txt' })
  const huge = await tool('pia', 'send_file', { path: 'huge.bin' })
  fs.rmSync(big, { force: true })
  for (const d of fs.readdirSync(path.join(scratch('pia'), 'outbox'))) {
    const f = path.join(scratch('pia'), 'outbox', d, 'huge.bin')
    if (fs.existsSync(f)) fs.rmSync(f, { force: true })
  }
  p.check('pia: an empty file and a file over 256 MB are refused, as in 3.x, and nothing is delivered', !empty.ok && /empty/.test(empty.text ?? '')
    && !huge.ok && /256 MB/.test(huge.text ?? '') && rig.one(`SELECT count(*)::int AS n FROM ot.deliveries`).n === before,
  { empty: empty.text?.slice(0, 120), huge: huge.text?.slice(0, 120) })
  const longTitle = 'T'.repeat(200)
  const lt = await tool('pia', 'present', { title: longTitle, body: 'short' })
  const ltRow = rig.one(`SELECT title FROM ot.documents WHERE uid = '${idOf(lt.text)}'`)
  p.check('pia: a title is clipped to 120 characters, as in 3.x', lt.ok && ltRow?.title?.length === 120, ltRow?.title?.length)

  // ---------------------------------------------------------------- max: no audience
  fs.writeFileSync(path.join(scratch('max'), 'notes.txt'), 'max notes\n')
  const mp = await tool('max', 'present', { title: 'Max plan', body: 'x' })
  const ms = await tool('max', 'send_file', { path: 'notes.txt' })
  p.check('max: without a user audience he cannot present (it is not routed), and he can still send a file', !mp.ok
    && /user audience/.test(mp.text ?? '') && ms.ok, { present: mp.text?.slice(0, 120), send: ms.text?.slice(0, 120) })

  // ---------------------------------------------------------------- lea: the superior chain caps her (P17)
  const l1 = await tool('lea', 'send_file', { path: path.join(team, 'team.txt') })
  p.check('lea: while mgr holds the team folder, she may send from it', l1.ok, l1.text)
  const narrowed = await tryApi('POST', `/api/orgs/${rig.org}/nodes/mgr/scope`, { add_dirs: [] })
  const leaScope = rig.one(`SELECT scope FROM ot.agents WHERE name = 'lea' AND state = 'live'`)?.scope
  const l2 = await tool('lea', 'send_file', { path: path.join(team, 'team.txt') })
  const l3 = await tool('lea', 'present', { title: 'Team mockup', path: path.join(team, 'team.html') })
  p.check('lea: once mgr no longer holds it, her own stale grant does not let her send or present from it', narrowed.ok
    && (leaScope?.add_dirs ?? []).some(d => d.path === team) && !l2.ok && !l3.ok,
  { narrowed: narrowed.ok ? 'ok' : narrowed.detail, leaStillConfigured: leaScope?.add_dirs, send: l2.text?.slice(0, 120), present: l3.text?.slice(0, 120) })

  p.keep(rig, { agents: ['pia', 'max', 'lea'], grep: /present|send_file|deliver|document/i })
  return p.summary()
}
