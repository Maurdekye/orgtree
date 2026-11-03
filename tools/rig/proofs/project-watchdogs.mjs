// Proof: a watchdog OWNED BY A PROJECT (docket project-watchdogs-a-watchdog-owned-by-a-project-f; USER 2026-11-03
// 10:33Z; spec project-watchdogs-spec.md rev 1.3), through the real engine and a dependency-free local WebSocket
// server (no external services, mock credentials only):
//   a project dog fires the PROJECT's event: BOTH armed project_listener agents get it (broadcast); the raw payload
//     and the deliveries are recorded (ot.project_fires + each listener's mail); the first line names the dog; the
//     project itself is mailed nothing
//   a RELATIVE credentials path is read from the PROJECT's folder, and only a caller that holds that folder may
//     name it (a member does; an agent above the project does not); the mock bearer reaches the local server
//   templates omit project dogs and say so
//   list shows owner_kind/created_by/handle; a caller that does not reach the project is refused
// Run: node tools/rig/rig.mjs run tools/rig/proofs/project-watchdogs.mjs
// Written without a live run (its author may not build); the integrator measures it. Assumptions to check first:
//   (1) the project's scratch folder is ot.agents.scratch_dir of the project (or scratch/<org>/<project>);

import fs from 'node:fs'
import path from 'node:path'
import { Proof } from '../proof.mjs'
import { wsServer } from './websocket-watchdogs.mjs'

const BEARER = 'PWDPROOF-BEARER-4c9e'

export async function setup() {
  return { recover: true, fixture: { org: { name: 'Project watchdogs' }, agents: [
    { name: 'boss', tier: 'sol', grant: 100 },
    { name: 'outsider', tier: 'sol', grant: 0 },
  ] } }
}

export default async function (rig) {
  const p = new Proof('project-watchdogs')
  const ws = wsServer({ bearer: BEARER })
  await ws.listen(0)
  try { await flow(rig, p, ws) } finally { await ws.stop() }
  p.file('project-fires.json', rig.sql('SELECT id, fired_by, source, left(message, 400) AS message FROM ot.project_fires ORDER BY id'))
  p.file('dogs.json', rig.sql("SELECT uid, name, kind, state, owner_kind, fired FROM ot.watchdogs WHERE owner_kind = 'project' ORDER BY id"))
  p.keep(rig, { agents: ['boss', 'la', 'lb'], grep: /project|websocket|listener/i })
  return p.summary()
}

