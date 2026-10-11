// Real tool route, canned readings and fake CLIs only. No provider calls.
import fs from 'node:fs'
import path from 'node:path'
import { Proof } from '../proof.mjs'

export default async function (rig) {
  const p = new Proof('usage-query')
  await rig.waitFor(() => rig.sql('SELECT 1 FROM ot.turns WHERE ended_at IS NULL').length === 0,
    { what: 'seed turn complete', timeout: 60000 })
  const dir = path.join(rig.data, 'rig-home', 'rig-usage')
  fs.mkdirSync(dir, { recursive: true })
  const old = new Date(Date.now() - 1800e3).toISOString()
  const reset = new Date(Date.now() + 3600e3).toISOString()
  const canned = observed_at => ({ available: true, observed_at,
    extra_credential: 'query-private-sentinel', detail: 'query-private-sentinel', limits: [
      { kind: 'session', group: 'session', percent: 37, resets_at: reset, is_active: false },
      { kind: 'weekly_all', group: 'weekly_all', percent: 88, resets_at: reset, is_active: false },
    ] })
  const put = (provider, doc) => fs.writeFileSync(path.join(dir, `${provider}.json`), JSON.stringify(doc))
  put('openai', canned(old))
  await rig.api('GET', '/api/codex/usage?force=true')
  const calls = () => fs.existsSync(path.join(dir, 'calls.log'))
    ? fs.readFileSync(path.join(dir, 'calls.log'), 'utf8').split('\n').filter(l => l.includes(' openai')).length : 0
  const query = args => rig.tool('boss', 'orgtree_usage', args)
  const before = calls()
  const history = () => rig.one('SELECT count(*) AS n FROM ot.usage_history').n
  const hist = history()
  const cached = await query({ accounts: ['openai/primary'], windows: ['session'] })
  p.check('cached query does not probe or record history', cached.ok && calls() === before && history() === hist, cached)
  const row = cached.json?.accounts?.[0]
  p.check('stale measurement keeps dated values and exact selected window', row?.reason === 'stale'
    && row.age_seconds >= 1800 && row.windows.length === 1 && row.windows[0].used_percent === 37, row)
  p.check('raw credential/detail fields never reach tool response', !JSON.stringify(cached).includes('query-private-sentinel'), cached)
  const all = await query({})
  const page = await query({ limit: 1 })
  const second = await query({ limit: 1, cursor: page.json?.next_cursor })
  p.check('account pagination advances with no overlap', all.ok && page.ok && second.ok
    && all.json.accounts.length >= 2 && page.json.next_cursor
    && page.json.accounts[0].account !== second.json.accounts[0].account, { page, second })
  for (const args of [{ accounts: [] }, { refresh: true }, { refresh: true, accounts: ['openai/primary', 'claude/primary'] },
    { providers: ['Codex'] }, { refresh: 'true' }, { limit: 0 }, { show_all: true }, { accounts: ['foreign-login'] }]) {
    const out = await query(args)
    p.check('invalid or unavailable request refuses before probing: ' + JSON.stringify(args), !out.ok && calls() === before, out)
  }
  // Scope is read fresh through the real ancestor chain, not the served list.
  rig.sql(`UPDATE ot.agents SET scope=jsonb_set(scope,'{tools,orgtree}', '{"inspection":true,"runtime":false}'::jsonb,true) WHERE name='boss'`)
  const readOnly = await query({ accounts: ['openai/primary'] })
  const denied = await query({ accounts: ['openai/primary'], refresh: true })
  p.check('inspection-only agent reads cache but cannot refresh', readOnly.ok && !denied.ok && calls() === before, { readOnly, denied })
  rig.sql(`UPDATE ot.agents SET scope=jsonb_set(scope,'{tools,orgtree}', '{"inspection":false,"runtime":true}'::jsonb,true) WHERE name='boss'`)
  const noRead = await query({})
  p.check('live inspection denial refuses even with runtime', !noRead.ok && calls() === before, noRead)
  rig.sql(`UPDATE ot.agents SET scope=jsonb_set(scope,'{tools,orgtree}', '{"inspection":true,"runtime":true}'::jsonb,true) WHERE name='boss'`)
  await rig.api('POST', `/api/orgs/${rig.org}/settings`, { disabled_accounts: ['openai/primary'] })
  const scoped = await query({})
  const outside = await query({ accounts: ['openai/primary'], refresh: true })
  p.check('org account exclusion affects cached and fresh reads', scoped.ok
    && !scoped.json.accounts.some(a => a.account === 'openai/primary') && !outside.ok && calls() === before, { scoped, outside })
  await rig.api('POST', `/api/orgs/${rig.org}/settings`, { disabled_accounts: [] })
  put('openai', { ...canned(new Date().toISOString()), rig_delay_ms: 500 })
  const turns = rig.one('SELECT count(*) AS n FROM ot.turns').n
  const both = await Promise.all([query({ accounts: ['openai/primary'], refresh: true }), query({ accounts: ['openai/primary'], refresh: true })])
  p.check('concurrent manual requests start exactly one read', both.every(r => r.ok) && calls() === before + 1
    && both.some(r => r.json.refresh.status === 'in_progress') && both.some(r => r.json.refresh.status === 'attempted'), both)
  const limited = await query({ accounts: ['openai/primary'], refresh: true })
  p.check('next manual refresh reports shared attempt floor', limited.ok && limited.json.refresh.status === 'rate_limited'
    && limited.json.refresh.retry_after_seconds > 0 && calls() === before + 1, limited)
  p.check('refresh creates no inference turn', rig.one('SELECT count(*) AS n FROM ot.turns').n === turns)
  // Inactive native account remains inspectable, never refreshable.
  await rig.api('POST', '/api/app/settings', { subscription_inference: { openai: false } })
  const inactive = await query({ accounts: ['openai/primary'] })
  const inactiveRefresh = await query({ accounts: ['openai/primary'], refresh: true })
  p.check('inactive account inspection is separate from refresh permission', inactive.ok && inactive.json.accounts[0].enabled === false
    && !inactiveRefresh.ok && calls() === before + 1, { inactive, inactiveRefresh })
  p.note('Unit coverage supplies exact stale boundary, unknown timestamp, cancellation release, failed attempt and Google floor checks. OpenRouter secondary coverage waits for owner helper integration.')
  return p.summary()
}
