// tools/rig/far.mjs: a second engine for a rig run: "the remote engine" of the
// remote-organization proofs (docs/rust-engine/remote-org.md). In standalone
// mode by default; with `desktop` it is somebody's own desktop engine, which
// lets other computers in through its remote door ("A desktop as host").
//
// It is the run's own copy of the debug engine, started on a synthetic data
// root inside the run folder (fake home, fake CLIs, offline, loopback only),
// so the run's cleanup takes it with everything else. Nothing here reaches a
// real engine, a real sign-in or the network.

import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { assertSafeRoot, cleanEnv, fakeHome, freePort, killTree, rigProfileEnv, touch } from './lib.mjs'

const sleep = ms => new Promise(r => setTimeout(r, ms))

/** The far engine of the run `rig`. `scenario` is what its fake CLIs do
 * (tools/rig/fakecli); `role` says in the root's marker which proof it serves.
 * `desktop: { computer }` makes it a desktop's own engine instead of a
 * standalone one: it is started as an app starts its engine (`serve`, a
 * desktop token, a port it picks itself), it is called `computer`, and its
 * remote door stands on loopback (`ORGTREE_RIG_REMOTE_DOOR`, which only a rig
 * run of a debug build reads). `far.door` is a request at that door.
 * Nothing runs until `start()`. */
export function farEngine(rig, { scenario, role, desktop = null }) {
  const dir = path.join(rig.dir, 'far')
  const data = path.join(dir, 'data')
  assertSafeRoot(data)
  fs.mkdirSync(path.join(dir, 'tmp'), { recursive: true })
  fs.mkdirSync(data, { recursive: true })
  fs.writeFileSync(path.join(data, '.orgtree-rig-root'), JSON.stringify({ rig: 1, created: new Date().toISOString(), run: rig.run.id, role }))
  fakeHome(data)
  fs.mkdirSync(path.join(dir, 'fakecli', 'log'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'fakecli', 'scenario.json'), JSON.stringify(scenario, null, 2))
  const bin = name => path.join(rig.dir, 'bin', name)
  const far = { dir, data, port: 0, token: '', child: null, exit: null, ready: null, stderr: '', starts: 0 }
  far.start = async () => {
    if (desktop) far.token ||= crypto.randomBytes(32).toString('hex')
    else if (!far.port) far.port = await freePort()
    const env = {
      ...cleanEnv(),
      ...rigProfileEnv(data, { tmp: path.join(dir, 'tmp') }),
      ORGTREE_DATA: data,
      ORGTREE_P03_PG_BIN: rig.run.pgBin,
      ORGTREE_ENGINE_SAFE_START: '1',
      ORGTREE_ENGINE_RIG: '1',
      ORGTREE_NET_OFFLINE: '1',
      ORGTREE_LOG_VERBOSE: '1',
      ...(desktop ? {
        ORGTREE_V2_TOKEN: far.token,
        // it ends with this run, as an app's engine ends with its app
        ORGTREE_V2_PARENT_PID: String(process.pid),
        ORGTREE_ENGINE_ALLOW_INITDB: '1',
        ORGTREE_RIG_REMOTE_DOOR: '127.0.0.1',
        COMPUTERNAME: desktop.computer,
        // with a renderer bundle its own windows can be opened too (the hosting side's screens)
        ...(rig.run.ui ? { ORGTREE_V2_UI_DIR: rig.run.ui } : {}),
      } : { ORGTREE_BIND: '127.0.0.1', ORGTREE_PORT: String(far.port) }),
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
    const child = spawn(bin('orgtree-engine.exe'), [desktop ? 'serve' : 'standalone'], { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
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
    if (desktop) far.port = far.ready.port
    else far.token = fs.readFileSync(path.join(data, 'standalone-token'), 'utf8').trim()
    far.url = `http://127.0.0.1:${far.port}`
    return far.ready
  }
  const send = async (base, method, route, headers, body) => {
    touch(rig.dir)
    const res = await fetch(base + route, { method, headers: { ...headers, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(120000) })
    const text = await res.text()
    let json = null
    try { json = JSON.parse(text) } catch { /* not JSON */ }
    return { status: res.status, json, text }
  }
  /** One request with `token` (the startup token unless another is given; a desktop's own app sends its
   *  desktop token in its own header). Never throws on a refusal. */
  far.call = (method, route, { body, token } = {}) => send(`http://127.0.0.1:${far.port}`, method, route,
    desktop ? { 'X-Orgtree-Desktop-Token': token ?? far.token } : { Authorization: `Bearer ${token ?? far.token}` }, body)
  /** One request at a desktop's remote door on `port`, as another computer sends it: `token` is a one-time
   *  code or that computer's own token, or nothing. Never throws on a refusal. */
  far.door = (port, method, route, { body, token, headers } = {}) => send(`http://127.0.0.1:${port}`, method, route,
    { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers }, body)
  /** The same with the startup token, as its operator: the answer, or an error for a refusal. */
  far.api = async (method, route, body) => {
    const res = await far.call(method, route, { body })
    if (res.status < 200 || res.status > 299) throw new Error(`far ${method} ${route} -> ${res.status}: ${res.json?.detail ?? res.text.slice(0, 300)}`)
    return res.json ?? res.text
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
