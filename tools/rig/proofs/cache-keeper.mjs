// Proof: the working cache keeper as 3.x ran it (supervisor.py
//   _working_cache_keeper_pass, _working_cache_due, _working_cache_read,
//   _cancel_working_cache), with working checkups switched off, on a run whose
//   keeper passes every 3 s (`reminders: 3`). Ages are made by back-dating
//   turns and the keepalive stamp.
//   kay (subscription, reported working, idle 55 minutes): one disposable
//   read of her session prefix: her own launch on a fork of her session
//   (--fork-session --max-turns 1) with the keepalive prompt; nothing of it
//   stays in her session (same session id, the fork's transcript removed, no
//   turn, no desk row); its cost is banked on her; her cache receipt is
//   refreshed; not again on the next passes. Nobody else: not an idle agent,
//   a Codex agent or a halted one. ann (API-key account) is read after 4
//   minutes, kay is not. A tool the read tries is denied (orgtree and
//   native). Real work kills a running keepalive and is not held up; a
//   cancelled keepalive is no failure (the next runs at once), a failed one
//   backs the next off. No keepalive while working checkups are on.
// Run: node tools/rig/rig.mjs run tools/rig/proofs/cache-keeper.mjs

import fs from 'node:fs'
import path from 'node:path'

import { Proof } from '../proof.mjs'

// the automatic wakes' sweeps, the keeper's every 3 s
export async function setup() {
  return { reminders: 3 }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const PROMPT = 'This is an automated prompt-cache keepalive. Reply with exactly OK and do not use tools.'
const USAGE = { input_tokens: 40, cache_read_input_tokens: 21000, cache_creation_input_tokens: 0, output_tokens: 2,
  cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 } }

