// Checked physical-login auth evidence consumed by the real usage tool route.
// Canned provider results, disposable data and fake CLIs only.
import fs from 'node:fs'
import path from 'node:path'
import { Proof } from '../proof.mjs'

const marker = 'usage-auth-private-sentinel'
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

export default async function (rig) {
  const p = new Proof('usage-query-auth')
  await rig.waitFor(() => rig.sql('SELECT 1 FROM ot.turns WHERE ended_at IS NULL').length === 0,
    { what: 'seed turn settled', timeout: 60000 })
  const dir = path.join(rig.data, 'rig-home', 'rig-usage')
  fs.mkdirSync(dir, { recursive: true })
  await rig.waitFor(() => fs.existsSync(path.join(dir, 'calls.log'))
    && fs.readFileSync(path.join(dir, 'calls.log'), 'utf8').includes(' google'),
    { what: 'initial automatic usage pass', timeout: 20000 })
  const old = new Date(Date.now() - 120e3).toISOString()
  const room = observed_at => ({ available: true, observed_at, extra_credential: marker, detail: marker,
    limits: [{ kind: 'session', group: 'session', percent: 37, is_active: false }] })
  const negative = () => ({ available: false, error: 'synthetic sign-in rejection',
    reauth_required: true, detail: marker })
  const put = (name, value) => fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(value))
  async function add(folder) {
    const home = path.join(rig.data, 'rig-home', folder)
    fs.mkdirSync(home, { recursive: true })
    fs.writeFileSync(path.join(home, '.credentials.json'), '{}')
    fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'auth@example.invalid' } }))
    return (await rig.api('POST', '/api/accounts', { provider: 'claude', kind: 'imported', path: home })).id
  }
  const A = await add('.claude')
  const readNative = () => rig.api('GET', '/api/usage?force=true')
  const readAmbient = () => rig.api('GET', `/api/accounts/${A}/usage?force=true`)
  const query = account => rig.tool('boss', 'orgtree_usage', { accounts: [account] })
  const row = response => response.json?.accounts?.[0]
  const dated = value => value?.observed_at === old && value.age_seconds >= 120
    && value.freshness === 'fresh' && value.windows[0]?.used_percent === 37
  const rejected = response => response.ok && row(response)?.available === false
    && row(response).reason === 'signed_out' && dated(row(response))

  for (const [direction, badName, badRead, goodName, goodRead] of [
    ['explicit negative/native success', 'claude@.claude', readAmbient, 'claude', readNative],
    ['native negative/explicit success', 'claude', readNative, 'claude@.claude', readAmbient],
  ]) {
    put('claude', room(old)); await readNative()
    put('claude@.claude', room(old)); await readAmbient()
    put(badName, negative()); await badRead()
    const bad = await query('claude/primary')
    p.check(`${direction}: known negative overlays retained dated bars`, rejected(bad), bad.json)
    put(goodName, room(old)); await goodRead()
    const recovered = await query('claude/primary')
    p.check(`${direction}: newer genuine success supersedes older negative`, recovered.ok
      && row(recovered)?.available === true && row(recovered).reason === null && dated(row(recovered)), recovered.json)
    put(badName, negative()); await badRead()
    const again = await query('claude/primary')
    p.check(`${direction}: newer rejection overrides success`, rejected(again), again.json)
    put(goodName, { available: false, error: 'synthetic transient', detail: marker }); await goodRead()
    const transient = await query('claude/primary')
    p.check(`${direction}: transient other alias does not supersede auth or redate bars`, rejected(transient), transient.json)
  }

  const B = await add('usage-auth-independent')
  put('claude@usage-auth-independent', room(old))
  await rig.api('GET', `/api/accounts/${B}/usage?force=true`)
  const separate = await query(B)
  p.check('separate imported login is not affected by native alias rejection', separate.ok
    && row(separate)?.available === true && row(separate).reason === null && dated(row(separate)), separate.json)

  // Contradictory quota availability must not turn negative auth into success.
  put('claude@.claude', { ...room(old), reauth_required: true })
  put('claude', { ...room(old), reauth_required: true })
  const beforeTurns = rig.one('SELECT count(*) AS n FROM ot.turns').n
  const offset = rig.engineLog().length
  const refresh = await rig.tool('boss', 'orgtree_usage', { accounts: ['claude/primary'], refresh: true })
  await sleep(250)
  const log = rig.engineLog().slice(offset)
  p.file('negative-refresh-tool.log', log)
  p.check('manual negative auth cannot be classified successful with error-null good bars', refresh.ok
    && refresh.json.refresh.status === 'failed' && rejected(refresh), refresh.json)
  p.check('composed tool response and actual refresh logs exclude raw provider metadata',
    !JSON.stringify(refresh).includes(marker) && !log.includes(marker) && /usage\.refresh_permitted/.test(log),
    { logLength: log.length, responseClean: !JSON.stringify(refresh).includes(marker), logClean: !log.includes(marker) })
  p.check('negative refresh creates no inference turn', rig.one('SELECT count(*) AS n FROM ot.turns').n === beforeTurns)
  const floor = await rig.tool('boss', 'orgtree_usage', { accounts: ['claude/primary'], refresh: true })
  p.check('auth overlay preserves the manual failure attempt floor', floor.ok && floor.json.refresh.status === 'rate_limited'
    && floor.json.refresh.retry_after_seconds > 0 && rejected(floor), floor.json?.refresh)

  const C = await add('usage-auth-recent-negative')
  put('claude@usage-auth-recent-negative', { ...room(new Date().toISOString()), reauth_required: true })
  await rig.api('GET', `/api/accounts/${C}/usage?force=true`)
  const calls = () => fs.readFileSync(path.join(dir, 'calls.log'), 'utf8').split('\n').filter(Boolean).length
  const before = calls()
  const recent = await rig.tool('boss', 'orgtree_usage', { accounts: [C], refresh: true })
  p.check('reused recent negative cache reports failed without bypassing cache cadence', recent.ok
    && recent.json.refresh.status === 'failed' && row(recent).reason === 'signed_out'
    && row(recent).available === false && calls() === before, recent.json)
  const result = p.summary()
  if (!result.passed) throw Error(JSON.stringify(result))
  return result
}
