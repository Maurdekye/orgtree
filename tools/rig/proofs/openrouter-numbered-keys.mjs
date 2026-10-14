// Proof: every OpenRouter key is alike (user 2026-10-14 18:00Z, docket
// openrouter-keys-are-all-equal-no-unnumbered-prim), through the real engine
// on the rig's disposable database (never live data):
//   - keys are numbered from 1: the 3.x key carried over is openrouter-1, a
//     second key openrouter-2; the panel lists both alike (no `original`),
//     the account lists and pickers offer both;
//   - a hire naming no key is placed on a key and bound to it;
//   - removing the FIRST key moves its agents to another key, like any key,
//     and its id is never reused;
//   - MIGRATION 0021: an install from before (row `openrouter-key`, lane
//     `openrouter`, an unbound seat, a seat bound to the lane, turns, usage
//     history, a mark, spend, the org's default and switched-off list) is
//     rewritten once to `openrouter-N`, every reference carried, the seats
//     on the same secret as before; a second run changes nothing.
// RED: an engine without migration 0021 leaves `openrouter-key` in place
// (the first migration check fails), and lists it with `original: true`.
// Run: node tools/rig/rig.mjs run tools/rig/proofs/openrouter-numbered-keys.mjs

import fs from 'node:fs'
import path from 'node:path'

import { Proof } from '../proof.mjs'

const TIER = 'or-rig-fake-model'
const MIGRATION = '0021_openrouter_numbered_keys'
const ONE = { label: 'rig key one', limit: 25, limit_remaining: 16.51, limit_reset: 'monthly', usage: 8.49, usage_daily: 0.5,
              usage_weekly: 1, usage_monthly: 8.49, is_free_tier: false, total_credits: 30, total_usage: 11.43 }

export async function setup() {
  return {
    name: 'openrouter-numbered-keys',
    prepare: async ({ data }) => {
      fs.mkdirSync(path.join(data, 'openrouter'), { recursive: true })
      fs.writeFileSync(path.join(data, 'openrouter', 'state.json'), JSON.stringify({
        key: 'sk-or-rig-not-a-real-key-ONE111',
        favorites: [{ id: 'rig/fake-model', tier: TIER, name: 'Rig fake model', vendor: 'rig', prompt: 1, completion: 2, context: 100000, tools: true }],
      }))
      const dir = path.join(data, 'rig-home', 'rig-usage')
      fs.mkdirSync(dir, { recursive: true })
      // every key reads the same canned standing (the generic file)
      fs.writeFileSync(path.join(dir, 'openrouter-key.json'), JSON.stringify({ status: 200, data: ONE }))
    },
  }
}

const starts = (rig, agent) => rig.fakeLog(agent).filter((l) => l.kind === 'start' || l.event === 'start' || l.start)
const startEnv = (l) => l.env ?? l.data?.env ?? l.start?.env ?? {}
const tail = (rig, a) => startEnv(starts(rig, a).at(-1) ?? {}).auth_token_tail
// the binding columns rig.agentRow leaves out
const seat = (rig, name) => rig.one(`SELECT account, pending_account FROM ot.agents
  WHERE org_id = (SELECT id FROM ot.orgs WHERE slug = '${rig.org.replace(/'/g, "''")}' AND state = 'active') AND name = '${name}'`)

