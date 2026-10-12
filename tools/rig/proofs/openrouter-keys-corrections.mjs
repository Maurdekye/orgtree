// Proof: the review round 1 corrections for several OpenRouter keys (docket
// use-several-openrouter-keys-at-once, review by hubchat-dm-sol at cca3d11),
// through the real engine, the fake CLI and canned key checks only:
//   1. a replaced secret reaches the agent's NEXT turn: the warm CLI started on
//      the old secret is replaced (Claude Code harness, then Codex), while a
//      turn with nothing changed still reuses it; a usage read that captured the
//      old secret and answers after the replacement is never cached;
//   2. a capped key whose account balance is at zero cannot be continued on,
//      while the same key with balance can;
//   3. a reading's private provider text never reaches the engine log through
//      the readers, while their safe summary line does;
//   4. removing the ORIGINAL key reassigns its seats (unbound and bound) to
//      another key, or freezes a live seat when none is left, clears defaults,
//      and the usage tool no longer offers the removed lane;
//   5. on a LATER start (no import), a stored favorite is hireable before the
//      provider discovery finishes;
//   6. two replacements with the same secret at once: one succeeds, one is
//      refused.
// Run: node tools/rig/rig.mjs run tools/rig/proofs/openrouter-keys-corrections.mjs

import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'

import { Proof } from '../proof.mjs'
import { setup as keysSetup } from './openrouter-keys.mjs'

const TIER = 'or-rig-fake-model'
const MARKER = 'OR-PROOF-PRIVATE-DETAIL-58213'
const FULL = { label: 'rig key two', limit: 10, limit_remaining: 7, limit_reset: null, usage: 3, usage_daily: 0.1,
               usage_weekly: 0.5, usage_monthly: 3, is_free_tier: false, total_credits: 30, total_usage: 11.43 }

export async function setup() {
  const s = await keysSetup()
  return { ...s, name: 'openrouter-keys-corrections' }
}

