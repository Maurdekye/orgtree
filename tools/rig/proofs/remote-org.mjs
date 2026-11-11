// tools/rig/proofs/remote-org.mjs: an organization that runs on a remote
// standalone engine, opened in this desktop (docs/rust-engine/remote-org.md).
//
// The run's own engine is "this computer". The proof starts a SECOND debug
// engine in standalone mode on a synthetic data root inside the run folder
// (fake home, fake CLIs, offline, loopback only) and reaches it through a
// small TCP forwarder, so the network between the two can be cut and brought
// back without stopping either engine.
//
//   node tools/rig/rig.mjs run tools/rig/proofs/remote-org.mjs --ui <bundle>
//
// With a renderer bundle the desktop is driven too (desktop/remote-org.cjs):
// the connection is added in the Add dialog, the remote organization is
// opened and used, the network is cut and restored under the open window,
// the remote engine restarts, its token is revoked and replaced, and a local
// organization is used beside it; then the remote organization whose name is
// taken here is opened, for what depends on the computer (a folder, a sign-in,
// App settings, the folder picker) and for a reference written under the name
// it has there. That part opens an Electron window, so it
// runs only in Windows Session 0 (team rule; the harness is muted and off the
// real clipboard). Without a bundle the same connection is made and broken
// through the engine's routes alone, in any session.
//
// At the base (no /api/remotes) every check after the two engines start fails.