export default async function (rig) {
  const p = new Proof('cache-keeper')
  const KA = 'prompt-cache keepalive'
  rig.scenario({
    agents: {
      kay: { turns: [
        { name: 'ka1', match: KA, once: true, steps: [{ usage: USAGE, cost_usd: 0.0123 }, { text: 'OK' }] },
        { name: 'ka2-tools', match: KA, once: true, steps: [{ usage: USAGE, cost_usd: 0.004 },
          { tool: 'orgtree_status', args: { status: 'idle', summary: 'the keepalive must not run this' } },
          { tool: 'Bash', args: { command: 'echo keepalive' }, result: 'keepalive' }, { text: 'OK' }] },
        { name: 'ka3-slow', match: KA, once: true, steps: [{ sleep_ms: 30000 }, { text: 'OK' }] },
        { name: 'ka4', match: KA, once: true, steps: [{ usage: USAGE, cost_usd: 0.001 }, { text: 'OK' }] },
        { name: 'ka5-error', match: KA, once: true, steps: [{ result: { is_error: true, subtype: 'error_during_execution', text: 'boom' } }] },
      ] },
    },
    default: { turns: [{ name: 'default', steps: [{ text: 'OK.' }] }] },
  })
  const runtime = body => rig.api('PUT', '/api/app-settings/runtime', body)
  await runtime({ working_checkups_enabled: false, idle_docket_reminders_enabled: false })
  await rig.waitFor(() => rig.sql(`SELECT 1 FROM ot.turns WHERE ended_at IS NULL`).length === 0, { what: 'seed turns to settle', timeout: 60000 })
  const K = (await rig.api('POST', '/api/accounts', { provider: 'claude', kind: 'apikey', key: 'sk-ant-api03-rig-not-a-real-key' })).id
  const hire = (name, extra = {}) => rig.op({ op: 'hire', name, parent: 'boss', tier: 'haiku', title: 'Keeper agent', ...extra })
  await hire('kay'); await hire('ann', { account: K }); await hire('ida'); await hire('hal'); await hire('cod', { tier: 'luna' })
  const id = name => rig.agentRow(name).id
  for (const name of ['kay', 'ann', 'ida', 'hal', 'cod']) {
    await rig.userMail(name, `Hello ${name}, start a session.`)
    await rig.waitTurns(name, 1)
  }
  for (const name of ['kay', 'ann', 'hal', 'cod']) await rig.tool(name, 'orgtree_status', { status: 'working', summary: 'on it' })
  await rig.api('POST', `/api/orgs/${rig.org}/nodes/hal/halt`)
  const row = name => rig.one(`SELECT session_id, cost_usd::float8 AS cost, extra->>'cache_keepalive_at' AS kept, extra->'cache_receipt' AS receipt,
      last_status->>'status' AS status FROM ot.agents WHERE id = ${id(name)}`)
  // these agents' last real request `min` minutes ago (their turns; their keepalive stamp removed)
  const age = (names, min) => rig.exec(`
    UPDATE ot.turns t SET started_at = now() - interval '${min} minutes' - (t.ended_at - t.started_at), ended_at = now() - interval '${min} minutes'
     WHERE t.agent_id IN (${names.map(id).join(', ')}) AND t.ended_at IS NOT NULL;
    UPDATE ot.agents SET extra = extra - 'cache_keepalive_at' WHERE id IN (${names.map(id).join(', ')});`)
  const starts = name => rig.fakeLog(name).filter(l => l.kind === 'start')
  const forks = name => starts(name).filter(l => l.forked_from)
  const turnCount = name => rig.one(`SELECT count(*)::int AS n FROM ot.turns WHERE agent_id = ${id(name)}`).n
  const convoCount = name => rig.one(`SELECT count(*)::int AS n FROM ot.convo WHERE agent_id = ${id(name)}`).n
  const projects = path.join(rig.data, 'rig-home', '.claude', 'projects')
  const transcriptOf = sid => {
    if (!sid || !fs.existsSync(projects)) return null
    for (const d of fs.readdirSync(projects)) {
      const f = path.join(projects, d, `${sid}.jsonl`)
      if (fs.existsSync(f)) return f
    }
    return null
  }

  // ---------------------------------------------------------------- kay: one read
  const before = row('kay'); const turnsBefore = turnCount('kay'); const convoBefore = convoCount('kay')
  age(['kay', 'ida', 'hal', 'cod'], 55)
  const came = await rig.waitFor(() => row('kay')?.kept, { what: 'kay\'s keepalive', timeout: 30000 }).then(() => true, () => false)
  if (!came) {
    p.check('a working Claude agent idle 55 minutes gets one read', false, { forks: forks('kay').length, kept: row('kay')?.kept ?? null })
    return p.save()
  }
  const after = row('kay')
  const fk = forks('kay')
  const read = rig.fakeLog('kay').filter(l => l.kind === 'turn' && String(l.prompt ?? '').includes(PROMPT))
  p.note('kay', { before, after, forks: fk.map(f => ({ session: f.session, from: f.forked_from, max: f.max_turns, model: f.model })) })
  p.check('a working Claude agent idle 55 minutes gets one read: her own launch on a fork of her session, one turn at most, the keepalive prompt',
    fk.length === 1 && fk[0].forked_from === before.session_id && fk[0].max_turns === 1 && fk[0].session !== before.session_id
    && read.length === 1 && fk[0].model === starts('kay')[0].model, { fork: fk[0], reads: read.length })
  const own = transcriptOf(before.session_id)
  p.check('nothing of it stays in her session: same session id, the fork\'s transcript removed, her transcript without the prompt, no turn, no desk row',
    after.session_id === before.session_id && !transcriptOf(fk[0]?.session) && !!own && !fs.readFileSync(own, 'utf8').includes(PROMPT)
    && turnCount('kay') === turnsBefore && convoCount('kay') === convoBefore,
  { forkFile: transcriptOf(fk[0]?.session), own: !!own, turns: [turnsBefore, turnCount('kay')], convo: [convoBefore, convoCount('kay')] })
  p.check('its cost is banked on her and her cache receipt is refreshed',
    Math.abs((after.cost - before.cost) - 0.0123) < 1e-6 && !!after.receipt && Date.now() - Date.parse(after.receipt.at) < 60000,
  { cost: [before.cost, after.cost], receipt: after.receipt })
  await sleep(10000)
  p.check('not again on the next passes: her keepalive stamp is her last request now', forks('kay').length === 1, forks('kay').length)
  p.check('nobody else was read: not the idle ida, the Codex cod or the halted hal',
    ['ida', 'hal', 'cod'].every(n => forks(n).length === 0), Object.fromEntries(['ida', 'hal', 'cod'].map(n => [n, forks(n).length])))

  // ---------------------------------------------------------------- lanes
  rig.exec(`UPDATE ot.agents SET extra = jsonb_set(extra, '{cache_keepalive_at}', to_jsonb(to_char((now() - interval '5 minutes') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')))
     WHERE id IN (${id('ann')}, ${id('kay')});
    UPDATE ot.turns SET started_at = now() - interval '6 minutes', ended_at = now() - interval '6 minutes' WHERE agent_id IN (${id('ann')}, ${id('kay')});`)
  await rig.waitFor(() => forks('ann').length === 1, { what: 'ann\'s keepalive', timeout: 30000 })
  await sleep(6000)
  p.check('an API-key agent is read after 4 minutes; a subscription agent is not', forks('ann').length === 1 && forks('kay').length === 1,
    { ann: forks('ann').length, kay: forks('kay').length })

  // ---------------------------------------------------------------- tools denied
  age(['kay'], 55)
  await rig.waitFor(() => forks('kay').length === 2 && row('kay')?.kept, { what: 'kay\'s second keepalive', timeout: 30000 })
  await sleep(1500)
  const denied = rig.fakeLog('kay').filter(l => l.kind === 'tool_denied')
  p.check('a tool the read tries is denied before it runs, orgtree and native alike (her status stays working)',
    denied.length === 2 && denied.some(d => d.tool === 'orgtree_status') && denied.some(d => d.tool === 'Bash') && row('kay').status === 'working'
    && !rig.fakeLog('kay').some(l => l.kind === 'tool_result' && l.tool === 'orgtree_status'),
  { denied: denied.map(d => ({ tool: d.tool, reason: d.reason })), status: row('kay').status })

  // ---------------------------------------------------------------- real work first
  age(['kay'], 55)
  await rig.waitFor(() => forks('kay').length === 3, { what: 'kay\'s slow keepalive to start', timeout: 30000 })
  await sleep(2000)
  const t0 = Date.now()
  await rig.userMail('kay', 'Real work for kay.')
  const turns = await rig.waitTurns('kay', turnsBefore + 1, { timeout: 30000 })
  const tookMs = Date.now() - t0
  p.check('real work kills a running keepalive and is not held up behind it (no stamp from the killed read)',
    turns.length === turnsBefore + 1 && tookMs < 15000 && !row('kay').kept, { tookMs, kept: row('kay').kept })
  age(['kay'], 55)
  await rig.waitFor(() => forks('kay').length === 4 && row('kay')?.kept, { what: 'kay\'s next keepalive', timeout: 15000 })
  p.check('a cancelled keepalive is no failure: the next one runs at once', forks('kay').length === 4, forks('kay').length)
  await sleep(2000)
  age(['kay'], 55)
  await rig.waitFor(() => forks('kay').length === 5, { what: 'kay\'s failing keepalive', timeout: 15000 })
  await sleep(2000)
  age(['kay'], 55)
  await sleep(12000)
  p.check('a failed keepalive backs the next off (60 s)', forks('kay').length === 5 && !row('kay').kept, { forks: forks('kay').length })

  // ---------------------------------------------------------------- one mode or the other
  await runtime({ working_checkups_enabled: true })
  const annForks = forks('ann').length
  age(['ann'], 55)
  await sleep(10000)
  p.check('with working checkups on there is no keepalive (3.x runs one mode or the other)', forks('ann').length === annForks, forks('ann').length)

  p.keep(rig, { agents: ['kay', 'ann'] })
  return p.save()
}