async function flow(rig, p, ws) {
  const settle = what => rig.waitFor(() => rig.sql('SELECT 1 FROM ot.turns WHERE ended_at IS NULL').length === 0, { what, timeout: 60000 }).catch(() => {})
  const node = name => rig.one(`SELECT id, name, kind, scratch_dir FROM ot.agents WHERE org_id = (SELECT id FROM ot.orgs WHERE slug = '${rig.org}' AND state = 'active') AND name = '${name}'`)
  const mails = (who, like) => rig.sql(`SELECT id, body FROM ot.mail WHERE recipient_agent_id = ${node(who).id} AND body LIKE '%${like}%' ORDER BY id`)
  const tryTool = (who, args) => rig.tool(who, 'orgtree_watchdog', args).then(r => ({ ok: !!r.ok, v: r.json ?? r.text, error: r.ok ? '' : String(r.text ?? '') }), e => ({ ok: false, error: String(e.message ?? e) }))
  const said = r => JSON.stringify(r).slice(0, 500)
  rig.scenario({ default: { turns: [{ name: 'default', steps: [{ text: 'OK.' }] }] } })
  await settle('fixture turns')
  await rig.op({ op: 'retool', node: 'boss', tools: { web: true } })

  // ------------------------------------------------------------ the project, two listening agents
  await rig.op({ op: 'create_project', name: 'stream', parent: 'boss', description: 'Watches a feed.' })
  await rig.op({ op: 'hire', name: 'la', parent: 'stream', tier: 'haiku', grant: 0, title: 'Listener A' })
  await rig.op({ op: 'hire', name: 'lb', parent: 'stream', tier: 'haiku', grant: 0, title: 'Listener B' })
  await settle('hire turns')
  await rig.op({ op: 'retool', node: 'lb', tools: { web: true } })
  const la = await tryTool('la', { action: 'create', name: 'sa', kind: 'project_listener', target: 'stream' })
  const lb = await tryTool('lb', { action: 'create', name: 'sb', kind: 'project_listener', target: 'stream' })
  p.check('la and lb each arm a project_listener on the project', la.ok && lb.ok, { la, lb })

  // ------------------------------------------------------------ a project dog fires the project's event to BOTH listeners
  const feed = await tryTool('boss', { action: 'create', project: 'stream', name: 'feed', kind: 'websocket',
    target: ws.url('/feed'), pattern: '^tick', hello: ['subscribe feed'], interval_s: 5 })
  p.check('boss (above the project) creates a websocket dog on the project', feed.ok && /stream\/\w+/.test(JSON.stringify(feed.v)) , said(feed))
  const row = rig.one("SELECT uid, owner_kind, owner_agent_id FROM ot.watchdogs WHERE name = 'feed' AND state <> 'removed'")
  p.check('the dog row is owned by the PROJECT node (owner_kind project)',
    row?.owner_kind === 'project' && Number(row.owner_agent_id) === Number(node('stream').id), row)
  await rig.waitFor(() => ws.st.got.some(g => g.url === '/feed' && g.text === 'subscribe feed'), { what: 'the dog dials and says hello', timeout: 20000 }).catch(() => {})
  ws.push('tick one')
  await rig.waitFor(() => mails('la', 'tick one').length === 1 && mails('lb', 'tick one').length === 1, { what: 'both listeners get the fire', timeout: 40000 }).catch(() => {})
  const a = mails('la', 'tick one')[0], b = mails('lb', 'tick one')[0]
  p.check('BOTH listening agents received the project event once each (broadcast)', !!a && !!b, { a: a?.body?.slice(0, 300), b: b?.body?.slice(0, 300) })
  p.check('the first line names the dog, its kind and target, and the project',
    /watchdog @stream\/\w+ \("feed", websocket · ws:\/\/127\.0\.0\.1:\d+\/feed\) fired the event on project @stream/.test(a?.body ?? ''), a?.body?.slice(0, 400))
  p.check('the untrusted tag survives and the raw payload follows', /\(untrusted · see EXTERNAL\)/.test(a?.body ?? '') && /tick one/.test(a?.body ?? ''))
  const fire = rig.one("SELECT fired_by, source, message FROM ot.project_fires WHERE message LIKE '%tick one%' ORDER BY id DESC LIMIT 1")
  p.check('the fire is recorded with the dog as its source and the raw payload',
    /^stream\//.test(fire?.fired_by ?? '') && fire?.source?.kind === 'watchdog' && /tick one/.test(fire?.message ?? ''), fire)
  p.check('the project itself is mailed nothing', rig.sql(`SELECT 1 FROM ot.mail WHERE recipient_agent_id = ${node('stream').id} AND body LIKE '%tick one%'`).length === 0)
  ws.push('noise that does not match')
  await new Promise(r => setTimeout(r, 1500))
  p.check('a message that does not match the pattern fires nothing', mails('la', 'noise that does not match').length === 0)

  // ------------------------------------------------------------ list and authority
  const listed = await rig.tool('boss', 'orgtree_watchdog', { action: 'list', project: 'stream' })
  const dogs = listed?.json?.watchdogs ?? []
  const mine = dogs.find(d => d.name === 'feed')
  p.check('list project=stream shows the dog with owner_kind, created_by and a P/uid handle',
    mine?.owner_kind === 'project' && mine?.created_by === 'boss' && /^stream\//.test(mine?.handle ?? ''), said(mine ?? listed))
  const out = await tryTool('outsider', { action: 'create', project: 'stream', name: 'sneak', kind: 'file', target: 'x.log' })
  p.check('an agent that neither sits above nor below the project cannot put a dog on it', !out.ok && /neither above nor below/.test(out.error ?? ''), out)
  const bad = await tryTool('boss', { action: 'create', project: 'stream', name: 'ev', kind: 'event', target: 'turn.*' })
  p.check('an event dog stays on agents', !bad.ok && /stays on an agent/.test(bad.error ?? ''), bad)
  const dup = await tryTool('boss', { action: 'create', project: 'stream', name: 'feed2', kind: 'websocket', target: ws.url('/feed'), pattern: '^tick', hello: ['subscribe feed'] })
  p.check('a duplicate on the same project is refused', !dup.ok && /already has this watchdog/.test(dup.error ?? ''), dup)

  // ------------------------------------------------------------ relative credentials against the PROJECT's folder
  // Measured by the integrator (build-sol 2026-11-03): every MEMBER of a project reads the project's folder, an agent ABOVE
  // it does not (and its scope.add_dirs is not re-read from SQL). So the positive caller is the member lb (it holds web),
  // and the refused caller is boss, who is above the project and holds neither the folder nor a grant to it.
  const proj = node('stream')
  const folder = proj.scratch_dir || path.join(rig.data, 'scratch', rig.org, 'stream')
  fs.mkdirSync(folder, { recursive: true })
  fs.writeFileSync(path.join(folder, 'ws-secure.json'), JSON.stringify({ bearer: BEARER }))
  const secure = await tryTool('lb', { action: 'create', project: 'stream', name: 'secure', kind: 'websocket', target: ws.url('/secure'),
    pattern: '^event:', credentials: 'ws-secure.json', hello: ['subscribe secure'] })
  await rig.waitFor(() => ws.st.upgrades.some(u => u.url === '/secure'), { what: 'the credentialed dog dials', timeout: 20000 }).catch(() => {})
  p.check('lb, a member who holds the project folder, may name a RELATIVE credentials file; the dog dials with the mock bearer',
    secure.ok && ws.st.upgrades.some(u => u.url === '/secure' && u.headers.authorization === `Bearer ${BEARER}`), { secure: said(secure), upgrades: ws.st.upgrades.map(u => u.url) })
  const refused = await tryTool('boss', { action: 'create', project: 'stream', name: 'secure2', kind: 'websocket', target: ws.url('/secure'),
    pattern: '^event:', credentials: 'ws-secure.json', hello: ['another hello'] })
  p.check('boss, above the project and holding neither its folder nor a grant to it, is refused for the same relative path',
    !refused.ok && /cannot read credentials|working folder|folder you hold/i.test(refused.error ?? ''), refused)
  ws.push('event: door open')
  await rig.waitFor(() => mails('la', 'event: door open').length >= 1, { what: 'the credentialed dog fires too', timeout: 40000 }).catch(() => {})
  p.check('the credentialed dog also reaches the listeners', mails('la', 'event: door open').length >= 1 && mails('lb', 'event: door open').length >= 1)
  p.check('the mock bearer appears in no table, mail or event',
    rig.sql(`SELECT 1 FROM ot.mail WHERE body LIKE '%${BEARER}%' OR ev::text LIKE '%${BEARER}%'`).length === 0
    && rig.sql(`SELECT 1 FROM ot.watchdogs WHERE memo::text LIKE '%${BEARER}%' OR events::text LIKE '%${BEARER}%'`).length === 0)

  // ------------------------------------------------------------ templates omit project dogs
  const saved = await rig.api('POST', `/api/orgs/${rig.org}/template`, { name: 'Project watchdog proof', replace: true,
    include: { watchdogs: true } }).then(v => v, e => ({ error: String(e.body?.detail ?? e.message) }))
  p.check('saving a template names the skipped project dogs in its warnings',
    (saved?.warnings ?? []).some(w => /project watchdogs are not included in templates yet \(\d+ skipped\)/.test(w)), said(saved))
  p.check('and the saved content carries none of them', !/"feed"|ws-secure|\/secure/.test(saved?.content ?? 'x'), (saved?.content ?? '').slice(0, 200))
}
