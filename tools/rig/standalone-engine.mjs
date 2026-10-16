// tools/rig/standalone-engine.mjs: smoke proof for `orgtree-engine standalone`
// (docs/rust-engine/STANDALONE-ENGINE.md, phase 1).
//
// Starts the debug engine in standalone mode on a synthetic rig data root
// (fake home, fake CLIs, offline; the engine creates its own cluster, as a
// fresh Docker volume would) and checks: a short env token refuses to start;
// the first run generates the token file; unauthenticated and wrong-token
// calls are 403 on the API, the UI path and the app socket; Bearer and
// X-Orgtree-Desktop-Token reach the API; the user MCP endpoint (same token)
// initializes, lists its org-less and per-org tools, creates an org the
// HTTP API then sees, and answers chart/work/inbox as the user; a restart
// reuses the token and the persisted port; shutdown goes through the API.
//
//   $env:CARGO_TARGET_DIR = "C:\orgtree-build\<you>"   (or ORGTREE_RIG_ENGINE)
//   node tools/rig/rig.mjs build
//   node tools/rig/standalone-engine.mjs
//
// Prints one PASS/FAIL line per check; exits non-zero on any failure and
// keeps the run folder for inspection either way.

import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'

import { TOKEN_HEADER, assertSafeRoot, cleanEnv, engineExe, fakeCliExe, fakeHome, freePort, killTree, newRunId, pgBin, rigHome, runsDir, writeRun } from './lib.mjs'

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const results = []
function check(name, ok, extra = '') {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ` — ${extra}` : ''}`)
}

async function waitFor(label, fn, timeoutMs) {
  const end = Date.now() + timeoutMs
  for (;;) {
    const v = fn()
    if (v) return v
    if (Date.now() > end) throw new Error(`timed out waiting for ${label}`)
    await sleep(250)
  }
}

const home = rigHome()
fs.mkdirSync(runsDir(home), { recursive: true })
const id = newRunId('standalone')
const dir = path.join(runsDir(home), id)
const data = path.join(dir, 'data')
assertSafeRoot(data)
fs.mkdirSync(path.join(dir, 'tmp'), { recursive: true })
fs.mkdirSync(data, { recursive: true })
fs.writeFileSync(path.join(data, '.orgtree-rig-root'), JSON.stringify({ rig: 1, created: new Date().toISOString(), run: id }))
fakeHome(data)
fs.mkdirSync(path.join(dir, 'fakecli', 'log'), { recursive: true })
fs.writeFileSync(path.join(dir, 'fakecli', 'scenario.json'), JSON.stringify({ default: { turns: [{ steps: [{ text: 'OK.' }] }] } }, null, 2))
writeRun(dir, { id, created: new Date().toISOString(), status: 'starting', dir, data, by: 'standalone-engine.mjs' })

const exe = engineExe()
const fake = fakeCliExe()
const pg = pgBin(home)
const port = await freePort()

function startEngine(extraEnv = {}) {
  const env = {
    ...cleanEnv(),
    ORGTREE_DATA: data,
    ORGTREE_P03_PG_BIN: pg,
    ORGTREE_ENGINE_SAFE_START: '1',
    ORGTREE_ENGINE_RIG: '1',
    ORGTREE_NET_OFFLINE: '1',
    ORGTREE_BIND: '127.0.0.1',
    ORGTREE_CLAUDE_BIN: fake,
    ORGTREE_CODEX_BIN: fake,
    ORGTREE_AGY_BIN: fake,
    ORGTREE_OPENCODE_BIN: fake,
    ORGTREE_FAKECLI_DIR: path.join(dir, 'fakecli'),
    ORGTREE_FAKECLI_HOME: path.join(data, 'rig-home'),
    USERPROFILE: path.join(data, 'rig-home'),
    HOME: path.join(data, 'rig-home'),
    TEMP: path.join(dir, 'tmp'),
    TMP: path.join(dir, 'tmp'),
    ...extraEnv,
  }
  const child = spawn(exe, ['standalone'], { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  const run = { child, ready: null, exit: null, stderr: '' }
  let buf = ''
  child.stdout.on('data', d => {
    buf += d.toString()
    for (const line of buf.split('\n')) {
      try {
        const v = JSON.parse(line)
        if (v.type === 'ready') run.ready = v
      } catch { /* not a protocol line yet */ }
    }
    buf = buf.slice(buf.lastIndexOf('\n') + 1)
  })
  child.stderr.on('data', d => { run.stderr += d.toString() })
  child.on('exit', code => { run.exit = code })
  return run
}

async function api(port, route, { method = 'GET', headers = {} } = {}) {
  const res = await fetch(`http://127.0.0.1:${port}${route}`, { method, headers })
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* plain text body */ }
  return { status: res.status, json, text }
}

