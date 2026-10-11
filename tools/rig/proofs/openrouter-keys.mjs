// Proof: several OpenRouter keys at once (docket use-several-openrouter-keys-at-once,
// rulings 2026-10-11 22:35Z and 22:50Z), through the real engine with the
// gateway scripted (rig mode's canned key checks: rig-home\rig-usage\
// openrouter-key.json for the original key, openrouter-key@openrouter-2.json
// for the added one):
//   - the 3.x key carried over is the ORIGINAL key: lane `openrouter`;
//   - a second key is added with a name: `openrouter-2`, lane its id; the same
//     secret again is refused; the panel lists both, secret-free;
//   - each key's usage is its own reading, under its lane, with the shared
//     "account balance" wording; the account pickers offer the added key, the
//     original stays `default`;
//   - an agent bound to openrouter-2 launches with THAT key, an unbound one
//     with the original (the fake CLI logs the key's last 6 characters);
//   - per key app-wide switch: openrouter-2 off → its lane reads disabled in
//     Org settings, its agent's turn does not run; on again → it runs;
//   - per org: the org switches openrouter-2 off → a hire naming it is refused;
//   - removing openrouter-2 moves its agent to the original key; the next
//     added key is openrouter-3 (ids are never reused);
//   - the agents' PROVIDER USAGE board names each key once, under its lane.
// Run: node tools/rig/rig.mjs run tools/rig/proofs/openrouter-keys.mjs

import fs from 'node:fs'
import path from 'node:path'

import { Proof } from '../proof.mjs'

const TIER = 'or-rig-fake-model'
const ONE = { label: 'rig key one', limit: 25, limit_remaining: 16.51, limit_reset: 'monthly', usage: 8.49, usage_daily: 0.5,
              usage_weekly: 1, usage_monthly: 8.49, is_free_tier: false, total_credits: 30, total_usage: 11.43 }
const TWO = { label: 'rig key two', limit: 10, limit_remaining: 7, limit_reset: null, usage: 3, usage_daily: 0.1,
              usage_weekly: 1, usage_monthly: 3, is_free_tier: false, total_credits: 30, total_usage: 11.43 }
const keyCheck = (data, file, doc) => {
  const dir = path.join(data, 'rig-home', 'rig-usage')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, file), JSON.stringify(doc))
}

export async function setup() {
  return {
    name: 'openrouter-keys',
    prepare: async ({ data }) => {
      fs.mkdirSync(path.join(data, 'openrouter'), { recursive: true })
      fs.writeFileSync(path.join(data, 'openrouter', 'state.json'), JSON.stringify({
        key: 'sk-or-rig-not-a-real-key-ONE111',
        favorites: [{ id: 'rig/fake-model', tier: TIER, name: 'Rig fake model', vendor: 'rig', prompt: 1, completion: 2, context: 100000, tools: true }],
      }))
      keyCheck(data, 'openrouter-key.json', { status: 200, data: ONE })
      keyCheck(data, 'openrouter-key@openrouter-2.json', { status: 200, data: TWO })
    },
  }
}

const refused = (p) => p.then(() => null, (e) => e.status ?? -1)
const starts = (rig, agent) => rig.fakeLog(agent).filter((l) => l.kind === 'start' || l.event === 'start' || l.start)
const startEnv = (l) => l.env ?? l.data?.env ?? l.start?.env ?? {}

