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
//      and the usage tool no longer offers the removed lane; an org-first
//      writer holding the org makes it retry whole (NOWAIT), or refuse unchanged;
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
  const secretTail = (id) => rig.one(`SELECT right(secret, 6) AS tail FROM ot.account_secrets WHERE account_id = '${id}'`)?.tail
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
  p.check('control: the stored secret was replaced', secretTail('openrouter-2') === 'NEW333', { tail: secretTail('openrouter-2') })
  await settle('keytwo', 'PROOF-FIX: after replacement.')
  p.check('the next turn after a replacement starts a new CLI with the new key (Claude Code)',
    starts('keytwo').length === s0 + 1 && tail('keytwo') === 'NEW333', { starts: starts('keytwo').length, s0, tail: tail('keytwo') })
  await settle('keytwo', 'PROOF-FIX: steady again.')
  p.check('after it, a turn with nothing changed reuses the new CLI', starts('keytwo').length === s0 + 1, { starts: starts('keytwo').length })
  p.check('no secret value is in the agent row or its fingerprint',
    !JSON.stringify(rig.sql("SELECT extra::text AS e FROM ot.agents WHERE name = 'keytwo'")).includes('not-a-real-key'))

  // ------------------------------------------------ 1b. replacement, Codex harness
  // A seat hired with an explicit harness is pinned to it (user ruling
  // 2026-10-13; the key keeps Claude Code for keytwo), so codextwo runs on
  // `codex app-server`: the fake logs every line of that process with mode
  // "codex" and its pid.
  const h = await rig.api('GET', '/api/openrouter')
  const codexOpt = (h.harness?.harnesses ?? []).find((o) => o.id === 'codex-cli')
  p.check('control: the Codex harness is available in this rig', codexOpt?.available === true, codexOpt)
  await rig.op({ op: 'hire', name: 'codextwo', parent: 'boss', tier: TIER, grant: 1, title: 'on key two, Codex', account: 'openrouter-2',
                 harness: 'codex-cli' })
  await idle()
  p.check('control: codextwo is stamped with the Codex harness and pinned to it',
    rig.agentRow('codextwo')?.extra?.harness === 'codex-cli' && rig.agentRow('codextwo')?.extra?.harness_pin === true, rig.agentRow('codextwo')?.extra)
  const cLog = () => rig.fakeLog('codextwo')
  const cStarts = () => cLog().filter((l) => l.kind === 'start')
  const lastTurn = (marker) => {
    const log = cLog()
    const t = log.findLast((l) => l.kind === 'turn' && String(l.prompt ?? '').includes(marker))
    const end = t && log.slice(log.indexOf(t)).find((l) => l.kind === 'turn_end' && l.pid === t.pid)
    const row = rig.turns('codextwo').at(-1)
    return { pid: t?.pid, mode: t?.mode, status: end?.status, row: row && { ended: !!row.ended_at, error: row.error, killed: row.killed },
             account: rig.one("SELECT t.account FROM ot.turns t JOIN ot.agents a ON a.id = t.agent_id WHERE a.name = 'codextwo' ORDER BY t.id DESC LIMIT 1")?.account }
  }
  const ok = (t) => t.mode === 'codex' && t.status === 'completed' && t.row?.ended && !t.row.error && !t.row.killed && t.account === 'openrouter-2'
  const cur = secretTail('openrouter-2')
  await settle('codextwo', 'PROOF-CODEX: first.')
  const c0 = cStarts().length
  const first = cStarts().at(-1) ?? {}
  const t1 = lastTurn('PROOF-CODEX: first.')
  p.check('the codextwo seat runs a Codex CLI: an app-server on the stored key, and its turn completes on key two',
    first.mode === 'codex' && JSON.stringify(first.args ?? '').includes('app-server') && first.gateway_key_tail === cur && t1.pid === first.pid && ok(t1),
    { args: first.args, mode: first.mode, gateway_key_tail: first.gateway_key_tail, cur, turn: t1 })
  await settle('codextwo', 'PROOF-CODEX: nothing changed.')
  const t2 = lastTurn('PROOF-CODEX: nothing changed.')
  p.check('on Codex, a turn with nothing changed reuses the warm app-server', cStarts().length === c0 && t2.pid === first.pid && ok(t2),
    { starts: cStarts().length, c0, turn: t2 })
  await rig.api('PUT', '/api/openrouter/keys/openrouter-2', { key: 'sk-or-rig-not-a-real-key-COD444' })
  p.check('control: the stored secret was replaced (Codex case)', secretTail('openrouter-2') === 'COD444')
  await settle('codextwo', 'PROOF-CODEX: after replacement.')
  const second = cStarts().at(-1) ?? {}
  const t3 = lastTurn('PROOF-CODEX: after replacement.')
  p.check('the next turn after a replacement starts a new Codex app-server with the new key, and completes',
    cStarts().length === c0 + 1 && second.mode === 'codex' && JSON.stringify(second.args ?? '').includes('app-server')
    && second.gateway_key_tail === 'COD444' && second.pid !== first.pid && t3.pid === second.pid && ok(t3),
    { starts: cStarts().length, c0, gateway_key_tail: second.gateway_key_tail, pids: [first.pid, second.pid], turn: t3 })
  await settle('codextwo', 'PROOF-CODEX: steady again.')
  const t4 = lastTurn('PROOF-CODEX: steady again.')
  p.check('after it, a Codex turn with nothing changed reuses the new app-server', cStarts().length === c0 + 1 && t4.pid === second.pid && ok(t4),
    { starts: cStarts().length, turn: t4 })

  // ------------------------------------------------ 1c. a late answer for the old key
  // the canned answer is read before its 1.5 s wait, as a request is sent
  // before its reply: OLD-READ belongs to the key stored when the read began.
  // A replacement reads the replaced key at once (the usage tool's manual
  // refresh is floored at 60 s per lane, so it cannot start a read here)
  fs.writeFileSync(keyFile('openrouter-2'), JSON.stringify({ status: 200, delay_ms: 1500, data: { ...FULL, label: 'OLD-READ' } }))
  const slow = rig.api('PUT', '/api/openrouter/keys/openrouter-2', { key: 'sk-or-rig-not-a-real-key-SLOW77' })
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
  await rig.api('PUT', '/api/openrouter/keys/openrouter-2', { key: 'sk-or-rig-not-a-real-key-CAP888' })
  const capped = (await rig.api('GET', '/api/openrouter/keys/usage'))['openrouter-2']?.limits?.[0]
  p.check('control: the capped zero-balance reading is active at 30% of its cap', capped?.is_active === true && capped?.percent === 30, capped)
  await rig.op({ op: 'hire', name: 'mover', parent: 'boss', tier: TIER, grant: 1, title: 'moves between keys' })
  await idle()
  const spent = await rig.tool('boss', 'orgtree_continue_on', { node: 'mover', account: 'openrouter-2' })
  p.check('continuing on the capped key with no account balance is refused', spent.ok === false, spent)
  fs.writeFileSync(keyFile('openrouter-2'), JSON.stringify({ status: 200, data: FULL }))
  await rig.api('PUT', '/api/openrouter/keys/openrouter-2', { key: 'sk-or-rig-not-a-real-key-ROOM99' })
  const room = await rig.tool('boss', 'orgtree_continue_on', { node: 'mover', account: 'openrouter-2' })
  p.check('control: with balance the same continuation is accepted', room.ok !== false && account('mover')?.account === 'openrouter-2', { room, row: account('mover') })
  await idle()

  // ------------------------------------------------ 3. private reading text stays out of the log
  fs.writeFileSync(path.join(usageDir, 'openrouter-2.json'), JSON.stringify({ available: false, error: MARKER, detail: `private provider body ${MARKER}` }))
  const from = rig.engineLog().length
  await rig.api('PUT', '/api/openrouter/keys/openrouter-2', { key: 'sk-or-rig-not-a-real-key-PRIV66' })
  await rig.tool('boss', 'orgtree_usage', { accounts: ['openrouter-2'], refresh: true })
  // the text arrives where it is meant to: the keys' usage (cache), the
  // panel's document (API) and the app feed's state (what windows are sent)
  const viaCache = (await rig.api('GET', '/api/openrouter/keys/usage'))['openrouter-2']
  const viaDoc = ((await rig.api('GET', '/api/openrouter')).keys ?? []).find((k) => k.id === 'openrouter-2')
  await rig.api('GET', '/api/openrouter/usage')
  const viaFeed = (await rig.api('GET', '/api/app/records'))?.runtime?.values?.openrouter_keys_usage?.value?.['openrouter-2']
  p.check('control: the private text arrives in the keys\' usage (cache)', viaCache?.error === MARKER, viaCache?.error)
  p.check('control: the private text arrives in the panel document (API)', String(viaDoc?.reason ?? '').includes(MARKER), viaDoc?.reason)
  p.check('control: the private text arrives in the app feed\'s state (feed)', viaFeed?.error === MARKER, viaFeed?.error)
  await sleep(500)
  const after = rig.engineLog().slice(from)
  const leaks = after.split(/\r?\n/).filter((l) => l.includes(MARKER))
  p.check('control: the interval holds the replacement, the reads and the feed pushes',
    /PUT \/api\/openrouter\/keys\/openrouter-2/.test(after) && /GET \/api\/app\/records/.test(after)
    && /app value pushed key=openrouter_keys_usage/.test(after) && /app frame broadcast/.test(after), after.length)
  p.check('a reading\'s private provider text is in no engine log line of the interval (readers, feed, routes)', leaks.length === 0,
    leaks.map((l) => l.slice(0, 300)))
  p.check('control: the readers\' safe summary line is logged', /OpenRouter key usage read lane=openrouter-2 available=false error=true detail=true/.test(after))
  p.check('control: the routes\' safe summary line is logged', /usage reading served \(body not logged\) route="?openrouter_doc/.test(after)
    || /route="?openrouter_doc"?.*usage reading served/.test(after))
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
  // An org-first writer holding this org FOR NO KEY UPDATE (as folder and
  // settings writes do; it still admits the event rows' key-share checks)
  // while the removal reaches its late default scan: the scan never waits
  // (NOWAIT), the attempt rolls back whole, and the bounded retry either
  // outlasts a short hold or refuses with nothing changed.
  const holdOrg = (secs) => {
    const h = spawn(path.join(rig.run.pgBin, 'psql.exe'), ['-X', '-q', '-At', '-v', 'ON_ERROR_STOP=1', '-h', '127.0.0.1', '-p', String(port),
      '-U', 'orgtree_admin', '-d', 'orgtree_engine', '-c',
      `BEGIN; SELECT id FROM ot.orgs WHERE slug = '${rig.org}' FOR NO KEY UPDATE; SELECT pg_sleep(${secs}); COMMIT;`],
    { env: { ...process.env, PGPASSWORD: password, PGAPPNAME: 'or-proof-org', PGCONNECT_TIMEOUT: '5' }, windowsHide: true, stdio: 'ignore' })
    const done = new Promise((resolve, reject) => { h.once('error', reject); h.once('exit', resolve) })
    return { h, done, held: () => rig.waitFor(() => rig.one("SELECT wait_event FROM pg_stat_activity WHERE application_name = 'or-proof-org'")?.wait_event === 'PgSleep',
      { what: 'the org holder to hold the org row', timeout: 5000, every: 20 }) }
  }
  const retries = () => (rig.engineLog().match(/original OpenRouter key removal conflicted; retrying entire transaction/g) ?? []).length
  const removedEvents = () => rig.sql("SELECT 1 AS e FROM ot.events WHERE op = 'account_removed' AND detail->>'removed_account' = 'openrouter-key'").length
  const long = holdOrg(2)
  try {
    await long.held()
    const before = retries()
    const t0 = Date.now()
    const code = await refused(rig.api('DELETE', '/api/openrouter/keys/openrouter-key'))
    const ms = Date.now() - t0
    p.check('while an org-first writer holds the org past the retry budget, removing the original is refused without waiting for it',
      code != null && ms < 1500, { code, ms })
    p.check('control: the refusal came after the bounded retries (3 logged)', retries() - before === 3, retries() - before)
    p.check('the refused removal changed nothing: key, secret, seats, default and events are as before',
      rig.one("SELECT 1 AS k FROM ot.accounts a JOIN ot.account_secrets s ON s.account_id = a.id WHERE a.id = 'openrouter-key'") != null
      && account('unbound')?.account == null && account('pinned')?.account === 'openrouter-key' && removedEvents() === 0
      && rig.one(`SELECT settings->>'default_account' AS d FROM ot.orgs WHERE slug = '${rig.org}'`)?.d === 'openrouter-key',
      { unbound: account('unbound'), pinned: account('pinned'), events: removedEvents() })
    p.check('control: the long holder exits cleanly', (await long.done) === 0)
  } finally {
    if (long.h.exitCode == null) long.h.kill()
  }
  const brief = holdOrg(0.08)
  let r1
  try {
    await brief.held()
    const before = retries()
    r1 = await rig.api('DELETE', '/api/openrouter/keys/openrouter-key')
    p.check('control: a brief org hold made the removal retry at least once', retries() - before >= 1, retries() - before)
    await brief.done
  } finally {
    if (brief.h.exitCode == null) brief.h.kill()
  }
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
  p.check('the private provider text is in no engine log line of the whole run (every session log)', !rig.engineLog().includes(MARKER),
    rig.engineLogFiles().length)
  p.keep(rig, { agents: ['keytwo', 'codextwo', 'mover', 'unbound', 'pinned', 'lonely', 'restarted'], grep: /openrouter|account_removed|panic/i })
  return p.summary()
}