export default async function (rig) {
  const p = new Proof('openrouter-numbered-keys')
  rig.scenario({ default: { turns: [{ name: 'default', steps: [{ text: 'OK.' }] }] } })
  const q = (s) => s.replace(/'/g, "''")
  const org = q(rig.org)

  // ---------------------------------------------------------------- numbered from 1, alike
  let doc = await rig.api('GET', '/api/openrouter?force=true')
  p.check('the 3.x key carried over is openrouter-1 (lane its id), not special', (doc.keys ?? []).length === 1
    && doc.keys[0].id === 'openrouter-1' && doc.keys[0].lane === 'openrouter-1' && !('original' in doc.keys[0]),
    (doc.keys ?? []).map((k) => ({ id: k.id, lane: k.lane, original: k.original })))
  const added = await rig.api('POST', '/api/openrouter/keys', { key: 'sk-or-rig-not-a-real-key-TWO222', label: 'team' })
  p.check('a second key is openrouter-2', added.added === 'openrouter-2' && added.added_lane === 'openrouter-2')
  doc = await rig.api('GET', '/api/openrouter')
  p.check('the panel lists both keys alike, in the key list order',
    JSON.stringify((doc.keys ?? []).map((k) => [k.id, k.lane, 'original' in k])) === JSON.stringify([
      ['openrouter-1', 'openrouter-1', false], ['openrouter-2', 'openrouter-2', false]]), doc.keys)
  const accounts = (await rig.api('GET', '/api/accounts')).accounts.filter((a) => a.provider === 'openrouter').map((a) => a.id)
  p.check('the account registry lists both keys as accounts', accounts.includes('openrouter-1') && accounts.includes('openrouter-2'), accounts)
  const lanes = (await rig.api('GET', `/api/orgs/${rig.org}/accounts-allowed`)).accounts ?? []
  const orLanes = lanes.filter((l) => l.provider === 'openrouter')
  p.check('Org settings › Accounts names every key alike: "OpenRouter: <name> (<id>)"',
    orLanes.length === 2 && orLanes.every((l) => /^OpenRouter: .+ \(openrouter-\d+\)$/.test(l.label)), orLanes)

  // ---------------------------------------------------------------- placement
  await rig.op({ op: 'hire', name: 'una', parent: 'boss', tier: TIER, title: 'unnamed key' })
  await rig.op({ op: 'hire', name: 'bea', parent: 'boss', tier: TIER, title: 'key two', account: 'openrouter-2' })
  await rig.op({ op: 'hire', name: 'kit', parent: 'boss', tier: TIER, title: 'key one', account: 'openrouter-1' })
  p.check('a hire naming no key is placed on a key and bound to it', /^openrouter-[12]$/.test(seat(rig, 'una').account ?? ''),
    seat(rig, 'una').account)

  // ---------------------------------------------------------------- migration 0021 on a legacy install
  // Rewrite this disposable database to the state a 4.3.0-alpha.3 install
  // has: the first key's row `openrouter-key` (placeholder label), named by
  // the lane `openrouter`; one seat unbound, one bound to the lane.
  rig.exec(`
    INSERT INTO ot.accounts SELECT (jsonb_populate_record(NULL::ot.accounts, to_jsonb(a)
      || '{"id":"openrouter-key","label":"OpenRouter"}'::jsonb)).* FROM ot.accounts a WHERE a.id = 'openrouter-1';
    UPDATE ot.account_secrets SET account_id = 'openrouter-key' WHERE account_id = 'openrouter-1';
    UPDATE ot.agents SET account = NULL WHERE name = 'una';
    UPDATE ot.agents SET account = 'openrouter' WHERE name = 'kit';
    UPDATE ot.agents SET pending_account = '{"account":"openrouter-key"}'::jsonb WHERE name = 'bea';
    INSERT INTO ot.turns (agent_id, started_at, ended_at, account)
      SELECT id, now() - interval '1 hour', now() - interval '59 minutes', 'openrouter' FROM ot.agents WHERE name = 'kit';
    INSERT INTO ot.usage_history (provider, account, state, observed_at)
      VALUES ('openrouter', 'openrouter', 'ok', now() - interval '2 hours');
    INSERT INTO ot.account_marks (account, pool, until) VALUES ('openrouter', 'rig-pool', now() + interval '1 hour');
    INSERT INTO ot.account_spend (account, usd_total, turns) VALUES ('openrouter', 1.5, 3), ('openrouter-key', 0.5, 1);
    UPDATE ot.orgs SET settings = settings || '{"default_account":"openrouter","disabled_accounts":["openrouter","claude-9"]}'::jsonb
      WHERE slug = '${org}';
    DELETE FROM ot.accounts WHERE id = 'openrouter-1';
    DELETE FROM public.ot_migrations WHERE name = '${MIGRATION}';`)
  await rig.restart()
  const one = (s) => rig.one(s)
  const row = one(`SELECT id, label, ord FROM ot.accounts WHERE id = 'openrouter-1'`)
  p.check('migration: the legacy key is openrouter-1 again, its placeholder name dropped',
    !!row && row.label === '' && !one(`SELECT 1 AS x FROM ot.accounts WHERE id = 'openrouter-key'`), row)
  p.check('migration: its secret moved with it', !!one(`SELECT 1 AS x FROM ot.account_secrets WHERE account_id = 'openrouter-1'`)
    && !one(`SELECT 1 AS x FROM ot.account_secrets WHERE account_id = 'openrouter-key'`))
  const firstOrd = one(`SELECT min(ord) AS m FROM ot.accounts WHERE provider = 'openrouter'`).m
  p.check('migration: it stays first in the key list', row && row.ord === firstOrd, { row, firstOrd })
  p.check('migration: the unbound seat is bound to it, the lane-bound seat follows, the pending intent too',
    seat(rig, 'una').account === 'openrouter-1' && seat(rig, 'kit').account === 'openrouter-1'
    && seat(rig, 'bea').pending_account?.account === 'openrouter-1' && seat(rig, 'bea').account === 'openrouter-2',
    { una: seat(rig, 'una').account, kit: seat(rig, 'kit').account, bea: seat(rig, 'bea').pending_account })
  p.check('migration: turns, usage history, marks and spend are under the new id',
    !one(`SELECT 1 AS x FROM ot.turns WHERE account IN ('openrouter','openrouter-key')`)
    && !one(`SELECT 1 AS x FROM ot.usage_history WHERE account IN ('openrouter','openrouter-key')`)
    && !!one(`SELECT 1 AS x FROM ot.account_marks WHERE account = 'openrouter-1' AND pool = 'rig-pool'`)
    && Number(one(`SELECT usd_total FROM ot.account_spend WHERE account = 'openrouter-1'`)?.usd_total) === 2
    && !one(`SELECT 1 AS x FROM ot.account_spend WHERE account IN ('openrouter','openrouter-key')`))
  const settings = one(`SELECT settings FROM ot.orgs WHERE slug = '${org}'`).settings
  p.check('migration: the org default and its switched-off list name openrouter-1',
    settings.default_account === 'openrouter-1' && settings.disabled_accounts.includes('openrouter-1')
    && settings.disabled_accounts.includes('claude-9') && !settings.disabled_accounts.includes('openrouter'), settings)
  p.check('migration: the old names are retired', !!one(`SELECT 1 AS x FROM ot.removed_accounts WHERE id = 'openrouter-key'`)
    && !!one(`SELECT 1 AS x FROM ot.removed_accounts WHERE id = 'openrouter'`))
  p.check('migration ran once and is recorded', !!one(`SELECT name FROM public.ot_migrations WHERE name = '${MIGRATION}'`))
  // a second run (receipt removed again) finds nothing to do
  const before = JSON.stringify(rig.sql(`SELECT id, label, ord FROM ot.accounts WHERE provider = 'openrouter' ORDER BY id`))
  rig.exec(`DELETE FROM public.ot_migrations WHERE name = '${MIGRATION}';`)
  await rig.restart()
  p.check('migration is idempotent: a second run changes nothing',
    JSON.stringify(rig.sql(`SELECT id, label, ord FROM ot.accounts WHERE provider = 'openrouter' ORDER BY id`)) === before)

  // the switched-off list goes back on before any turn, then each seat runs on its own key's secret
  await rig.api('POST', `/api/orgs/${rig.org}/settings`, { disabled_accounts: [] })
  for (const a of ['una', 'kit']) await rig.userMail(a, `RUN-${a}`)
  await rig.waitTurns('una', 1); await rig.waitTurns('kit', 2) // kit has the fixture's legacy turn too
  p.check('after migration the seats launch with the same secret as before (key one)',
    tail(rig, 'una') === 'ONE111' && tail(rig, 'kit') === 'ONE111', { una: tail(rig, 'una'), kit: tail(rig, 'kit') })

  // ---------------------------------------------------------------- removing the first key is like any key
  const removed = await rig.api('DELETE', '/api/openrouter/keys/openrouter-1')
  p.check('removing the first key moves its agents to another key it may run on',
    seat(rig, 'una').account === 'openrouter-2' && seat(rig, 'kit').account === 'openrouter-2', removed.removed)
  const third = await rig.api('POST', '/api/openrouter/keys', { key: 'sk-or-rig-not-a-real-key-THR333' })
  p.check('a removed id is never reused: the next key is openrouter-3', third.added === 'openrouter-3', third.added)
  p.check('no response carries a secret', !JSON.stringify([doc, added, removed, third]).includes('sk-or-rig-not-a-real-key'))
  p.keep(rig, { agents: ['una', 'bea', 'kit'], grep: /openrouter|0021/ })
  return p.summary()
}