import { spawn, spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import path from 'node:path'

import { runDesktop } from '../desktop.mjs'
import { RIG_DIR, assertSafeRoot, cleanEnv, fakeHome, freePort, killTree, rigProfileEnv, touch } from '../lib.mjs'
import { Proof } from '../proof.mjs'

const sleep = ms => new Promise(r => setTimeout(r, ms))
const NAME = 'Galaxy'
const STREAMED = 'Streaming over the relay: alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa.'
/** what the planted desktop bridge reports as the app version (the status strip shows it) */
const VERSION = `${JSON.parse(fs.readFileSync(path.join(RIG_DIR, '..', '..', 'package.json'), 'utf8')).version}-rig`
const OFFLINE = `${NAME} is offline. Nothing was sent.`
const REVOKED = `${NAME} no longer accepts this computer's token. Nothing was sent.`
/** What the far engine's agents do: `lead` streams a long answer slowly and asks the user a question on request. */
const SCENARIO = {
  agents: { lead: { turns: [
    { name: 'stream', match: ['stream please'], steps: [{ text: STREAMED, chunk: 6, delay_ms: 160 }] },
    { name: 'ask', match: ['ask me'], steps: [
      { tool: 'orgtree_ask', args: { question: 'Which colour should the far engine use?', header: 'Colour', options: [{ label: 'Blue' }, { label: 'Green' }] } },
      { text: 'Asked.' }] },
  ] } },
  default: { turns: [{ name: 'default', steps: [{ text: 'OK.' }] }] },
}
/** The docket item of the far organization that shares this computer's organization's name. */
const PLAN = 'twin-plan'

export function setup() { return { fixture: 'basic' } }

/** The Windows session this process runs in (tasklist), or null. */
function sessionId() {
  if (process.platform !== 'win32') return null
  const r = spawnSync('tasklist', ['/FI', `PID eq ${process.pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true })
  const n = Number((r.stdout ?? '').trim().split('\n')[0]?.match(/"([^"]*)"/g)?.[3]?.slice(1, -1))
  return Number.isInteger(n) ? n : null
}

/** The far engine: `orgtree-engine standalone` on its own data root under the
 * run folder, so the run's cleanup takes it with everything else. */
function farEngine(rig) {
  const dir = path.join(rig.dir, 'far')
  const data = path.join(dir, 'data')
  assertSafeRoot(data)
  fs.mkdirSync(path.join(dir, 'tmp'), { recursive: true })
  fs.mkdirSync(data, { recursive: true })
  fs.writeFileSync(path.join(data, '.orgtree-rig-root'), JSON.stringify({ rig: 1, created: new Date().toISOString(), run: rig.run.id, role: 'the far standalone engine of proofs/remote-org.mjs' }))
  fakeHome(data)
  fs.mkdirSync(path.join(dir, 'fakecli', 'log'), { recursive: true })
  // `twin` lives in the far organization named like this computer's own, and names its item as that engine does
  const scenario = { ...SCENARIO, agents: { ...SCENARIO.agents, twin: { turns: [
    { name: 'cite', match: ['cite the plan'], steps: [{ text: `See @item:${rig.org}/${PLAN} for the plan.` }] }] } } }
  fs.writeFileSync(path.join(dir, 'fakecli', 'scenario.json'), JSON.stringify(scenario, null, 2))
  const bin = name => path.join(rig.dir, 'bin', name)
  const far = { dir, data, port: 0, token: '', child: null, exit: null, ready: null, stderr: '', starts: 0 }
  far.start = async () => {
    if (!far.port) far.port = await freePort()
    const env = {
      ...cleanEnv(),
      ...rigProfileEnv(data, { tmp: path.join(dir, 'tmp') }),
      ORGTREE_DATA: data,
      ORGTREE_P03_PG_BIN: rig.run.pgBin,
      ORGTREE_ENGINE_SAFE_START: '1',
      ORGTREE_ENGINE_RIG: '1',
      ORGTREE_NET_OFFLINE: '1',
      ORGTREE_LOG_VERBOSE: '1',
      ORGTREE_BIND: '127.0.0.1',
      ORGTREE_PORT: String(far.port),
      ORGTREE_CLAUDE_BIN: bin('claude.exe'),
      ORGTREE_CODEX_BIN: bin('codex.exe'),
      ORGTREE_AGY_BIN: bin('agy.exe'),
      ORGTREE_OPENCODE_BIN: bin('opencode.exe'),
      ORGTREE_MUSE_BIN: bin('muse-bin-9.9.9-R0.exe'),
      ORGTREE_TAILSCALE_BIN: bin('tailscale.cmd'),
      ORGTREE_FAKECLI_DIR: path.join(dir, 'fakecli'),
      ORGTREE_FAKECLI_HOME: path.join(data, 'rig-home'),
    }
    far.ready = null
    far.exit = null
    far.stderr = ''
    far.starts += 1
    // the run's own copy of the engine: a process under the run folder, which the run's reap finds
    const child = spawn(bin('orgtree-engine.exe'), ['standalone'], { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    far.child = child
    let buf = ''
    child.stdout.on('data', d => {
      buf += d.toString()
      for (const line of buf.split('\n')) { try { const v = JSON.parse(line); if (v.type === 'ready') far.ready = v } catch { /* not a protocol line */ } }
      buf = buf.slice(buf.lastIndexOf('\n') + 1)
    })
    child.stderr.on('data', d => { far.stderr = (far.stderr + d.toString()).slice(-4000) })
    child.on('exit', code => { if (far.child === child) far.exit = code ?? -1 })
    const end = Date.now() + 240000
    while (!far.ready) {
      if (far.exit !== null) throw new Error(`the far engine exited ${far.exit} before it was ready: ${far.stderr.slice(-600)}`)
      if (Date.now() > end) throw new Error('the far engine was not ready in 240 s')
      touch(rig.dir)
      await sleep(250)
    }
    far.token = fs.readFileSync(path.join(data, 'standalone-token'), 'utf8').trim()
    return far.ready
  }
  far.api = async (method, route, body) => {
    const res = await fetch(`http://127.0.0.1:${far.port}${route}`, { method, headers: { Authorization: `Bearer ${far.token}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(120000) })
    const text = await res.text()
    let json = null
    try { json = JSON.parse(text) } catch { /* not JSON */ }
    if (!res.ok) throw new Error(`far ${method} ${route} -> ${res.status}: ${json?.detail ?? text.slice(0, 300)}`)
    return json ?? text
  }
  /** Stop it as its operator would (the authenticated shutdown), then make sure. */
  far.stop = async () => {
    if (!far.child || far.exit !== null) return
    try { await far.api('POST', '/api/desktop/shutdown') } catch { /* already going */ }
    const end = Date.now() + 60000
    while (far.exit === null && Date.now() < end) await sleep(200)
    if (far.exit === null) { killTree(far.child.pid); await sleep(500) }
  }
  far.fakeLog = agent => {
    const f = path.join(dir, 'fakecli', 'log', `${agent}.jsonl`)
    return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split(/\r?\n/).filter(Boolean).map(l => { try { return JSON.parse(l) } catch { return { kind: 'unparsed' } } }) : []
  }
  return far
}

/** The network between the two engines: a loopback port that forwards to the
 * far engine while it is open. `cut` resets every connection and stops
 * listening; `restore` listens on the same port again. */
function forwarder(target) {
  const sockets = new Set()
  let server = null
  const link = { port: 0, open: false }
  link.restore = () => new Promise((resolve, reject) => {
    server = net.createServer(client => {
      const upstream = net.connect(target(), '127.0.0.1')
      for (const s of [client, upstream]) { sockets.add(s); s.on('close', () => sockets.delete(s)); s.on('error', () => { /* a reset is the point */ }) }
      client.pipe(upstream)
      upstream.pipe(client)
      client.on('close', () => upstream.destroy())
      upstream.on('close', () => client.destroy())
    })
    server.once('error', reject)
    server.listen(link.port, '127.0.0.1', () => { link.port = server.address().port; link.open = true; resolve(link.port) })
  })
  link.cut = () => new Promise(resolve => {
    if (!link.open) return resolve()
    link.open = false
    server.close(() => resolve())
    for (const s of sockets) s.destroy()
  })
  return link
}

/** Steps the page script asks for while its window stays open: POST <url><name>. */
function control(handlers) {
  const key = crypto.randomBytes(8).toString('hex')
  const server = http.createServer(async (req, res) => {
    const name = req.url.startsWith(`/${key}/`) ? req.url.slice(key.length + 2) : ''
    const fn = handlers[name]
    if (req.method !== 'POST' || !fn) { res.writeHead(404).end(); return }
    try {
      const out = await fn()
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(out ?? { ok: true }))
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: String(e?.message ?? e) }))
    }
  })
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({
    url: `http://127.0.0.1:${server.address().port}/${key}/`,
    close: () => new Promise(done => { server.close(() => done()); server.closeAllConnections?.() }),
  })))
}