let mcpId = 0
async function mcp(port, route, method, params, headers = {}) {
  const res = await fetch(`http://127.0.0.1:${port}${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++mcpId, method, ...(params === undefined ? {} : { params }) }),
  })
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* plain text body */ }
  return { status: res.status, json, text }
}

const toolCall = (port, route, name, args, headers) =>
  mcp(port, route, 'tools/call', { name, arguments: args }, headers)
const toolText = r => r.json?.result?.content?.[0]?.text ?? ''

function wsUpgrade(port, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, path: '/api/app/ws', method: 'GET',
      headers: {
        Connection: 'Upgrade', Upgrade: 'websocket',
        'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64'),
        'Sec-WebSocket-Version': '13', ...headers,
      },
    })
    let settled = false
    const done = (fn, v) => { if (!settled) { settled = true; fn(v) } }
    req.on('upgrade', (_res, socket) => { socket.destroy(); done(resolve, 101) })
    req.on('response', res => { res.resume(); done(resolve, res.statusCode) })
    req.on('error', e => done(reject, e))
    req.setTimeout(15000, () => { req.destroy(new Error('ws upgrade timed out')) })
    req.end()
  })
}

let current = null
try {
  // 1. A short environment token refuses to start, naming the variable.
  current = startEngine({ ORGTREE_STANDALONE_TOKEN: 'short', ORGTREE_PORT: String(port) })
  await waitFor('short-token exit', () => current.exit !== null, 30000)
  check('short ORGTREE_STANDALONE_TOKEN refuses to start', current.exit !== 0 && current.stderr.includes('ORGTREE_STANDALONE_TOKEN'),
    `exit=${current.exit}`)
  check('refused start wrote no token file', !fs.existsSync(path.join(data, 'standalone-token')))

  // 2. First real start: cluster bootstrap, token generation, auth gates.
  current = startEngine({ ORGTREE_PORT: String(port) })
  const ready = await waitFor('engine ready', () => current.ready || (current.exit !== null && (() => { throw new Error(`engine exited ${current.exit}: ${current.stderr.slice(-800)}`) })()), 240000)
  check('standalone start becomes ready on ORGTREE_PORT', ready.port === port, `port=${ready.port}`)
  const tokenFile = path.join(data, 'standalone-token')
  const token = fs.existsSync(tokenFile) ? fs.readFileSync(tokenFile, 'utf8').trim() : ''
  check('first run generates the token file', token.length === 64, `len=${token.length}`)
  check('generated token printed to stderr once', current.stderr.includes('first-run token') && current.stderr.includes(token))

  const bearer = { Authorization: `Bearer ${token}` }
  check('no token: /api/desktop/alive is 403', (await api(port, '/api/desktop/alive')).status === 403)
  check('wrong Bearer token is 403', (await api(port, '/api/desktop/alive', { headers: { Authorization: 'Bearer wrong' } })).status === 403)
  const alive = await api(port, '/api/desktop/alive', { headers: bearer })
  check('Bearer token reaches /api/desktop/alive', alive.status === 200 && alive.json?.alive === true)
  check('desktop token header reaches the API', (await api(port, '/api/desktop/alive', { headers: { [TOKEN_HEADER]: token } })).status === 200)
  const orgs = await api(port, '/api/orgs', { headers: bearer })
  check('Bearer token reaches /api/orgs', orgs.status === 200, `status=${orgs.status}`)
  check('no token: the UI path is 403', (await api(port, '/')).status === 403)
  const ui = await api(port, '/', { headers: bearer })
  check('with token: no UI bundle is an honest 404', ui.status === 404 && ui.text.includes('UI bundle'), `status=${ui.status}`)
  check('app socket without token is refused', (await wsUpgrade(port, {})) === 403)
  check('app socket with Bearer token upgrades', (await wsUpgrade(port, bearer)) === 101)

  // 2b. The user MCP endpoint (phase 2), behind the same token.
  check('MCP without token is 403', (await mcp(port, '/api/mcp', 'tools/list', undefined, {})).status === 403)
  const init = await mcp(port, '/api/mcp', 'initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'smoke', version: '0' } }, bearer)
  check('MCP initialize answers as the user endpoint', init.status === 200
    && init.json?.result?.serverInfo?.name === 'orgtree'
    && String(init.json?.result?.instructions ?? '').includes('as the USER'), `status=${init.status}`)
  const orgless = await mcp(port, '/api/mcp', 'tools/list', undefined, bearer)
  const orglessNames = (orgless.json?.result?.tools ?? []).map(t => t.name)
  check('org-less MCP lists find/create, not manage', orglessNames.includes('orgtree_create_org')
    && orglessNames.includes('orgtree_list_orgs') && !orglessNames.includes('orgtree_chart'), orglessNames.join(','))
  const created = await toolCall(port, '/api/mcp', 'orgtree_create_org', { name: 'Smoke Org' }, bearer)
  check('orgtree_create_org creates the org', created.status === 200 && !created.json?.result?.isError
    && toolText(created).includes('smoke-org'), toolText(created).slice(0, 160))
  const orgsAfter = await api(port, '/api/orgs', { headers: bearer })
  check('the HTTP API sees the MCP-created org', JSON.stringify(orgsAfter.json ?? orgsAfter.text).includes('smoke-org'))
  const perOrg = await mcp(port, '/api/orgs/smoke-org/mcp', 'tools/list', undefined, bearer)
  const perOrgNames = (perOrg.json?.result?.tools ?? []).map(t => t.name)
  check('per-org MCP lists the user tools, no agent-only tools', perOrgNames.includes('orgtree_chart')
    && perOrgNames.includes('orgtree_answer') && perOrgNames.includes('orgtree_work')
    && !perOrgNames.includes('orgtree_status') && !perOrgNames.includes('orgtree_ask'), perOrgNames.join(','))
  const chart = await toolCall(port, '/api/orgs/smoke-org/mcp', 'orgtree_chart', {}, bearer)
  check('orgtree_chart answers as the user', !chart.json?.result?.isError && toolText(chart).includes('smoke-org'), toolText(chart).slice(0, 120))
  const work = await toolCall(port, '/api/orgs/smoke-org/mcp', 'orgtree_work', { action: 'list' }, bearer)
  check('orgtree_work list works as the user', !work.json?.result?.isError, toolText(work).slice(0, 160))
  const inboxList = await toolCall(port, '/api/orgs/smoke-org/mcp', 'orgtree_inbox', { action: 'list' }, bearer)
  check('orgtree_inbox list works as the user', !inboxList.json?.result?.isError, toolText(inboxList).slice(0, 160))
  const badMail = await toolCall(port, '/api/orgs/smoke-org/mcp', 'orgtree_message', { metadata: { to: 'no-such-agent' }, body: 'hello?' }, bearer)
  check('mailing a nonexistent agent is an honest isError', badMail.json?.result?.isError === true, toolText(badMail).slice(0, 160))
  const orgChartOnOrgless = await toolCall(port, '/api/mcp', 'orgtree_chart', {}, bearer)
  check('org tools on the org-less endpoint refuse with directions', orgChartOnOrgless.json?.result?.isError === true
    && toolText(orgChartOnOrgless).includes('/api/orgs/'), toolText(orgChartOnOrgless).slice(0, 160))

  // 3. Authenticated shutdown, then a restart reusing token + persisted port.
  check('shutdown through the authenticated API', (await api(port, '/api/desktop/shutdown', { method: 'POST', headers: bearer })).status === 200)
  await waitFor('engine exit', () => current.exit !== null, 90000)
  check('engine exits cleanly', current.exit === 0, `exit=${current.exit}`)

  current = startEngine() // no ORGTREE_PORT, no env token
  const ready2 = await waitFor('engine ready again', () => current.ready || (current.exit !== null && (() => { throw new Error(`engine exited ${current.exit}: ${current.stderr.slice(-800)}`) })()), 240000)
  check('restart reuses the persisted port', ready2.port === port, `port=${ready2.port}`)
  check('restart does not regenerate the token', !current.stderr.includes('first-run token')
    && fs.readFileSync(tokenFile, 'utf8').trim() === token)
  check('the same token still reaches the API', (await api(port, '/api/desktop/alive', { headers: bearer })).status === 200)
  await api(port, '/api/desktop/shutdown', { method: 'POST', headers: bearer })
  await waitFor('second engine exit', () => current.exit !== null, 90000)
  check('second shutdown exits cleanly', current.exit === 0, `exit=${current.exit}`)
  current = null
} catch (e) {
  check(`smoke run completed (${e.message})`, false)
} finally {
  if (current?.child?.pid && current.exit === null) killTree(current.child.pid)
  writeRun(dir, { status: 'stopped' })
}

const failed = results.filter(r => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed; run kept at ${dir}`)
process.exit(failed.length ? 1 : 0)
