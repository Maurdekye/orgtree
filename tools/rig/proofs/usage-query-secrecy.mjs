// Tool-operation log capture, synthetic provider data and loopback HTTP only.
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { Proof } from '../proof.mjs'

const marker = 'usage-raw-secret-sentinel'
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const b64 = value => Buffer.from(JSON.stringify(value)).toString('base64url')

export default async function (rig) {
  const p = new Proof('usage-query-secrecy')
  const home = path.join(rig.data, 'rig-home')
  const dir = path.join(home, 'rig-usage')
  fs.mkdirSync(dir, { recursive: true })
  const old = new Date(Date.now() - 1800e3).toISOString()
  const put = (provider, value) => fs.writeFileSync(path.join(dir, `${provider}.json`), JSON.stringify(value))
  await rig.waitFor(() => rig.sql('SELECT 1 FROM ot.turns WHERE ended_at IS NULL').length === 0,
    { what: 'seed turn complete', timeout: 60000 })
  await rig.waitFor(() => fs.existsSync(path.join(dir, 'calls.log'))
    && fs.readFileSync(path.join(dir, 'calls.log'), 'utf8').includes(' google'),
    { what: 'initial automatic usage pass', timeout: 20000 })

  async function interval(name, account) {
    const offset = rig.engineLog().length
    const response = await rig.tool('boss', 'orgtree_usage', { accounts: [account], refresh: true })
    await sleep(250)
    const log = rig.engineLog().slice(offset)
    const leaks = log.split(/\r?\n/).filter(line => line.includes(marker))
    p.file(`${name}-tool.log`, log)
    p.check(`${name}: response excludes raw fields`, response.ok && !JSON.stringify(response).includes(marker), response)
    p.check(`${name}: actual tool log interval excludes raw fields`, leaks.length === 0, { markerLines: leaks.length, examples: leaks.slice(0, 2) })
    p.check(`${name}: verbose safe diagnostics are present`, /usage\.refresh_permitted/.test(log), { length: log.length })
    return response
  }

  put('openai', { available: true, observed_at: old, extra_credential: marker, detail: marker,
    limits: [{ kind: 'session', group: 'session', percent: 37, is_active: false }] })
  await rig.api('GET', '/api/codex/usage?force=true') // setup is outside the measured interval
  const success = await interval('canned-success', 'openai/primary')
  p.check('canned success was processed during the tool call', success.json?.refresh.status === 'attempted'
    && success.json.accounts[0].windows[0]?.used_percent === 37, success.json?.refresh)

  put('claude', { available: false, observed_at: old, error: `HTTP 500 ${marker}`,
    detail: `upstream response body ${marker}`, extra_credential: marker })
  await rig.api('GET', '/api/usage?force=true')
  const failed = await interval('canned-failure-detail', 'claude/primary')
  p.check('failure detail path was processed during the tool call', failed.json?.refresh.status === 'failed'
    && failed.json.accounts[0].reason === 'failed', failed.json?.refresh)

  let status = 200
  let requests = 0
  const server = http.createServer((req, res) => {
    requests++
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(status === 200 ? JSON.stringify({ plan_type: 'pro', extra_credential: marker, detail: marker,
      rate_limit: { allowed: true, limit_reached: false,
        primary_window: { used_percent: 43, limit_window_seconds: 18000, reset_at: Math.floor(Date.now() / 1000) + 3600 } },
      credits: { has_credits: true, unlimited: false, balance: 42 } }) : JSON.stringify({ detail: marker }))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    put('openai-http', { url: `http://127.0.0.1:${server.address().port}/backend-api/wham/usage` })
    async function imported(name) {
      const profile = path.join(home, name)
      fs.mkdirSync(profile, { recursive: true })
      fs.writeFileSync(path.join(profile, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: null,
        tokens: { id_token: `${b64({ alg: 'none' })}.${b64({ email: `${name}@example.invalid` })}.rig`,
          access_token: `${marker}-fake-access`, refresh_token: 'fake-refresh', account_id: 'fake-account' } }))
      return (await rig.api('POST', '/api/accounts', { provider: 'openai', kind: 'imported', path: profile })).id
    }
    const whamId = await imported('secrecy-wham')
    const before = requests
    const wham = await interval('wham-success', whamId)
    p.check('real WHAM HTTP parser received loopback success', requests > before
      && wham.json?.refresh.status === 'attempted' && wham.json.accounts[0].windows.some(w => w.used_percent === 43),
    { requests: requests - before, refresh: wham.json?.refresh })
    status = 500
    const failureId = await imported('secrecy-wham-failure')
    const failedBefore = requests
    const fallback = await interval('wham-http-failure', failureId)
    p.check('real WHAM failure and fake app-server fallback were exercised', requests > failedBefore
      && fallback.json?.refresh.status === 'attempted'
      && fallback.json.accounts[0].windows.some(w => w.used_percent === 10),
    { requests: requests - failedBefore, refresh: fallback.json?.refresh })
  } finally {
    await new Promise(resolve => server.close(resolve))
    fs.unlinkSync(path.join(dir, 'openai-http.json'))
  }

  const googleResult = { status: 'SUCCESS', conversation_id: '', num_turns: 0,
    usage: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 0 },
    command: { name: 'usage', data: { groups: [{ name: 'Gemini', buckets: [
      { id: 'gemini-5h', name: '5h limit remaining', window: '5h', remaining_fraction: 0.3,
        reset_time: new Date(Date.now() + 3600e3).toISOString() },
    ] }] } }, extra_credential: marker, detail: marker }
  put('google', { available: true, observed_at: old, rig_google_result: { result: googleResult, extra_credential: marker },
    rig_google_log: `${marker}\nauthenticated successfully as secrecy@example.invalid` })
  await rig.api('GET', '/api/antigravity/usage?force=true')
  const google = await interval('google-structured-success-log', 'google/primary')
  p.check('production Google structured JSON and log parser ran', google.json?.refresh.status === 'attempted'
    && google.json.accounts[0].windows.some(w => w.used_percent === 70), google.json?.refresh)

  // A new process resets the manual floor; it still uses the same disposable
  // database, fake CLIs and synthetic provider files, never live credentials.
  put('google', { available: false, observed_at: old,
    rig_google_result: { ...googleResult, status: 'FAILURE', detail: marker }, rig_google_log: marker })
  await rig.restart()
  await rig.api('GET', '/api/antigravity/usage?force=true')
  const googleFailed = await interval('google-structured-failure-log', 'google/primary')
  p.check('production Google structured failure parser ran', googleFailed.json?.refresh.status === 'failed'
    && googleFailed.json.accounts[0].reason === 'failed', googleFailed.json?.refresh)
  const result = p.summary()
  if (!result.passed) throw Error(JSON.stringify(result))
  return result
}
