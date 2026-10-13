// Original usage-query composition only: actual tool, two canonical key
// lanes, canned metadata checks and fake CLIs. No real provider or inference.
import fs from 'node:fs'
import path from 'node:path'
import { Proof } from '../proof.mjs'
import { setup as keysSetup } from './openrouter-keys.mjs'

export async function setup() {
  return { ...await keysSetup(), name: 'usage-query-openrouter' }
}

export default async function (rig) {
  const p = new Proof('usage-query-openrouter')
  await rig.waitFor(() => rig.sql('SELECT 1 FROM ot.turns WHERE ended_at IS NULL').length === 0,
    { what: 'seed turns settled', timeout: 60000 })
  const dir = path.join(rig.data, 'rig-home', 'rig-usage')
  const marker = 'USAGE-OR-PRIVATE-FIELD-73159'
  const old = new Date(Date.now() - 1800e3).toISOString()
  const canned = percent => ({ available: true, observed_at: old, detail: marker, opaque_credential: marker,
    limits: [{ kind: 'usage', group: 'credits', percent, amount: percent / 10, unit: 'USD', resets_at: null,
      label: `${percent}% synthetic spend`, is_active: false }] })
  const file = lane => path.join(dir, `${lane}.json`)
  const put = (lane, value) => fs.writeFileSync(file(lane), JSON.stringify(value))
  await rig.api('POST', '/api/openrouter/keys', { key: 'sk-or-rig-not-a-real-key-TWO222', label: 'query second' })
  put('openrouter', canned(21))
  put('openrouter-2', canned(73))
  await rig.api('GET', '/api/openrouter/usage?force=true')
  await rig.api('GET', '/api/accounts/openrouter-2/usage?force=true')
  const calls = lane => fs.readFileSync(path.join(dir, 'calls.log'), 'utf8').split('\n').filter(l => l.endsWith(` ${lane}`)).length
  const query = args => rig.tool('boss', 'orgtree_usage', args)
  const read = (lane, refresh = false) => query({ accounts: [lane], refresh })
  const n0 = Object.fromEntries(['openrouter', 'openrouter-2'].map(l => [l, calls(l)]))
  const history = () => rig.one("SELECT count(*) AS n FROM ot.usage_history WHERE provider='openrouter'").n
  const h0 = history()
  const cached = await query({ providers: ['openrouter'] })
  const rows = cached.json?.accounts ?? []
  p.check('cached query lists original lane once and added key distinctly, with their own stale values', cached.ok
    && rows.length === 2 && rows.find(r => r.account === 'openrouter')?.windows?.[0]?.used_percent === 21
    && rows.find(r => r.account === 'openrouter-2')?.windows?.[0]?.used_percent === 73
    && rows.every(r => r.freshness === 'stale' && r.age_seconds >= 1800), rows)
  p.check('cache-only query adds no reads or history', calls('openrouter') === n0.openrouter
    && calls('openrouter-2') === n0['openrouter-2'] && history() === h0)
  p.check('cache projection excludes arbitrary provider credential/detail fields', !JSON.stringify(cached).includes(marker))
  const alias = await read('openrouter-key')
  p.check('the storage id is not a second query lane or accepted alias', !alias.ok, alias)

  await rig.api('PUT', '/api/accounts/openrouter-key/enabled', { enabled: false })
  const beforeOff = calls('openrouter')
  const off = await read('openrouter')
  const offRefresh = await read('openrouter', true)
  p.check('original registry switch governs its canonical query lane: inactive readable, refresh refused',
    off.ok && off.json.accounts[0].enabled === false && !offRefresh.ok && calls('openrouter') === beforeOff, { off, offRefresh })
  await rig.api('PUT', '/api/accounts/openrouter-key/enabled', { enabled: true })
  await rig.api('POST', `/api/orgs/${rig.org}/settings`, { disabled_accounts: ['openrouter-2'] })
  const allowed = await query({ providers: ['openrouter'] })
  const hidden = await read('openrouter-2', true)
  p.check('org exclusion hides only the added lane and refuses its refresh before a read', allowed.ok
    && allowed.json.accounts.length === 1 && allowed.json.accounts[0].account === 'openrouter' && !hidden.ok
    && calls('openrouter-2') === n0['openrouter-2'], { allowed, hidden })
  await rig.api('POST', `/api/orgs/${rig.org}/settings`, { disabled_accounts: [] })

  // Leave the dated cached second-key row in place, then use the actual
  // private key reader with its delayed canned key check on the first tool
  // refresh. The append-only rig call log is the admission barrier.
  fs.unlinkSync(file('openrouter-2'))
  fs.writeFileSync(path.join(dir, 'openrouter-key@openrouter-2.json'), JSON.stringify({ status: 200, delay_ms: 2000,
    data: { label: 'query second', limit: 10, usage: 7.3, total_credits: 30, total_usage: 11.43, opaque_note: marker } }))
  // The public readers retain a 60 s insertion-age cache independently of
  // the provider's observation timestamp. Let that ordinary cache expire;
  // this is a deadline wait, not a provider poll or a new cache bypass.
  p.note('waiting 61 seconds for the second-key reader cache to expire')
  await new Promise(resolve => setTimeout(resolve, 61000))
  const turns = rig.one('SELECT count(*) AS n FROM ot.turns').n
  const before = { one: calls('openrouter'), two: calls('openrouter-2') }
  const logStart = rig.engineLog().length
  const inFlight = read('openrouter-2', true)
  await rig.waitFor(() => calls('openrouter-2') === before.two + 1,
    { what: 'second lane admitted and holds its reservation', timeout: 10000 })
  const busy = await read('openrouter-2', true)
  p.check('same-lane manual refresh returns in_progress while retaining the dated row', busy.ok
    && busy.json.refresh.status === 'in_progress' && busy.json.accounts[0].age_seconds >= 1800
    && calls('openrouter-2') === before.two + 1, busy)
  await rig.api('GET', '/api/accounts/openrouter-2/usage?force=true')
  p.check('public HTTP reader shares the held second-lane reservation and starts no duplicate read',
    calls('openrouter-2') === before.two + 1)
  const first = await read('openrouter', true)
  p.check('a different key can refresh while the second key is reserved: distinct permits and floors', first.ok
    && first.json.refresh.status === 'attempted' && first.json.accounts[0].windows[0].used_percent === 21, first)
  const second = await inFlight
  p.check('manual second-key refresh reaches the private reader without reacquiring its own permit', second.ok
    && second.json.refresh.status === 'attempted' && second.json.accounts[0].windows[0].used_percent === 73
    && second.json.accounts[0].freshness === 'fresh' && calls('openrouter-2') === before.two + 1, second)
  const after = { one: calls('openrouter'), two: calls('openrouter-2') }
  const floors = await Promise.all(['openrouter', 'openrouter-2'].map(l => read(l, true)))
  p.check('each key has its own manual floor after its attempt, no extra reads', floors.every(r => r.ok
    && r.json.refresh.status === 'rate_limited' && r.json.refresh.retry_after_seconds > 0)
    && calls('openrouter') === after.one && calls('openrouter-2') === after.two, floors)
  p.check('tool operations launch no inference turns and do not switch the caller account',
    rig.one('SELECT count(*) AS n FROM ot.turns').n === turns
    && rig.one("SELECT account FROM ot.agents WHERE name='boss' AND state='live'")?.account == null)
  p.check('tool responses and actual tool interval logs contain no private marker; safe diagnostics remain',
    !JSON.stringify({ busy, first, second, floors }).includes(marker)
    && !rig.engineLog().slice(logStart).includes(marker)
    && rig.engineLog().slice(logStart).includes('OpenRouter key usage read'))
  p.keep(rig, { grep: /OpenRouter key usage read|refresh_gate|refresh_permitted/ })
  return p.summary()
}
