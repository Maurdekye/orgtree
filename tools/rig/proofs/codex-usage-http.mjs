// Proof: Codex usage is read over HTTPS, not by starting a codex app-server
// that is then killed (docket urgent-orgtree-s-hard-killing-of-codex-processes).
// A loopback server stands in for chatgpt.com's /wham/usage (the rig's
// rig-usage\openai-http.json names it), and the default login's auth.json
// holds a fake access token and account id:
//   1. A forced read shows the endpoint's numbers, plan and credits.
//   2. The endpoint got the token as a Bearer header and the account id as
//      ChatGPT-Account-Id.
//   3. No codex app-server was started for it.
//   4. The token appears in no engine log.
//   5. When the endpoint fails (HTTP 500), the engine falls back to ONE
//      app-server read, and that app-server exits by itself after its input
//      closes (no kill): the fake logs `exit ... stdin closed`.
//   6. A second failing read within 30 minutes starts no app-server and keeps
//      the last good bars, saying why they are not fresh.
// Run: node tools/rig/rig.mjs run tools/rig/proofs/codex-usage-http.mjs

import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'

import { Proof } from '../proof.mjs'

const TOKEN = 'rig-access-token-5f1c9e'
const ACCOUNT = 'rig-account-id-77'
const b64 = v => Buffer.from(JSON.stringify(v)).toString('base64url')
const sleep = ms => new Promise(r => setTimeout(r, ms))

function walk(dir, out = []) {
  for (const e of fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }) : []) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else out.push(p)
  }
  return out
}

export default async function (rig) {
  const p = new Proof('codex-usage-http')
  const now = Math.floor(Date.now() / 1000)
  const wham = {
    plan_type: 'pro',
    rate_limit: { allowed: true, limit_reached: false,
      primary_window: { used_percent: 37, limit_window_seconds: 18000, reset_after_seconds: 3600, reset_at: now + 3600 },
      secondary_window: { used_percent: 61, limit_window_seconds: 604800, reset_after_seconds: 86400, reset_at: now + 86400 } },
    credits: { has_credits: true, unlimited: false, balance: 42 },
  }
  const seen = []
  let status = 200
  const server = http.createServer((req, res) => {
    seen.push({ path: req.url, auth: req.headers.authorization, account: req.headers['chatgpt-account-id'] })
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(status === 200 ? JSON.stringify(wham) : '{"detail":"rig failure"}')
  })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  try {
    const home = path.join(rig.data, 'rig-home')
    fs.mkdirSync(path.join(home, '.codex'), { recursive: true })
    const idToken = `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ email: 'rig-http@example.invalid' })}.rig`
    fs.writeFileSync(path.join(home, '.codex', 'auth.json'), JSON.stringify({ OPENAI_API_KEY: null,
      tokens: { id_token: idToken, access_token: TOKEN, refresh_token: 'rig-refresh', account_id: ACCOUNT } }))
    fs.mkdirSync(path.join(home, 'rig-usage'), { recursive: true })
    fs.writeFileSync(path.join(home, 'rig-usage', 'openai-http.json'),
      JSON.stringify({ url: `http://127.0.0.1:${server.address().port}/backend-api/wham/usage` }))

    const probeLog = path.join(rig.fakeDir, 'log', 'probe.jsonl')
    const lines = () => (fs.existsSync(probeLog) ? fs.readFileSync(probeLog, 'utf8').split('\n') : [])
      .filter(Boolean).map(l => { try { return JSON.parse(l) } catch { return {} } })
    const usageProbes = from => lines().slice(from).filter(l => l.kind === 'recv' && l.line?.method === 'account/rateLimits/read')
    const mark0 = lines().length

    // 1-3: the HTTPS read
    const v = await rig.api('GET', '/api/codex/usage?force=true')
    const pct = kind => v?.limits?.find(l => l.kind === kind)?.percent
    p.check('a forced read shows the endpoint\'s numbers', v?.available === true && pct('session') === 37 && pct('weekly_all') === 61,
      { available: v?.available, limits: v?.limits?.map(l => [l.kind, l.percent]), error: v?.error, detail: v?.detail })
    p.check('plan and credits come from the endpoint', /pro/i.test(String(v?.plan ?? '')) && Number(v?.credits?.balance) === 42,
      { plan: v?.plan, credits: v?.credits })
    p.check('the endpoint got the token as Bearer and the account id', seen.length >= 1 && seen.every(s => s.auth === `Bearer ${TOKEN}`
      && s.account === ACCOUNT && s.path === '/backend-api/wham/usage'),
      seen.map(s => ({ ...s, auth: s.auth === `Bearer ${TOKEN}` ? 'Bearer <the token>' : s.auth })))
    p.check('no codex app-server was started for it', usageProbes(mark0).length === 0, usageProbes(mark0))

    // 5: the endpoint fails -> one app-server read that ends by itself
    status = 500
    const mark1 = lines().length
    const seen1 = seen.length
    const f = await rig.api('GET', '/api/codex/usage?force=true')
    await sleep(1500)
    const probes = usageProbes(mark1)
    const pids = [...new Set(probes.map(l => l.pid))]
    const exits = lines().slice(mark1).filter(l => l.kind === 'exit' && pids.includes(l.pid))
    p.check('a failing endpoint falls back to ONE app-server read (the fake\'s 10%)', seen.length > seen1 && pids.length === 1
      && f?.available === true && f?.limits?.find(l => l.kind === 'session')?.percent === 10,
      { requests: seen.length - seen1, pids, limits: f?.limits?.map(l => [l.kind, l.percent]), error: f?.error })
    p.check('that app-server exited by itself after its input closed', exits.length === 1 && exits[0].why === 'stdin closed', exits)

    // 6: failing again inside 30 min -> no app-server, last good bars kept
    const mark2 = lines().length
    const seen2 = seen.length
    const g = await rig.api('GET', '/api/codex/usage?force=true')
    p.check('a second failure within 30 minutes starts no app-server', seen.length > seen2 && usageProbes(mark2).length === 0,
      { requests: seen.length - seen2, probes: usageProbes(mark2).length })
    p.check('it keeps the last good bars and says why they are not fresh', g?.available === true
      && g?.limits?.find(l => l.kind === 'session')?.percent === 10 && /500/.test(String(g?.detail ?? '')),
      { available: g?.available, error: g?.error, detail: g?.detail })

    // 4: the token is in no log the engine wrote
    const leaks = walk(rig.data).filter(f => !/\.codex[\\/]auth\.json$/.test(f) && !/[\\/]pg(data)?[\\/]/i.test(f) && fs.statSync(f).size < 64e6)
      .filter(f => { try { return fs.readFileSync(f, 'latin1').includes(TOKEN) } catch { return false } })
    p.check('the access token appears in no file but auth.json', leaks.length === 0, leaks)
  } finally {
    server.close()
  }
  const result = p.summary()
  if (!result.passed) throw Error(JSON.stringify(result))
  return result
}