export default async function (rig) {
  const p = new Proof('openrouter-keys')
  rig.scenario({ default: { turns: [{ name: 'default', steps: [{ text: 'OK.' }] }] } })

  // ---------------------------------------------------------------- the original key
  let doc = await rig.api('GET', '/api/openrouter?force=true')
  const k0 = doc.keys ?? []
  p.check('the 3.x key is the original key: id openrouter-key, lane openrouter, connected', k0.length === 1
    && k0[0].id === 'openrouter-key' && k0[0].lane === 'openrouter' && k0[0].original === true && doc.connected === true,
    k0.map((k) => ({ id: k.id, lane: k.lane, original: k.original })))

  // ---------------------------------------------------------------- add a second key
  const added = await rig.api('POST', '/api/openrouter/keys', { key: 'sk-or-rig-not-a-real-key-TWO222', label: 'team' })
  p.check('a second key is added as openrouter-2 (lane its id) with its name', added.added === 'openrouter-2'
    && added.added_lane === 'openrouter-2' && (added.keys ?? []).some((k) => k.id === 'openrouter-2' && k.name === 'team'),
    { added: added.added, keys: (added.keys ?? []).map((k) => [k.id, k.name]) })
  p.check('no response carries a secret', !JSON.stringify(added).includes('sk-or-rig-not-a-real-key'))
  p.check('the same secret again is refused (409)',
    await refused(rig.api('POST', '/api/openrouter/keys', { key: 'sk-or-rig-not-a-real-key-TWO222' })) === 409)
  p.check('a secret stored as the original is refused as an added key too (409)',
    await refused(rig.api('POST', '/api/openrouter/keys', { key: 'sk-or-rig-not-a-real-key-ONE111' })) === 409)

  // ---------------------------------------------------------------- per-key usage
  await rig.api('GET', '/api/openrouter/usage?force=true')
  const usage = await rig.waitFor(async () => {
    const u = await rig.api('GET', '/api/openrouter/keys/usage')
    return u?.openrouter?.available && u?.['openrouter-2']?.available ? u : null
  }, { what: 'both keys to be read', timeout: 30000 }).catch(() => null)
  const lbl = (u) => (u?.limits ?? []).map((l) => l.label).join(' | ')
  p.check('each key has its own reading under its lane', !!usage && lbl(usage.openrouter).includes('$8.49 of $25.00')
    && lbl(usage['openrouter-2']).includes('$3.00 of $10.00'), usage && { openrouter: lbl(usage.openrouter), 'openrouter-2': lbl(usage['openrouter-2']) })
  p.check('both rows name the shared balance "account balance"', !!usage
    && lbl(usage.openrouter).includes('$18.57 account balance') && lbl(usage['openrouter-2']).includes('$18.57 account balance'))
  const hist = rig.sql(`SELECT DISTINCT account FROM ot.usage_history WHERE provider = 'openrouter' ORDER BY 1`).map((r) => r.account)
  p.check('usage history is recorded per lane', hist.includes('openrouter') && hist.includes('openrouter-2'), hist)

  // ---------------------------------------------------------------- pickers
  const accts = await rig.api('GET', `/api/accounts?org=${rig.org}`)
  const ids = (accts.accounts ?? []).map((a) => a.id)
  p.check('the account pickers offer the added key; the original stays default (no row)',
    ids.includes('openrouter-2') && !ids.includes('openrouter-key'), ids)
  const opts = await rig.api('GET', `/api/orgs/${rig.org}/staffing-options`)
  const orTier = (opts.tiers ?? []).find((t) => t.tier === TIER)
  p.check('staffing options: the OpenRouter tier lists openrouter-2 by name and the original as default_ok', !!orTier
    && orTier.default_ok === true && (orTier.accounts ?? []).some((a) => a.id === 'openrouter-2' && a.label === 'team'), orTier)

  // ---------------------------------------------------------------- per-seat key routing
  await rig.op({ op: 'hire', name: 'keytwo', parent: 'boss', tier: TIER, grant: 1, title: 'on key two', account: 'openrouter-2' })
  await rig.op({ op: 'hire', name: 'keyone', parent: 'boss', tier: TIER, grant: 1, title: 'on the original key' })
  p.check('bindings: keytwo on openrouter-2, keyone unbound (the original)',
    rig.agentRow('keytwo')?.account === 'openrouter-2' && rig.agentRow('keyone')?.account == null,
    { keytwo: rig.agentRow('keytwo')?.account, keyone: rig.agentRow('keyone')?.account })
  await rig.waitFor(() => rig.sql(`SELECT 1 FROM ot.turns WHERE ended_at IS NULL`).length === 0, { what: 'hire turns to settle', timeout: 60000 })
  for (const a of ['keytwo', 'keyone']) {
    const n = rig.turns(a).filter((t) => t.ended_at).length
    await rig.userMail(a, 'PROOF-KEYS: please answer.')
    await rig.waitTurns(a, n + 1)
  }
  const tail = (a) => startEnv(starts(rig, a).at(-1) ?? {})
  p.check('keytwo launched with key two, against OpenRouter', tail('keytwo').auth_token_tail === 'TWO222'
    && /openrouter\.ai/.test(String(tail('keytwo').ANTHROPIC_BASE_URL)), tail('keytwo'))
  p.check('keyone launched with the original key', tail('keyone').auth_token_tail === 'ONE111', tail('keyone'))

  // ---------------------------------------------------------------- the board
  const turn = rig.fakeLog('keytwo').filter((l) => l.kind === 'turn' || l.prompt).at(-1)
  const prompt = String(turn?.prompt ?? turn?.data?.prompt ?? '')
  const roster = (prompt.match(/\[ACCOUNTS\][^\n]*/) ?? [''])[0]
  p.check('the PROVIDER USAGE board lists each key once under its lane, keytwo starred on openrouter-2',
    /openrouter-2\*/.test(prompt) && /· openrouter( |$|·)/.test(roster + ' ') && roster.includes('openrouter-2')
    && !roster.includes('openrouter-key (API key, metered)'), roster)

  // ---------------------------------------------------------------- per-key app-wide switch
  await rig.api('PUT', '/api/accounts/openrouter-2/enabled', { enabled: false })
  let lanes = (await rig.api('GET', `/api/orgs/${rig.org}/accounts-allowed`)).accounts ?? []
  const l2 = lanes.find((l) => l.id === 'openrouter-2')
  p.check('switched off app-wide: the org lane reads enabled=false with the reason, still allowed by the org', l2?.enabled === false
    && /inactive/.test(String(l2?.disabled_reason)) && l2?.allowed === true, l2)
  doc = await rig.api('GET', '/api/openrouter')
  p.check('the panel shows openrouter-2 inactive, the original active', (doc.keys ?? []).find((k) => k.id === 'openrouter-2')?.enabled === false
    && (doc.keys ?? []).find((k) => k.original)?.enabled === true)
  const before = rig.turns('keytwo').length
  await rig.userMail('keytwo', 'PROOF-KEYS: while inactive.')
  await new Promise((r) => setTimeout(r, 6000))
  const ranWhileOff = rig.turns('keytwo').length > before && starts(rig, 'keytwo').length > 0
    && rig.turns('keytwo').slice(before).some((t) => !t.error)
  p.check('an inactive key serves no new turn', !rig.turns('keytwo').slice(before).some((t) => t.ended_at && !t.error && !t.killed),
    { turns_after: rig.turns('keytwo').slice(before), ranWhileOff })
  await rig.api('PUT', '/api/accounts/openrouter-2/enabled', { enabled: true })
  const resumed = await rig.waitFor(() => rig.turns('keytwo').slice(before).some((t) => t.ended_at && !t.error) ? true : null,
    { what: 'keytwo to run once its key is on again', timeout: 60000 }).catch(() => false)
  p.check('switched on again, the waiting mail runs on it', resumed === true)
  const l2on = ((await rig.api('GET', `/api/orgs/${rig.org}/accounts-allowed`)).accounts ?? []).find((l) => l.id === 'openrouter-2')
  p.check('switched on again: the org lane reads enabled with no reason, still allowed', l2on?.enabled === true
    && l2on?.disabled_reason == null && l2on?.allowed === true, l2on)

  // ---------------------------------------------------------------- per org
  await rig.api('POST', `/api/orgs/${rig.org}/settings`, { disabled_accounts: ['openrouter-2'] })
  p.check('the org switched openrouter-2 off: a hire naming it is refused (409)',
    await refused(rig.op({ op: 'hire', name: 'nokey', parent: 'boss', tier: TIER, grant: 1, account: 'openrouter-2' })) === 409)
  lanes = (await rig.api('GET', `/api/orgs/${rig.org}/accounts-allowed`)).accounts ?? []
  p.check('the org list shows one tick per key', lanes.filter((l) => l.provider === 'openrouter').map((l) => l.id).join(',') === 'openrouter,openrouter-2',
    lanes.filter((l) => l.provider === 'openrouter'))
  const revoked = lanes.find((l) => l.id === 'openrouter-2')
  p.check('org-revoked: allowed=false while app-wide enabled stays true', revoked?.allowed === false && revoked?.enabled === true, revoked)
  await rig.api('POST', `/api/orgs/${rig.org}/settings`, { disabled_accounts: [] })
  const restored = ((await rig.api('GET', `/api/orgs/${rig.org}/accounts-allowed`)).accounts ?? []).find((l) => l.id === 'openrouter-2')
  p.check('org re-allowed: allowed=true and enabled=true again', restored?.allowed === true && restored?.enabled === true, restored)

  // ---------------------------------------------------------------- removal
  await rig.waitFor(() => rig.sql(`SELECT 1 FROM ot.turns WHERE ended_at IS NULL`).length === 0, { what: 'turns to settle', timeout: 60000 })
  const removed = await rig.api('DELETE', '/api/openrouter/keys/openrouter-2')
  p.check('removing openrouter-2 moves keytwo to the original key', rig.agentRow('keytwo')?.account == null
    && (removed.removed?.rebound ?? []).some((r) => r.node === 'keytwo'), { account: rig.agentRow('keytwo')?.account, rebound: removed.removed?.rebound })
  p.check('the panel lists the original key only', (removed.keys ?? []).map((k) => k.id).join(',') === 'openrouter-key')
  const again = await rig.api('POST', '/api/openrouter/keys', { key: 'sk-or-rig-not-a-real-key-THREE3' })
  p.check('the next added key is openrouter-3 (a removed id is never reused) and is named "OpenRouter key 2" or its own label',
    again.added === 'openrouter-3', { added: again.added, keys: (again.keys ?? []).map((k) => [k.id, k.name]) })
  const n = rig.turns('keytwo').filter((t) => t.ended_at).length
  await rig.userMail('keytwo', 'PROOF-KEYS: after removal.')
  await rig.waitTurns('keytwo', n + 1)
  p.check('keytwo runs on the original key after the removal', tail('keytwo').auth_token_tail === 'ONE111', tail('keytwo'))

  const alive = await rig.api('GET', '/api/app/records').then(() => true, () => false)
  p.check('the engine still answers', alive)
  p.check('no secret reached the engine log', !rig.engineLog().includes('sk-or-rig-not-a-real-key'))
  p.keep(rig, { agents: ['keytwo', 'keyone'], grep: /openrouter|keytwo|keyone|panic/i })
  return p.summary()
}