export default async function (rig) {
  const proof = new Proof('remote-org')
  const ui = !!rig.run.ui
  const session = sessionId()
  if (ui && session !== 0) {
    proof.check('the desktop part runs in Windows Session 0 only', false, { session, hint: 'orgtree_session use=0, or run without a renderer bundle for the engine part' })
    return proof.summary()
  }
  const far = farEngine(rig)
  const link = forwarder(() => far.port)
  let ctl = null
  const local = rig.org
  /** This computer's engine, with or without a window's header; never throws on a refusal. */
  const near = async (method, route, { body, remote } = {}) => {
    touch(rig.dir)
    const res = await fetch(rig.url + route, { method, headers: { 'X-Orgtree-Desktop-Token': rig.token, 'Content-Type': 'application/json', ...(remote ? { 'X-Orgtree-Remote': remote } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(60000) })
    const text = await res.text()
    let json = null
    try { json = JSON.parse(text) } catch { /* not JSON */ }
    return { status: res.status, json, text, stamp: res.headers.get('x-orgtree-instance') ?? '' }
  }
  const remotes = async () => (await near('GET', '/api/remotes')).json?.remotes ?? []
  const state = async (want, timeout, what) => rig.waitFor(async () => {
    const r = (await remotes())[0]
    return r && (Array.isArray(want) ? want.includes(r.state) : r.state === want) ? r : null
  }, { timeout, every: 250, what: what ?? `the connection to be ${want}` })
  const farTurns = () => far.fakeLog('lead').filter(l => l.kind === 'turn').length
  let id = null
  /** the instance stamp a window of the remote organization last got */
  let stamp = ''

  // what each step of an outage means for the engine, asked for by the window (or run in order without one)
  const steps = {
    /** the network goes: this computer knows within seconds, says so beforehand and sends nothing */
    async cut() {
      const before = farTurns()
      const at = Date.now()
      await link.cut()
      const view = await state('offline', 15000)
      proof.check('a cut link is known as offline within 5 s', Date.now() - at < 5000, { ms: Date.now() - at })
      proof.check('the connection says beforehand what a change would get', view.refusal === OFFLINE, view.refusal)
      const refused = await near('POST', '/api/orgs/far-lab/nodes/lead/message', { body: { text: 'must not arrive' } })
      proof.check('a change while offline is refused at once with the sentence', refused.status === 503 && refused.json?.detail === OFFLINE && refused.json?.remote?.state === 'offline',
        { status: refused.status, body: refused.json })
      const list = (await near('GET', '/api/orgs')).json ?? []
      proof.check('the remote organizations stay in the list while their engine is away', ['far-lab', 'rig-org-galaxy'].every(a => list.some(o => o.slug === a && o.remote?.state === 'offline')),
        list.map(o => [o.slug, o.remote?.state ?? 'local']))
      await sleep(1500)
      proof.check('nothing reached the remote engine', !far.fakeLog('lead').some(l => JSON.stringify(l).includes('must not arrive')), { turnsBefore: before, turnsAfter: farTurns() })
      return { sentence: view.refusal }
    },
    /** the network is back: the link returns by itself */
    async restore() {
      const at = Date.now()
      await link.restore()
      const view = await state('connected', 45000, 'the link to come back by itself')
      proof.check('the link comes back by itself after the network returns', view.refusal === null && view.last_error === null, { ms: Date.now() - at, refusal: view.refusal })
      return { ms: Date.now() - at }
    },
    /** the remote engine stops and starts again: a new process, so its windows reload */
    async 'far-stop'() {
      await far.stop()
      const view = await state('offline', 20000)
      proof.check('a stopped remote engine is offline here', view.refusal === OFFLINE, view.refusal)
      return { ok: true }
    },
    async 'far-start'() {
      const stampBefore = stamp
      await far.start()
      await state('connected', 60000, 'the link to the restarted remote engine')
      const now = (await near('GET', '/api/orgs/far-lab', { remote: id })).stamp
      proof.check('a restarted remote engine changes the stamp of its windows', !!stampBefore && now.includes('~') && now !== stampBefore
        && now.split('~')[0] === stampBefore.split('~')[0], { before: stampBefore, now })
      stamp = now
      return { ok: true }
    },
    /** the remote engine's operator revokes this computer's token */
    async revoke() {
      const own = (await remotes())[0]?.client_name
      const clients = (await far.api('GET', '/api/standalone/clients')).clients ?? []
      const mine = clients.filter(c => c.name === own)
      proof.check('the remote engine lists this computer under its own name', mine.length === 1 && /^Orgtree desktop \(.+\)$/.test(own ?? ''), { own, clients: clients.map(c => c.name) })
      for (const c of mine) await far.api('DELETE', `/api/standalone/clients/${c.id}`)
      const view = await state('auth_failed', 60000, 'the revoked token to be noticed')
      proof.check('a revoked token is its own state, with its own sentence', view.refusal === REVOKED && view.error_code === 'E10', { refusal: view.refusal, code: view.error_code })
      return { sentence: view.refusal }
    },
    /** a question waits in the remote organization: it is among this computer's notices, and says where it is */
    async notices() {
      const found = await rig.waitFor(async () => {
        const all = (await near('GET', '/api/desktop/notifications')).json?.notices ?? []
        return all.find(n => n.org === 'far-lab' && n.kind === 'question') ?? null
      }, { timeout: 30000, every: 250, what: "the remote organization's question among this computer's notices" }).catch(() => null)
      proof.check("a question in a remote organization is among this computer's notices, titled with the organization and the connection",
        !!found && String(found.title).startsWith(`Far Lab \u00b7 ${NAME}: `) && found.agent === 'lead', found ? { org: found.org, title: found.title, kind: found.kind } : null)
      const copy = (await near('GET', '/api/app/records')).json ?? {}
      const inFeed = Object.values(copy.notices ?? {}).flatMap(n => n?.notices ?? []).filter(n => n?.org === 'far-lab')
      proof.check("a window's app feed carries it under the name this computer lists the organization by", !!found && inFeed.some(n => n.id === found.id), inFeed.map(n => [n.org, n.title]))
      return { title: found?.title ?? null }
    },
    /** the token the window asks for after a revocation (headless: given through the route) */
    async 'new-token'() {
      const r = await near('PATCH', `/api/remotes/${id}`, { body: { token: far.token } })
      proof.check('a new token is accepted', r.status === 200, { status: r.status, detail: r.json?.detail })
      return { ok: true }
    },
    async 'after-new-token'() {
      const view = await state('connected', 30000)
      const clients = (await far.api('GET', '/api/standalone/clients')).clients ?? []
      proof.check('with a new token this computer has its own token there again', view.own_token === true && clients.some(c => c.name === view.client_name), { own: view.client_name, clients: clients.map(c => c.name) })
      return { ok: true }
    },
  }

  try {
    // ------------------------------------------------------------ two engines
    const ready = await far.start()
    proof.check('a second engine runs in standalone mode on a synthetic root', ready.port === far.port && far.token.length === 64, { port: ready.port })
    const made = await far.api('POST', '/api/orgs', { name: 'Far Lab', dirs: [], net_autoconnect: false })
    await far.api('POST', `/api/orgs/${made.slug}/ops`, { op: 'hire', name: 'lead', tier: 'opus', grant: 24, title: 'Far lead', charter: 'You lead the far org. You exist only in test runs.' })
    await far.api('POST', `/api/orgs/${made.slug}/ops`, { op: 'hire', name: 'scout', tier: 'haiku', parent: 'lead', title: 'Scout' })
    // an organization with the very slug of this computer's own: it must get another name here
    const twin = await far.api('POST', '/api/orgs', { name: 'Rig Org', dirs: [], net_autoconnect: false })
    await far.api('POST', `/api/orgs/${twin.slug}/ops`, { op: 'hire', name: 'twin', tier: 'haiku', grant: 4, title: 'The other Rig Org' })
    const item = await far.api('POST', '/api/rig/tool', { org: made.slug, agent: 'lead', tool: 'orgtree_work',
      args: { action: 'create', kind: 'code', title: 'Far smoke item', objective: 'A docket item on the far engine.\n\nNothing depends on it.', owner: 'lead' } })
    const doc = await far.api('POST', '/api/rig/tool', { org: made.slug, agent: 'lead', tool: 'orgtree_present',
      args: { title: 'Far report', body: '# Far report\n\nPresented on the far engine.' } })
    proof.check('the far engine has two organizations, a docket item and a presentation', made.slug === 'far-lab' && twin.slug === local && item.ok && doc.ok,
      { orgs: [made.slug, twin.slug], item: item.text?.slice(0, 80), doc: doc.text?.slice(0, 80) })
    const plan = await far.api('POST', '/api/rig/tool', { org: twin.slug, agent: 'twin', tool: 'orgtree_work',
      args: { action: 'create', kind: 'code', title: 'Twin plan', objective: 'A docket item of the far organization that shares a name with one here.\n\nNothing depends on it.', owner: 'twin' } })
    proof.check('the far organization of the shared name has a docket item', plan.ok && String(plan.text).includes(PLAN), { item: plan.text?.slice(0, 120) })
    await link.restore()
    const address = `http://127.0.0.1:${link.port}`
    const none = await near('GET', '/api/remotes')
    proof.check('this computer starts with no remote engines', none.status === 200 && Array.isArray(none.json?.remotes) && none.json.remotes.length === 0, { status: none.status })
    const plain = (await near('GET', `/api/orgs/${local}`)).stamp
    ctl = await control(steps)

    // ------------------------------------------------------------ add it
    let desktop = null
    if (ui) {
      const added = await runDesktop(rig, path.join(RIG_DIR, 'desktop', 'remote-org.cjs'), { org: '', preset: '1000x700', timeout: 240000,
        out: path.join(proof.dir, 'desktop-add'), args: { stage: 'add', address, token: far.token, name: NAME, version: VERSION } })
      desktop = { add: added }
      proof.check('the Add dialog on the Homepage adds the engine and the list marks its organizations', added.ok && added.value?.homepage === true
        && added.value?.rows?.filter(r => r.remote).length === 2 && added.value.head === NAME && !added.value.error,
        added.ok ? { homepage: added.value.homepage, head: added.value.head, rows: added.value.rows } : { error: added.error })
      proof.check('the dialog never shows the token', added.ok && added.value.tokenFieldType === 'password' && added.value.tokenOnPage === false, added.value && { type: added.value.tokenFieldType, onPage: added.value.tokenOnPage })
      proof.note('desktop receipt (add)', { session: added.session, guards: added.guards, shots: added.shots?.map(s => path.basename(s.file)) })
    } else {
      const added = await near('POST', '/api/remotes', { body: { url: address, token: far.token, name: NAME } })
      proof.check('POST /api/remotes adds the engine', added.status === 200 && added.json?.name === NAME, { status: added.status, detail: added.json?.detail })
    }
    const view = await state('connected', 30000)
    id = view.id
    const aliases = Object.fromEntries(view.orgs.map(o => [o.remote_slug, o.alias]))
    proof.check('the connection is connected, over loopback, with its own token', view.transport === 'loopback' && view.own_token === true
      && /^Orgtree desktop \(.+\)$/.test(view.client_name ?? '') && view.refusal === null, { transport: view.transport, client: view.client_name, version: view.version })
    proof.check('an organization keeps its slug when free and takes the engine tag when this computer holds it', aliases['far-lab'] === 'far-lab' && aliases[local] === `${local}-galaxy`, aliases)
    const saved = fs.readFileSync(path.join(rig.data, 'remote-engines.json'), 'utf8')
    proof.check('the token is nowhere in the list, the saved file or the engine log', !JSON.stringify(await remotes()).includes(far.token) && !saved.includes(far.token)
      && saved.includes('sealed_token') && !rig.engineLog().includes(far.token), { savedBytes: saved.length })
    const list = (await near('GET', '/api/orgs')).json ?? []
    proof.check('the merged list has the local organization unmarked and the remote ones marked', list.some(o => o.slug === local && !o.remote)
      && ['far-lab', `${local}-galaxy`].every(a => list.some(o => o.slug === a && o.remote?.name === NAME && o.remote?.state === 'connected')), list.map(o => [o.slug, o.remote?.name ?? 'local']))

    // ------------------------------------------------------------ the relay
    const farTree = await near('GET', '/api/orgs/far-lab')
    proof.check('the alias path reads the remote organization', farTree.status === 200 && farTree.json?.name === 'Far Lab' && farTree.text.includes('"scout"'), { status: farTree.status, name: farTree.json?.name })
    const there = await near('GET', `/api/orgs/${local}-galaxy`)
    const here = await near('GET', `/api/orgs/${local}`)
    proof.check('two organizations of one slug stay two', there.text.includes('"twin"') && !there.text.includes('"boss"') && here.text.includes('"boss"') && !here.text.includes('"twin"'),
      { there: there.status, here: here.status })
    const windowed = await near('GET', `/api/orgs/${local}`, { remote: id })
    stamp = windowed.stamp
    proof.check("a remote window's requests name the remote slug and are stamped with both processes", windowed.text.includes('"twin"') && windowed.stamp.includes('~')
      && !plain.includes('~') && windowed.stamp.split('~')[0] === plain, { plain, windowed: windowed.stamp })
    proof.check('a local organization answers as before', here.stamp === plain && !here.stamp.includes('~'), { stamp: here.stamp })

    // ------------------------------------------------------------ the app feed of a remote window
    const values = async remote => (await near('GET', '/api/app/records', { remote })).json?.runtime?.values ?? {}
    const farValues = (await far.api('GET', '/api/app/records')).runtime?.values ?? {}
    const [remoteWindow, localWindow] = [await values(id), await values(null)]
    const engineKeys = Object.keys(farValues).filter(k => k !== 'remotes' && k !== 'remote_link')
    const differ = engineKeys.filter(k => JSON.stringify(remoteWindow[k]?.value) !== JSON.stringify(farValues[k]?.value))
    proof.check("a remote window's app feed carries its connection, this computer's connections and the remote engine's values",
      remoteWindow.remote_link?.value?.id === id && remoteWindow.remote_link?.value?.state === 'connected' && remoteWindow.remotes?.value?.[0]?.id === id
      && engineKeys.length > 0 && differ.length === 0, { link: remoteWindow.remote_link?.value?.state, keys: engineKeys, differ })
    proof.check("a local window's app feed has no connection of its own and still lists the connections", !('remote_link' in localWindow) && localWindow.remotes?.value?.[0]?.id === id,
      { keys: Object.keys(localWindow) })

    // ------------------------------------------------------------ the window, or the routes alone
    if (ui) {
      const used = await runDesktop(rig, path.join(RIG_DIR, 'desktop', 'remote-org.cjs'), { org: 'far-lab', preset: '1000x700', timeout: 600000,
        out: path.join(proof.dir, 'desktop-window'), args: { stage: 'window', org: 'far-lab', version: VERSION, control: ctl.url, name: NAME, token: far.token,
          streamed: STREAMED, offline: OFFLINE } })
      desktop.window = used
      const v = used.value ?? {}
      proof.note('desktop receipt (window)', { session: used.session, guards: used.guards, shots: used.shots?.map(s => path.basename(s.file)), consoleErrors: used.consoleErrors?.slice(0, 8) })
      proof.check('the remote organization opens in a normal organization window', used.ok && v.opened?.shell === true && v.opened?.title?.includes(`Far Lab · ${NAME}`)
        && v.opened?.cards?.includes('lead') && v.opened?.cards?.includes('scout'), used.ok ? v.opened : { error: used.error })
      proof.check('the status strip chip shows the connection and opens its details', v.chip?.text?.includes(NAME) && v.chip?.tone === 'ok' && v.details?.State?.startsWith('connected')
        && v.details?.Transport === 'This computer (forwarded port)' && /^Orgtree desktop \(/.test(v.details?.['Signed in as'] ?? '') && v.details?.Organizations?.includes('Far Lab'), { chip: v.chip, details: v.details })
      proof.check('a message sent from the desk is answered, and the answer streams in', v.stream?.final === true && v.stream?.partials >= 2, v.stream)
      proof.check('an agent is hired and retired from the canvas', v.hire?.hired === true && v.hire?.retired === true, v.hire)
      proof.check("an agent's question is answered in the window", v.ask?.asked === true && v.ask?.answered === true, v.ask)
      proof.check('the answer reached the remote agent', far.fakeLog('lead').some(l => l.kind === 'turn' && JSON.stringify(l).includes('Blue')))
      proof.check('the window asked for the notice while the question waited', typeof v.ask?.notice?.title === 'string', v.ask?.notice)
      const cleared = await rig.waitFor(async () => !((await near('GET', '/api/desktop/notifications')).json?.notices ?? []).some(n => n.org === 'far-lab' && n.kind === 'question'),
        { timeout: 30000, every: 250, what: 'the answered question to leave the notices' }).catch(() => false)
      proof.check("an answered question leaves this computer's notices", cleared === true)
      proof.check('the inbox, the docket and the presentations open', v.tabs?.docket?.includes('Far smoke item') && v.tabs?.presented?.includes('Far report') && v.tabs?.inbox === true && v.tabs?.userInbox === true, v.tabs)
      proof.check('the offline banner shows, the canvas is dimmed and the chip turns', v.offline?.banner?.includes(`${NAME} is offline since`) && v.offline?.dimmed === true && v.offline?.chip?.includes('offline'), v.offline)
      proof.check('a send while offline leaves the draft in the composer and shows the sentence', !!v.offline?.typed && v.offline?.draft === v.offline?.typed
        && v.offline?.toasts?.some(t => t.includes(OFFLINE)) === true && v.offline?.ghosts === 0, v.offline)
      proof.check('a change from the window is refused with the sentence', v.offline?.hire?.status === 503 && v.offline?.hire?.detail === OFFLINE, v.offline?.hire)
      proof.check('the window recovers by itself, without a reload, and the kept draft is sent', v.recovered?.banner === 'gone' && v.recovered?.reloaded === false && v.recovered?.dimmed === false
        && v.recovered?.draftStillThere === true && v.recovered?.sent === true, v.recovered)
      proof.check('a restarted remote engine reloads its window, which is live again', v.restart?.offlineBanner === true && v.restart?.reloaded === true && v.restart?.cards?.includes('lead') && v.restart?.chip === 'ok', v.restart)
      proof.check('a revoked token shows the sign-in banner, and a new token brings the window back', v.revoked?.banner?.includes('no longer accepts this computer') && v.revoked?.action === 'Enter a new token'
        && v.revoked?.after === 'ok', v.revoked)
      await steps['after-new-token']()
      const beside = await runDesktop(rig, path.join(RIG_DIR, 'desktop', 'remote-org.cjs'), { org: local, preset: '1000x700', timeout: 180000,
        out: path.join(proof.dir, 'desktop-local'), args: { stage: 'local', org: local, name: NAME, version: VERSION } })
      desktop.local = beside
      const l = beside.value ?? {}
      proof.note('desktop receipt (local)', { session: beside.session, guards: beside.guards, shots: beside.shots?.map(s => path.basename(s.file)) })
      proof.check('a local organization on the same desktop looks and works as before', beside.ok && l.shell === true && l.chip === false && l.banner === false && l.dimmed === false && l.title === 'Rig Org — Orgtree'
        && l.cards?.includes('boss') && l.answered === true && l.stamp && !l.stamp.includes('~'), beside.ok ? l : { error: beside.error })
      // the remote organization whose name is taken here: what depends on the computer, and its references
      const alias = `${local}-galaxy`
      const shared = await runDesktop(rig, path.join(RIG_DIR, 'desktop', 'remote-org.cjs'), { org: alias, preset: '1000x700', timeout: 420000,
        out: path.join(proof.dir, 'desktop-here'), args: { stage: 'here', org: alias, agent: 'twin', name: NAME, version: VERSION } })
      desktop.here = shared
      const h = shared.value ?? {}
      proof.note('desktop receipt (here)', { session: shared.session, guards: shared.guards, shots: shared.shots?.map(s => path.basename(s.file)), consoleErrors: shared.consoleErrors?.slice(0, 8) })
      proof.check('the remote organization of the shared name opens under its alias', shared.ok && h.title?.includes(`Rig Org \u00b7 ${NAME}`) && h.chip?.includes(NAME), shared.ok ? { title: h.title, chip: h.chip } : { error: shared.error })
      proof.check('a folder of a remote organization is not opened on this computer; the window says where it is', h.folder === `This folder is on ${NAME}, not on this computer.`
        && Array.isArray(h.native) && !h.native.includes('openAgentScratchFolder'), { folder: h.folder, native: h.native })
      proof.check("a reference written there under the name the organization has there is this window's own item", Array.isArray(h.ref?.chips) && h.ref.chips.length === 1
        && /\bref-ready\b/.test(h.ref.chips[0].cls), h.ref)
      proof.check("App settings says whose settings it shows and marks what is this computer's", h.note === `These settings belong to ${NAME}, the remote engine this organization runs on. Tabs and groups marked \u201cThis computer\u201d belong to this app on this computer.`
        && h.tabs?.Streaming === 'this computer' && h.tabs?.['Mail hub'] === 'this computer' && h.tabs?.About === 'this computer' && h.tabs?.Providers === '' && h.tabs?.Runtime === ''
        && h.display?.Desk === true && h.display?.Startup === true && h.display?.Typing === false && h.runtime?.Turns === false && Object.values(h.runtime ?? {}).includes(true),
        { note: h.note, tabs: h.tabs, display: h.display, runtime: h.runtime })
      proof.check('a provider sign-in is not started on this computer; the window says to sign in there', h.signIn?.length > 0 && h.signIn.every(s => s.startsWith(`Sign in on ${NAME} itself`))
        && h.signInButtons?.every(b => b === 'Copy path') && !h.native?.includes('startProviderLogin'), { signIn: h.signIn, buttons: h.signInButtons, native: h.native })
      proof.check('the folder picker says whose folders it lists', h.picker?.title === `choose a folder on ${NAME}`
        && h.picker?.hint === `These are folders on ${NAME}, the remote engine this organization runs on.` && h.picker?.top === NAME, h.picker)
      proof.file('desktop.json', { add: desktop.add?.value, window: v, local: l, here: h, sessions: { add: desktop.add?.session, window: used.session, local: beside.session, here: shared.session },
        guards: { add: desktop.add?.guards, window: used.guards, local: beside.guards, here: shared.guards } })
    } else {
      const before = farTurns()
      const asked = await near('POST', '/api/orgs/far-lab/nodes/lead/message', { body: { text: 'ask me a question' } })
      proof.check('a message that makes the remote agent ask goes through the relay', asked.status === 200, { status: asked.status, detail: asked.json?.detail })
      await rig.waitFor(() => farTurns() > 0, { timeout: 150000, what: 'the remote agent to take the message' })
      await steps.notices()
      const sent = await near('POST', '/api/orgs/far-lab/nodes/lead/message', { body: { text: 'stream please' } })
      proof.check('a message for a remote agent goes through the relay', sent.status === 200, { status: sent.status, detail: sent.json?.detail })
      // In Session 0 with a user signed in, an engine holds its first turns for the sign-in helper until 60 s
      // after its start (runtime/actor.rs session_settle); the far engine has only just started.
      await rig.waitFor(() => farTurns() > before, { timeout: 150000, what: 'the remote agent to take the message' })
      const chat = await rig.waitFor(async () => { const c = await near('GET', '/api/orgs/far-lab/nodes/lead/chat?last=50'); return c.text.includes('papa.') ? c : null },
        { timeout: 60000, what: 'the streamed answer in the relayed transcript' })
      proof.check('its answer is read back through the relay', chat.status === 200)
      await steps.cut()
      await steps.restore()
      const again = await near('POST', '/api/orgs/far-lab/nodes/lead/message', { body: { text: 'after the outage' } })
      proof.check('a message goes through again after the outage', again.status === 200, { status: again.status })
      await steps['far-stop']()
      await steps['far-start']()
      await steps.revoke()
      await steps['new-token']()
      await steps['after-new-token']()
    }

    // ------------------------------------------------------------ the local organization, and the end
    const relayLines = () => rig.engineLog().split(/\r?\n/).filter(l => / RELAY /.test(l))
    const relayedBefore = relayLines().length
    const bossBefore = rig.fakeLog('boss').filter(l => l.kind === 'turn').length
    await rig.userMail('boss', 'a local message beside a remote engine')
    await rig.waitFor(() => rig.fakeLog('boss').filter(l => l.kind === 'turn').length > bossBefore, { timeout: 60000, what: 'the local agent to take its message' })
    const localChat = await near('GET', `/api/orgs/${local}/nodes/boss/chat?last=20`)
    const relayed = relayLines()
    proof.check('a local organization is served here and nothing of it is relayed', localChat.status === 200 && !localChat.stamp.includes('~') && relayedBefore > 0
      && relayed.length === relayedBefore && relayed.every(l => l.includes('RELAY galaxy ')), { relayed: relayed.length, sample: relayed.slice(0, 2).map(l => l.slice(l.indexOf('RELAY'))) })
    const removed = await near('DELETE', `/api/remotes/${id}`)
    const after = (await near('GET', '/api/orgs')).json ?? []
    const left = (await far.api('GET', '/api/standalone/clients')).clients ?? []
    proof.check('removing the connection revokes this computer there and takes its organizations out of the list', removed.status === 200 && removed.json?.revoked === true
      && after.every(o => !o.remote) && after.some(o => o.slug === local) && !left.some(c => /^Orgtree desktop \(/.test(c.name)), { removed: removed.json, list: after.map(o => o.slug), clients: left.map(c => c.name) })
    proof.file('near-relay.log', relayed.join('\n'))
  } catch (e) {
    proof.check(`the proof ran to its end (${String(e?.message ?? e).slice(0, 300)})`, false)
  } finally {
    try { await ctl?.close() } catch { /* closing */ }
    try { await link.cut() } catch { /* closing */ }
    try { await far.stop() } catch { /* the run's reap takes what is left */ }
    if (far.child && far.exit === null) killTree(far.child.pid)
    proof.file('far-fakecli-lead.jsonl', far.fakeLog('lead').map(l => JSON.stringify(l)).join('\n'))
  }
  return proof.summary()
}