const refused = (p) => p.then(() => null, (e) => e.status ?? -1)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export default async function (rig) {
  const p = new Proof('openrouter-keys-corrections')
  rig.scenario({ default: { turns: [{ name: 'default', steps: [{ text: 'OK.' }] }] } })
  const usageDir = path.join(rig.data, 'rig-home', 'rig-usage')
  const keyFile = (lane) => path.join(usageDir, `openrouter-key@${lane}.json`)
  const starts = (a) => rig.fakeLog(a).filter((l) => l.kind === 'start')
  const tail = (a) => { const s = starts(a).at(-1) ?? {}; return s.env?.auth_token_tail ?? s.gateway_key_tail ?? null }
  const settle = async (a, text) => {
    const n = rig.turns(a).filter((t) => t.ended_at).length
    await rig.userMail(a, text)
    await rig.waitTurns(a, n + 1)
  }
  const idle = () => rig.waitFor(() => rig.sql('SELECT 1 FROM ot.turns WHERE ended_at IS NULL').length === 0, { what: 'turns to settle', timeout: 60000 })
  const secretTail = (id) => rig.one(`SELECT right(secret, 6) AS t FROM ot.account_secrets WHERE account_id = '${id}'`)?.t
  const account = (name) => rig.one(`SELECT account, frozen, pending_account FROM ot.agents WHERE name = '${name}' AND state = 'live'`)
  await rig.waitFor(async () => JSON.stringify((await rig.api('GET', `/api/orgs/${rig.org}/staffing-options`)).tiers ?? []).includes(TIER),
    { what: 'the favorite to be a tier', timeout: 30000 })

  fs.writeFileSync(keyFile('openrouter-2'), JSON.stringify({ status: 200, data: FULL }))
  await rig.api('POST', '/api/openrouter/keys', { key: 'sk-or-rig-not-a-real-key-TWO222', label: 'team' })

  // ------------------------------------------------ 1. replacement, Claude Code harness
  await rig.op({ op: 'hire', name: 'keytwo', parent: 'boss', tier: TIER, grant: 1, title: 'on key two', account: 'openrouter-2' })
  await idle()
  await settle('keytwo', 'PROOF-FIX: first.')
  const s0 = starts('keytwo').length
  p.check('control: keytwo runs on TWO222', tail('keytwo') === 'TWO222', { tail: tail('keytwo'), starts: s0 })
  await settle('keytwo', 'PROOF-FIX: nothing changed.')
  p.check('control: a turn with nothing changed reuses the warm CLI', starts('keytwo').length === s0, { starts: starts('keytwo').length, s0 })
  await rig.api('PUT', '/api/openrouter/keys/openrouter-2', { key: 'sk-or-rig-not-a-real-key-NEW333' })
  p.check('control: the stored secret was replaced', secretTail('openrouter-2') === 'NEW333')
  await settle('keytwo', 'PROOF-FIX: after replacement.')
  p.check('the next turn after a replacement starts a new CLI with the new key (Claude Code)',
    starts('keytwo').length === s0 + 1 && tail('keytwo') === 'NEW333', { starts: starts('keytwo').length, s0, tail: tail('keytwo') })
  await settle('keytwo', 'PROOF-FIX: steady again.')
  p.check('after it, a turn with nothing changed reuses the new CLI', starts('keytwo').length === s0 + 1, { starts: starts('keytwo').length })
  p.check('no secret value is in the agent row or its fingerprint',
    !JSON.stringify(rig.sql("SELECT extra::text AS e FROM ot.agents WHERE name = 'keytwo'")).includes('not-a-real-key'))

  // ------------------------------------------------ 1b. replacement, Codex harness
  const h = await rig.api('GET', '/api/openrouter')
  const codexOffered = JSON.stringify(h.harness ?? h).includes('codex-cli')
  if (codexOffered) {
    await rig.api('PUT', '/api/openrouter/harness', { harness: 'codex-cli' })
    await settle('keytwo', 'PROOF-FIX: on codex.')
    const c0 = starts('keytwo').length
    p.check('control: on the Codex harness keytwo runs on NEW333', tail('keytwo') === 'NEW333', starts('keytwo').at(-1))
    await rig.api('PUT', '/api/openrouter/keys/openrouter-2', { key: 'sk-or-rig-not-a-real-key-COD444' })
    await settle('keytwo', 'PROOF-FIX: codex after replacement.')
    p.check('the next turn after a replacement starts a new CLI with the new key (Codex)',
      starts('keytwo').length === c0 + 1 && tail('keytwo') === 'COD444', { starts: starts('keytwo').length, c0, tail: tail('keytwo') })
    await rig.api('PUT', '/api/openrouter/harness', { harness: 'claude-code' })
  } else {
    p.note('the Codex harness is not offered in this rig run: the Codex replacement case did not run')
  }

  // ------------------------------------------------ 1c. a late answer for the old key
  // the canned answer is read before its 1.5 s wait, as a request is sent
  // before its reply: OLD-READ belongs to the key stored when the read began
  fs.writeFileSync(keyFile('openrouter-2'), JSON.stringify({ status: 200, delay_ms: 1500, data: { ...FULL, label: 'OLD-READ' } }))
  const slow = rig.tool('boss', 'orgtree_usage', { accounts: ['openrouter-2'], refresh: true })
  await sleep(400)
  fs.writeFileSync(keyFile('openrouter-2'), JSON.stringify({ status: 200, data: { ...FULL, label: 'NEW-READ' } }))
  await rig.api('PUT', '/api/openrouter/keys/openrouter-2', { key: 'sk-or-rig-not-a-real-key-LATE55' })
  await slow
  const cached = (await rig.api('GET', '/api/openrouter/keys/usage'))['openrouter-2']
  p.check('an answer for a key replaced during the read is not cached; the stored key is read instead',
    cached?.key_label === 'NEW-READ', { key_label: cached?.key_label })
  p.check('control: the slow read did wait out the replacement (its retry is logged)',
    /OpenRouter key replaced during the read/.test(rig.engineLog()))

  // ------------------------------------------------ 2. capped key, account balance at zero
  await idle()
  fs.writeFileSync(keyFile('openrouter-2'), JSON.stringify({ status: 200, data: { ...FULL, total_credits: 30, total_usage: 30 } }))
  await rig.tool('boss', 'orgtree_usage', { accounts: ['openrouter-2'], refresh: true })
  const capped = (await rig.api('GET', '/api/openrouter/keys/usage'))['openrouter-2']?.limits?.[0]
  p.check('control: the capped zero-balance reading is active at 30% of its cap', capped?.is_active === true && capped?.percent === 30, capped)
  await rig.op({ op: 'hire', name: 'mover', parent: 'boss', tier: TIER, grant: 1, title: 'moves between keys' })
  await idle()
  const spent = await rig.tool('boss', 'orgtree_continue_on', { node: 'mover', account: 'openrouter-2' })
  p.check('continuing on the capped key with no account balance is refused', spent.ok === false, spent)
  fs.writeFileSync(keyFile('openrouter-2'), JSON.stringify({ status: 200, data: FULL }))
  await rig.tool('boss', 'orgtree_usage', { accounts: ['openrouter-2'], refresh: true })
  const room = await rig.tool('boss', 'orgtree_continue_on', { node: 'mover', account: 'openrouter-2' })
  p.check('control: with balance the same continuation is accepted', room.ok !== false && account('mover')?.account === 'openrouter-2', { room, row: account('mover') })
  await idle()

  // ------------------------------------------------ 3. private reading text stays out of the log
  fs.writeFileSync(path.join(usageDir, 'openrouter-2.json'), JSON.stringify({ available: false, error: MARKER, detail: `private provider body ${MARKER}` }))
  const from = rig.engineLog().length
  await rig.api('PUT', '/api/openrouter/keys/openrouter-2', { key: 'sk-or-rig-not-a-real-key-PRIV66' })
  await rig.tool('boss', 'orgtree_usage', { accounts: ['openrouter-2'], refresh: true })
  await rig.api('GET', '/api/openrouter/keys/usage')
  const after = rig.engineLog().slice(from)
  p.check('a reading\'s private provider text is not in the engine log', !after.includes(MARKER),
    after.split(/\r?\n/).filter((l) => l.includes(MARKER)).map((l) => l.slice(0, 300)))
  p.check('control: the readers\' safe summary line is logged', /OpenRouter key usage read.*detail=true/.test(after) || /OpenRouter key usage read/.test(after))
  fs.unlinkSync(path.join(usageDir, 'openrouter-2.json'))

  // ------------------------------------------------ 6. same secret twice at once
  const { port, password } = rig.pgConn()
  const blocker = spawn(path.join(rig.run.pgBin, 'psql.exe'), ['-X', '-q', '-At', '-v', 'ON_ERROR_STOP=1', '-h', '127.0.0.1', '-p', String(port),
    '-U', 'orgtree_admin', '-d', 'orgtree_engine', '-c',
    "BEGIN; SELECT account_id FROM ot.account_secrets WHERE account_id IN ('openrouter-key','openrouter-2') FOR UPDATE; SELECT pg_sleep(2); COMMIT;"],
  { env: { ...process.env, PGPASSWORD: password, PGAPPNAME: 'or-proof-lock', PGCONNECT_TIMEOUT: '5' }, windowsHide: true, stdio: 'ignore' })
  const blockerDone = new Promise((resolve, reject) => { blocker.once('error', reject); blocker.once('exit', resolve) })
  try {
    await rig.waitFor(() => rig.one("SELECT wait_event FROM pg_stat_activity WHERE application_name = 'or-proof-lock'")?.wait_event === 'PgSleep',
      { what: 'the blocker to hold the secret rows', timeout: 5000, every: 50 })
    p.check('control: a transaction holds both secret rows', true)
    const raced = await Promise.allSettled(['openrouter-key', 'openrouter-2'].map((id) =>
      rig.api('PUT', `/api/openrouter/keys/${id}`, { key: 'sk-or-rig-not-a-real-key-DUPE77' })))
    const codes = raced.map((r) => r.status === 'fulfilled' ? 200 : r.reason.status)
    p.check('two replacements with the same secret at once: one succeeds, one is refused (409)',
      codes.filter((c) => c === 200).length === 1 && codes.filter((c) => c === 409).length === 1, codes)
    p.check('control: the blocker exits cleanly', (await blockerDone) === 0)
  } finally {
    if (blocker.exitCode == null) blocker.kill()
  }
  const db = rig.one("SELECT count(*)::integer AS n, count(DISTINCT secret)::integer AS d FROM ot.account_secrets WHERE account_id LIKE 'openrouter%'")
  p.check('every stored key is a distinct secret', db?.n === db?.d && db?.n === 2, db)
  // the original's tail again (whichever won the race)
  await rig.api('PUT', '/api/openrouter/keys/openrouter-key', { key: 'sk-or-rig-not-a-real-key-ONE111' }).catch(() => null)
  await rig.api('PUT', '/api/openrouter/keys/openrouter-2', { key: 'sk-or-rig-not-a-real-key-TWO222' }).catch(() => null)
  p.check('control: a sequential duplicate is still refused (409)',
    await refused(rig.api('PUT', '/api/openrouter/keys/openrouter-2', { key: 'sk-or-rig-not-a-real-key-ONE111' })) === 409)

  // ------------------------------------------------ 5. a later start
  fs.writeFileSync(path.join(rig.fakeDir, 'version-delay-ms'), '3000')
  await rig.restart()
  const cold = await rig.api('GET', `/api/orgs/${rig.org}/staffing-options`)
  let early = null
  try { early = await rig.op({ op: 'hire', name: 'restarted', parent: 'boss', tier: TIER, grant: 1, title: 'right after a restart' }) } catch (e) { early = { status: e.status, message: e.message } }
  p.check('control: provider discovery had not finished when the hire came', cold.loading === true || !JSON.stringify(cold.tiers ?? []).includes(TIER),
    { loading: cold.loading, tiers: (cold.tiers ?? []).length })
  p.check('on a later start a stored favorite is hireable before discovery finishes', early?.status == null, early)
  fs.unlinkSync(path.join(rig.fakeDir, 'version-delay-ms'))
  await idle()

  // ------------------------------------------------ 4. removing the original key
  await rig.op({ op: 'hire', name: 'unbound', parent: 'boss', tier: TIER, grant: 1, title: 'on the original by default' })
  await rig.op({ op: 'hire', name: 'pinned', parent: 'boss', tier: TIER, grant: 1, title: 'bound to the original', account: 'openrouter-key' })
  await idle()
  p.check('control: unbound is unbound, pinned is bound to the original',
    account('unbound')?.account == null && account('pinned')?.account === 'openrouter-key', { unbound: account('unbound'), pinned: account('pinned') })
  await rig.api('POST', `/api/orgs/${rig.org}/settings`, { default_account: 'openrouter-key' }).catch(() => null)
  p.check('control: the org default names the original before its removal',
    rig.one(`SELECT settings->>'default_account' AS d FROM ot.orgs WHERE slug = '${rig.org}'`)?.d === 'openrouter-key')
  const r1 = await rig.api('DELETE', '/api/openrouter/keys/openrouter-key')
  p.check('removing the original reassigns its unbound and bound seats to another key',
    account('unbound')?.account === 'openrouter-2' && account('pinned')?.account === 'openrouter-2' && account('unbound')?.frozen == null,
    { r1, unbound: account('unbound'), pinned: account('pinned') })
  p.check('the reassignment is recorded per seat',
    rig.sql("SELECT detail->>'node' AS n FROM ot.events WHERE op = 'account_removed' AND detail->>'removed_account' = 'openrouter-key'").length >= 2)
  p.check('an org default naming the original is cleared',
    rig.one(`SELECT settings->>'default_account' AS d FROM ot.orgs WHERE slug = '${rig.org}'`)?.d == null)
  const q = await rig.tool('boss', 'orgtree_usage', { accounts: ['openrouter'], refresh: true })
  p.check('the usage tool no longer offers the removed original lane', q.ok === false || !JSON.stringify(q).includes('"enabled":true'), q)
  const n = rig.turns('unbound').filter((t) => t.ended_at).length
  await rig.userMail('unbound', 'PROOF-FIX: after the original went.')
  await rig.waitTurns('unbound', n + 1)
  p.check('a reassigned seat runs on its new key', tail('unbound') === 'TWO222', { tail: tail('unbound') })

  // with no other key it may run on, a live seat freezes, saying so
  await rig.api('POST', '/api/openrouter/keys', { key: 'sk-or-rig-not-a-real-key-ORIG88' })
  p.check('control: a key added with none original stored is the original again',
    rig.one("SELECT id FROM ot.accounts WHERE id = 'openrouter-key'") != null)
  await rig.op({ op: 'hire', name: 'lonely', parent: 'boss', tier: TIER, grant: 1, title: 'only the original' })
  await idle()
  await rig.api('POST', `/api/orgs/${rig.org}/settings`, { disabled_accounts: ['openrouter-2'] })
  const r2 = await rig.api('DELETE', '/api/openrouter/keys/openrouter-key')
  const lonely = account('lonely')
  p.check('with no other key the org allows, removing the original freezes the seat, saying so',
    lonely?.frozen?.cause === 'account' && /original OpenRouter key was removed/.test(lonely?.frozen?.error ?? ''), { r2, lonely })
  await rig.api('POST', `/api/orgs/${rig.org}/settings`, { disabled_accounts: [] })

  const alive = await rig.api('GET', '/api/app/records').then(() => true, () => false)
  p.check('the engine still answers', alive)
  p.check('no secret reached the engine log', !rig.engineLog().includes('sk-or-rig-not-a-real-key'))
  p.keep(rig, { agents: ['keytwo', 'mover', 'unbound', 'pinned', 'lonely', 'restarted'], grep: /openrouter|account_removed|panic/i })
  return p.summary()
}
