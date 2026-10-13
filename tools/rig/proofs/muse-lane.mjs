// Proof: the Muse lane's paths, on the fake `muse serve` (MSP v1).
//   providers: Muse found as its own binary (never the updater launcher),
//         signed in; the account catalog offers wonder and spark, and a
//         bundled Wonder Full row offers nothing until the account's own
//         catalog lists it (user 2026-10-12: entitlement-aware discovery).
//   effort: staffing offers each tier's own level names; a Muse hire takes
//         `minimal`, a Claude hire refuses it (user 2026-10-12: native names).
//   dana: a normal turn: launch switches (contributor mode off, reminder
//         observers off, workflows off, the identity as developer prompt),
//         the session posture (onRequest, :ask-me), reasoning and text, an
//         orgtree tool through the session MCP bridge, a command approved
//         once; tokens booked with the cost unknown and no cache lifetime;
//         the usage lane takes Muse's own observation. After an engine
//         restart her session is resumed with this seat's posture.
//   erin: mid-turn mail goes into the exact running turn (turn/steer).
//   fern: an interrupt ends the turn cancelled, without an error.
//   hana: a typed quota refusal → a limit freeze until Muse's reset.
//   ivy:  authRequired → parked for a sign-in.
//   kai:  subagents off → a subagent Muse starts is stopped at once.
//   lou:  a turn Orgtree did not start is cancelled; a reminder child that
//         appears anyway is recorded on the turn.
//   rita: a read-only seat: shell and writes closed at the host, the
//         read-only profile, and a write approval denied (a denial booked).
// Run: node tools/rig/rig.mjs run tools/rig/proofs/muse-lane.mjs

import fs from 'node:fs'
import path from 'node:path'
import { Proof } from '../proof.mjs'

const AGENTS = ['dana', 'erin', 'fern', 'hana', 'ivy', 'kai', 'lou']

export default async function (rig) {
  const p = new Proof('muse-lane')
  const resetMs = Date.now() + 2 * 3600 * 1000
  rig.scenario({
    agents: {
      // nina: opted into account fallback; her quota wall moves her to the managed Muse profile
      nina: { turns: [
        { name: 'moved', match: 'You now run on the account', steps: [{ text: 'Continuing on the other account.' }] },
        { name: 'wall', match: 'PROOF-FALLBACK', once: true, steps: [{ text: 'Trying.' }, { quota: { resetsAtMs: resetMs } }] },
      ] },
      kara: { turns: [{ name: 'key', match: 'PROOF-KEY', steps: [{ text: 'On the key account.' }] }] },
      // kian, kofi, kemi: opted in; their wall tries the API-key branch of the fallback
      // (pia, pinned to Spark 1.2, tries a login that offers only Spark 1.3)
      ...Object.fromEntries(['kian', 'kofi', 'kemi', 'pia'].map((n) => [n, { turns: [
        { name: 'moved', match: 'You now run on the account', steps: [{ text: 'Continuing on the key account.' }] },
        { name: 'wall', match: 'PROOF-KEYWALL', once: true, steps: [{ text: 'Trying.' }, { quota: { resetsAtMs: resetMs } }] },
      ] }])),
      dana: { turns: [
        { name: 'again', match: 'PROOF-AGAIN', steps: [{ text: 'Back after the restart.' }] },
        { name: 'hello', match: 'PROOF-HELLO', steps: [
          { thinking: 'Reading the mail first.' },
          { text: 'Hi from dana on the Muse lane.' },
          { tool: 'orgtree_chart', args: {}, expect: 'boss' },
          { tool: 'shell', args: { command: 'echo rig' }, result: 'rig', approval: true },
          { usage: { input: 5000, cached: 4000, output: 120 } },
        ] },
      ] },
      erin: { turns: [
        { name: 'steered', match: 'STEER-1', once: true, steps: [
          { text: 'Working on it.' },
          { poll_mail: { every_ms: 200, timeout_ms: 20000 } },
          { text: 'Thanks, I have the extra note.' },
        ] },
      ] },
      fern: { turns: [
        { name: 'long', match: 'PROOF-INT', once: true, steps: [{ text: 'Starting a long job.' }, { sleep_ms: 60000 }, { text: 'NEVER-SAID' }] },
      ] },
      hana: { turns: [{ name: 'limited', match: 'PROOF-LIMIT', once: true, steps: [{ text: 'Trying.' }, { quota: { resetsAtMs: resetMs } }] }] },
      ivy: { turns: [{ name: 'signin', match: 'PROOF-AUTH', once: true, steps: [{ fail: { kind: 'authRequired', message: 'Sign in again to continue.', retryable: false } }] }] },
      kai: { turns: [{ name: 'child', match: 'PROOF-CHILD', once: true, steps: [
        { subagent: { role: 'helper', objective: 'look around', run_ms: 4000 } }, { text: 'Done without a helper.' }] }] },
      lou: { turns: [{ name: 'cron', match: 'PROOF-CRON', once: true, steps: [
        { text: 'Working.' }, { unsolicited: true }, { reminder: true }, { text: 'Finished.' }] }] },
      rita: { turns: [{ name: 'readonly', match: 'PROOF-RO', once: true, steps: [
        { tool: 'write_file', args: { path: 'C:\\outside\\x.txt', content: 'x' }, approval: true,
          subject: { kind: 'fileAccess', access: 'write', path: 'C:\\outside\\x.txt' }, result: 'written' },
        { text: 'I could not write there.' }] }] },
    },
    default: { turns: [{ name: 'default', steps: [{ text: 'OK.' }] }] },
  })
  await rig.waitFor(() => rig.sql(`SELECT 1 FROM ot.turns WHERE ended_at IS NULL`).length === 0, { what: 'seed turns to settle', timeout: 60000 })

  // ---------------------------------------------------------------- discovery
  const muse = await rig.waitFor(async () => {
    const prov = await rig.api('GET', '/api/providers')
    return (prov?.providers ?? []).find(x => x.id === 'muse' && x.muse?.catalog)
  }, { what: 'Muse discovery', timeout: 60000 })
  p.check('providers: Muse installed and signed in, as its own binary (rig), with a verified MSP schema',
    muse.status?.installed && muse.status.connected && muse.status.email === 'rig@example.invalid'
      && muse.muse.schema?.verified === true && muse.muse.account_state === 'accountLogin', { status: muse.status, schema: muse.muse.schema })
  const offered = (muse.tiers ?? []).map(t => t.tier).sort()
  p.check('providers: the account catalog offers wonder and spark; the bundled Wonder Full row offers nothing',
    JSON.stringify(offered) === JSON.stringify(['spark', 'wonder']), { offered, catalog: muse.muse.catalog })
  const wonderRow = (muse.tiers ?? []).find(t => t.tier === 'wonder')
  p.check('providers: wonder carries its catalog effort names and default', JSON.stringify(wonderRow?.efforts) === JSON.stringify(['minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
    && wonderRow?.default_effort === 'high', wonderRow)
  const full = await rig.op({ op: 'hire', name: 'fiona', parent: 'boss', tier: 'wonder-full', title: 'Muse rig agent' })
    .then(r => ({ ok: true, r }), e => ({ ok: false, status: e.status, detail: e.body?.detail ?? e.message }))
  p.check('hire: wonder-full is refused while the account does not offer it', !full.ok && full.status === 409 && /does not offer wonder-full/.test(full.detail), full)

  // ---------------------------------------------------------------- effort names
  const opts = await rig.api('GET', `/api/orgs/${rig.org}/staffing-options`)
  const efforts = tier => (opts?.tiers ?? []).find(t => t.tier === tier)?.efforts
  p.check('staffing: each tier offers its own harness names (wonder: Muse\'s six; opus: Claude Code\'s five)',
    JSON.stringify(efforts('wonder')) === JSON.stringify(['minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
      && JSON.stringify(efforts('opus')) === JSON.stringify(['low', 'medium', 'high', 'xhigh', 'max']), { wonder: efforts('wonder'), opus: efforts('opus') })
  const badOpus = await rig.op({ op: 'hire', name: 'otto', parent: 'boss', tier: 'opus', title: 'effort check', effort: 'minimal' })
    .then(r => ({ ok: true, r }), e => ({ ok: false, status: e.status, detail: e.body?.detail ?? e.message }))
  p.check('effort: a Claude hire refuses a level Claude Code does not name', !badOpus.ok && badOpus.status === 400 && /minimal is not one of them/.test(badOpus.detail), badOpus)

  // ---------------------------------------------------------------- hires
  for (const name of AGENTS) {
    const extra = name === 'dana' ? { effort: 'minimal' } : name === 'kai' ? { tools: { subagents: false } } : {}
    await rig.op({ op: 'hire', name, parent: 'boss', tier: 'wonder', title: 'Muse rig agent', ...extra })
  }
  await rig.op({ op: 'hire', name: 'rita', parent: 'boss', tier: 'spark', title: 'Muse read-only agent', tools: { edit: false } })
  const ids = Object.fromEntries([...AGENTS, 'rita'].map(a => [a, rig.agentRow(a)?.id]))
  p.check('seven wonder agents and one read-only spark agent hired on the Muse lane', Object.values(ids).every(Boolean), ids)
  const log = (agent, kind) => rig.fakeLog(agent).filter(l => !kind || l.kind === kind)
  const convo = agent => rig.sql(`SELECT body FROM ot.convo WHERE agent_id = ${ids[agent]} ORDER BY seq`).map(r => r.body)
  const mailRow = text => rig.one(`SELECT id, state, turn_id FROM ot.mail WHERE body LIKE '${text.replace(/'/g, "''")}%' ORDER BY id DESC LIMIT 1`)

  // ---------------------------------------------------------------- dana: a normal turn
  await rig.userMail('dana', 'PROOF-HELLO: please say hi.')
  const [t1] = await rig.waitTurns('dana', 1)
  const start = log('dana', 'start')[0]
  p.check('dana: the host starts with contributor mode off, observers and workflows off, the identity as developer prompt',
    start?.contributor_off && ['run.developer_prompt', 'runtime_capabilities', 'run.workflow_trigger_mode'].every(k => start.config_keys?.includes(k))
      // the identity itself, or (past the command-line budget) the pointer to its file
      && (start.developer_prompt_names_agent === true || start.developer_prompt_by_file === true)
      && start.no_auto_update === '1' && start.args?.includes('--trust-workspace'),
    start && { args: start.args, keys: start.config_keys, named: start.developer_prompt_names_agent, by_file: start.developer_prompt_by_file })
  p.check('dana: no other provider\'s credential and no Muse API key reach the host',
    start && !start.meta_api_key_set && !start.anthropic_key_set && !start.openai_key_set, start)
  const init = log('dana', 'initialize')[0]
  p.check('dana: the host was asked for session MCP servers', init?.requested?.includes('sessionMcp'), init)
  const sess = log('dana', 'session').find(l => l.action === 'start')
  p.check('dana: a write seat runs onRequest with the :ask-me profile on wonder, its Orgtree tools a session MCP server',
    sess?.approval === 'onRequest' && sess.profile === ':ask-me' && sess.model === 'muse-wonder-1.0' && sess.servers?.includes('orgtree'), sess)
  const ts = log('dana', 'turn_start')[0]
  p.check('dana: the turn is sent her own level, minimal (a Muse name)', ts?.effort === 'minimal' && ts.if_busy === 'queue', ts)
  const row1 = rig.one(`SELECT * FROM ot.turns WHERE id = ${t1.id}`)
  p.check('dana: the turn completed without error', !row1.error && !row1.killed, row1.error)
  p.check('dana: tokens are the turn\'s requests, the cached part apart; the cost is unknown and the cache lifetime too',
    // three model requests: two before the tools (1200 in, 900 cached), the last 5000 in, 4000 cached
    row1.input_tokens === 1600 && row1.cache_read === 5800 && row1.cost_source === 'unknown' && row1.cache_ttl_s === null && row1.model === 'muse-wonder-1.0',
    { input: row1.input_tokens, cached: row1.cache_read, out: row1.toks, source: row1.cost_source, ttl: row1.cache_ttl_s, model: row1.model })
  p.check('dana: her record says the cost is unknown', rig.one(`SELECT cost_unknown FROM ot.agents WHERE id = ${ids.dana}`)?.cost_unknown === true)
  const rows = convo('dana')
  p.check('dana: the reasoning is in the conversation', rows.some(b => /Reading the mail first/.test(b.thinking ?? '')))
  const chips = rows.flatMap(b => b.tools ?? [])
  const chart = chips.find(t => t.name === 'mcp__orgtree__orgtree_chart')
  p.check('dana: the orgtree tool ran through the session MCP bridge and its answer is on the chip', !!chart && /boss/.test(chart.result ?? ''), chips.map(c => c.name))
  const tr = log('dana', 'tool_result').find(l => /orgtree_chart/.test(l.tool))
  p.check('dana: the host got the engine\'s answer over MCP', tr?.ok === true && !tr.is_error, tr && { ok: tr.ok, text: String(tr.text).slice(0, 80) })
  const approval = log('dana', 'approval')[0]
  p.check('dana: the command approval was answered once (never for the session)', approval?.choice === 'allow-once' && row1.denials === 0, approval)
  const usage = await rig.api('GET', '/api/muse/usage')
  p.check('usage: the lane holds Muse\'s own dated observation (5 h window and weekly)', usage?.available === true
    && usage.limits?.some(l => l.kind === 'session' && l.label === '5 h') && usage.limits?.some(l => l.kind === 'weekly_all')
    && !!usage.observed_at, usage)
  const hist = rig.sql(`SELECT account, win FROM ot.usage_history WHERE provider = 'muse' ORDER BY observed_at DESC LIMIT 4`)
  p.check('usage: the observation is in the usage history under muse/primary', hist.some(h => h.account === 'muse/primary'), hist)
  const session = log('dana', 'session').find(l => l.action === 'start')?.session

  // ---------------------------------------------------------------- erin: steer
  await rig.userMail('erin', 'STEER-1: start the job.')
  await rig.waitFor(() => log('erin', 'step').some(l => l.step?.poll_mail), { what: 'erin to wait for mail mid-turn' })
  await rig.userMail('erin', 'STEER-2: an extra note for the running job.')
  const et = await rig.waitTurns('erin', 1)
  const polled = log('erin', 'poll_mail')[0]
  p.check('erin: the mid-turn mail reached the exact running turn (turn/steer with expectedTurnId)', polled?.delivered && polled.texts.some(t => /STEER-2/.test(t)),
    polled && { delivered: polled.delivered })
  await new Promise(r => setTimeout(r, 1500))
  const st = mailRow('STEER-2')
  p.check('erin: one turn for both mails; the steered mail is delivered in it', rig.turns('erin').length === 1 && st?.state === 'delivered' && st.turn_id === et[0].id,
    { turns: rig.turns('erin').length, mail: st })

  // ---------------------------------------------------------------- fern: interrupt
  await rig.userMail('fern', 'PROOF-INT: start the long job.')
  await rig.waitFor(() => log('fern', 'step').some(l => l.step?.sleep_ms), { what: 'fern to be mid-turn' })
  const it = await rig.tool('boss', 'orgtree_interrupt', { node: 'fern' })
  const ft = await rig.waitTurns('fern', 1, { timeout: 20000 })
  const fEnd = log('fern', 'turn_end')[0]
  p.check('fern: turn/interrupt ended the turn cancelled; no error, not frozen', it.ok !== false && log('fern', 'interrupt').length >= 1 && fEnd?.terminal === 'cancelled'
    && !ft[0].error && !rig.agentRow('fern').frozen, { end: fEnd?.terminal, error: ft[0].error })
  p.check('fern: nothing after the interrupt was said', !convo('fern').some(b => /NEVER-SAID/.test(b.text ?? '')))

  // ---------------------------------------------------------------- hana: typed quota
  await rig.userMail('hana', 'PROOF-LIMIT: please do the thing.')
  const hf = await rig.waitFor(() => rig.agentRow('hana')?.frozen, { what: 'hana to be frozen' })
  p.check('hana: a typed quota refusal → a limit freeze until Muse\'s own reset', hf.limit === true && Math.abs(Date.parse(hf.until) - resetMs) <= 5000,
    { until: hf.until, reset: new Date(resetMs).toISOString() })
  p.check('hana: the refused request is kept for the wake', Array.isArray(hf.resume_texts) && /PROOF-LIMIT/.test(hf.resume_texts[0] ?? ''), hf.resume_texts)

  // ---------------------------------------------------------------- ivy: sign-in
  await rig.userMail('ivy', 'PROOF-AUTH: please do the thing.')
  const iv = await rig.waitFor(() => rig.agentRow('ivy')?.frozen, { what: 'ivy to be parked' })
  p.check('ivy: authRequired parks the agent for a Muse sign-in', iv.cause === 'auth' && iv.parked === true && /Muse/.test(iv.label ?? ''), iv)

  // ---------------------------------------------------------------- kai: subagent off
  await rig.userMail('kai', 'PROOF-CHILD: go.')
  await rig.waitTurns('kai', 1, { timeout: 30000 })
  const stopped = log('kai', 'subagent_stop')[0]
  p.check('kai: a subagent the scope does not allow is stopped (subagent/stop)', !!stopped && log('kai', 'subagent')[0]?.stopped === true, stopped)

  // ---------------------------------------------------------------- lou: unsolicited turn, reminder child
  await rig.userMail('lou', 'PROOF-CRON: go.')
  await rig.waitTurns('lou', 1, { timeout: 30000 })
  const un = log('lou', 'unsolicited')[0]
  p.check('lou: a turn Orgtree did not start is cancelled (turn/cancel)', un?.cancelled === true && log('lou', 'cancel').length >= 1, un)
  p.check('lou: a reminder child that appears is recorded on the turn', convo('lou').flatMap(b => b.tools ?? []).some(t => t.name === 'reminder'))

  // ---------------------------------------------------------------- rita: read-only seat
  await rig.userMail('rita', 'PROOF-RO: write there.')
  const [rt] = await rig.waitTurns('rita', 1, { timeout: 30000 })
  const rstart = log('rita', 'start')[0]
  const rsess = log('rita', 'session').find(l => l.action === 'start')
  p.check('rita: shell and writes closed at the host, the read-only profile, denyUnmatched',
    rstart?.args?.includes('--disable-shell') && rstart.args.includes('--disable-write') && rsess?.profile === ':read-only' && rsess.approval === 'denyUnmatched',
    { args: rstart?.args, sess: rsess })
  const rap = log('rita', 'approval')[0]
  p.check('rita: a write outside her folders is denied once and booked as a denial', rap?.choice === 'deny-once'
    && rig.one(`SELECT denials FROM ot.turns WHERE id = ${rt.id}`)?.denials === 1, rap)

  // ---------------------------------------------------------------- Full once the account offers it
  // (the catalog answers 3 s late from here on: after the restart below, dana's
  // turn arrives while discovery is still reading it, and must wait for it)
  fs.writeFileSync(path.join(rig.fakeDir, 'muse-catalog.json'), JSON.stringify({ source: 'providerCatalog', delayMs: 3000, models: [
    { modelId: 'muse-wonder-1.0', profileId: 'tbh', isDefault: true, variants: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'], defaultReasoningEffort: 'high', contextLimit: 1007997, outputLimit: 128000 },
    { modelId: 'muse-wonder-full-1.0', profileId: 'tbh', isDefault: false, variants: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'], defaultReasoningEffort: 'high', contextLimit: 1007997, outputLimit: 128000 },
  ] }))
  await rig.api('GET', '/api/muse/usage?force=true')
  const prov2 = await rig.api('GET', '/api/providers')
  const tiers2 = ((prov2?.providers ?? []).find(x => x.id === 'muse')?.tiers ?? []).map(t => t.tier).sort()
  p.check('Full: offered once the account\'s own catalog lists it (a forced re-read); spark drops out with its row',
    JSON.stringify(tiers2) === JSON.stringify(['wonder', 'wonder-full']), tiers2)
  const fullHire = await rig.op({ op: 'hire', name: 'fiona', parent: 'boss', tier: 'wonder-full', title: 'Muse Full agent' })
    .then(r => ({ ok: true, r }), e => ({ ok: false, detail: e.body?.detail ?? e.message }))
  p.check('Full: a wonder-full hire is now accepted', fullHire.ok && rig.agentRow('fiona')?.state === 'live', fullHire)

  // ---------------------------------------------------------------- dana: resume after a restart, then /compact
  await rig.restart()
  await rig.userMail('dana', 'PROOF-AGAIN: still there?')
  const again = await rig.waitTurns('dana', 2, { timeout: 60000 }).catch(e => ({ error: e.message }))
  p.check('dana: a turn that arrives while discovery is still reading the catalog waits for it (never "not offered")',
    Array.isArray(again) && !/catalog/.test(rig.agentRow('dana')?.last_error ?? ''), { wait: again?.error, last_error: rig.agentRow('dana')?.last_error })
  const resumed = log('dana', 'session').filter(l => l.action === 'resume')
  const posture = log('dana', 'posture').map(l => l.set)
  p.check('dana: after a restart the same session is resumed and takes this seat\'s posture again',
    resumed.some(l => l.session === session) && ['model', 'session/setApprovalMode', 'session/setPermissionProfile'].every(s => posture.includes(s)),
    { session, resumed: resumed.map(l => l.session), posture })
  const restartStart = log('dana', 'start').at(-1)
  p.check('dana: contributor mode is off on the resumed host too', restartStart?.contributor_off === true, restartStart?.args)
  const cmd = await rig.api('POST', `/api/orgs/${rig.org}/nodes/dana/compact`).catch(e => ({ error: e.message }))
  const compacted = await rig.waitFor(() => convo('dana').some(b => b.kind === 'compact'), { what: 'dana\'s compaction row', timeout: 20000 }).catch(() => false)
  p.check('dana: /compact runs Muse\'s own session/compact and the conversation says so', !!compacted && log('dana', 'compact').length >= 1, cmd)

  // ---------------------------------------------------------------- accounts: fallback, key isolation, primary
  // (fixtures only: the fake answers every login; the key is not a real one)
  fs.writeFileSync(path.join(rig.fakeDir, 'muse-catalog.json'), JSON.stringify({ source: 'providerCatalog', models: [
    { modelId: 'muse-wonder-1.0', profileId: 'tbh', isDefault: true, variants: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'], defaultReasoningEffort: 'high', contextLimit: 1007997, outputLimit: 128000 },
  ] }))
  const M = (await rig.api('POST', '/api/accounts', { provider: 'muse', kind: 'managed' })).id
  const mid = await rig.api('GET', `/api/accounts/${M}/identity`)
  const profile = rig.one(`SELECT config_dir FROM ot.accounts WHERE id = '${M}'`)?.config_dir ?? ''
  await rig.op({ op: 'hire', name: 'nina', parent: 'boss', tier: 'wonder', title: 'fallback agent', account_fallback: true })
  await rig.userMail('nina', 'PROOF-FALLBACK: please do the thing.')
  const moved = await rig.waitTurns('nina', 2, { timeout: 60000 }).catch(e => ({ error: e.message }))
  const nina = rig.agentRow('nina')
  const ninaStart = log('nina', 'start').at(-1)
  p.check('fallback: a managed Muse profile signs in through its own metadata read', mid?.auth === 'authenticated', mid)
  p.check('fallback: an opted-in agent at its Muse limit moves to the profile with room and continues there',
    Array.isArray(moved) && !nina?.frozen && rig.one(`SELECT account FROM ot.agents WHERE id = ${nina?.id}`)?.account === M,
    { wait: moved?.error, frozen: nina?.frozen, account: rig.one(`SELECT account FROM ot.agents WHERE id = ${nina?.id}`)?.account })
  p.check('fallback: the moved host runs in the profile\'s own roots, never with an API key',
    !!profile && (ninaStart?.xdg_config ?? '').toLowerCase().startsWith(profile.toLowerCase()) && ninaStart?.meta_api_key_set === false
      && ninaStart?.contributor_off === true, { profile, start: { xdg_config: ninaStart?.xdg_config, key: ninaStart?.meta_api_key_set } })
  const K = (await rig.api('POST', '/api/accounts', { provider: 'muse', kind: 'apikey', key: 'muse-rig-not-a-real-key' })).id
  await rig.op({ op: 'hire', name: 'kara', parent: 'boss', tier: 'wonder', title: 'key agent', account: K })
  await rig.userMail('kara', 'PROOF-KEY: hello.')
  await rig.waitTurns('kara', 1, { timeout: 60000 }).catch(() => null)
  const karaStart = log('kara', 'start').at(-1)
  p.check('key: an API-key seat runs with its key in its own roots, never the user\'s own Muse roots',
    karaStart?.meta_api_key_set === true && /muse-key-/i.test(karaStart?.xdg_config ?? '') && /muse-key-/i.test(karaStart?.xdg_data ?? ''),
    { xdg_config: karaStart?.xdg_config, xdg_data: karaStart?.xdg_data, key: karaStart?.meta_api_key_set })
  const back = await rig.tool('boss', 'orgtree_continue_on', { node: 'nina', account: 'muse/primary' })
  p.check('continue on: Muse\'s own login is a native primary to continue on (muse/primary)',
    back.ok && rig.one(`SELECT account FROM ot.agents WHERE id = ${nina?.id}`)?.account == null, back.text?.slice(0, 200))

  // the API-key branch: each login answers its own catalog file (the fake reads
  // <XDG_CONFIG_HOME>/muse-catalog.json first), so the profile M stops offering
  // Wonder and the key K offers it or not; three opted-in agents hit the wall
  const ROW = { profileId: 'tbh', variants: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'], defaultReasoningEffort: 'high',
    contextLimit: 1007997, outputLimit: 128000 }
  const only = (modelId) => JSON.stringify({ source: 'providerCatalog', models: [{ modelId, isDefault: true, ...ROW }] })
  const own = (start, catalog) => fs.writeFileSync(path.join(start.xdg_config, 'muse-catalog.json'), catalog)
  /** hire `name` opted into fallback (on `tier`, pinned to `version`), give it the wall; resolves once the fallback has moved it or left it frozen */
  const wall = async (name, { tier = 'wonder', version } = {}) => {
    await rig.op({ op: 'hire', name, parent: 'boss', tier, title: 'key fallback agent', account_fallback: true })
    if (version) await rig.api('POST', `/api/orgs/${rig.org}/nodes/${name}/scope`, { model_version: version })
    await rig.userMail(name, 'PROOF-KEYWALL: please do the thing.')
    const id = await rig.waitFor(() => rig.agentRow(name)?.id, { what: `${name} hired`, timeout: 20000 })
    const stays = new RegExp(`it stays frozen[^\\n]*agent=${id}\\b|agent=${id}\\b[^\\n]*it stays frozen`)
    await rig.waitFor(() => rig.one(`SELECT account FROM ot.agents WHERE id = ${id}`)?.account || stays.test(rig.engineLog()),
      { what: `${name}'s fallback decision`, timeout: 45000 }).catch(() => null)
    return { id, row: rig.agentRow(name), account: rig.one(`SELECT account FROM ot.agents WHERE id = ${id}`)?.account ?? null }
  }
  if (ninaStart?.xdg_config && karaStart?.xdg_config) {
    own(ninaStart, only('muse-spark-1.3'))
    own(karaStart, only('muse-wonder-1.0'))
    const off = await wall('kian')
    p.check('key: while the Muse API-key switch is off, a key that offers the model is still never a fallback',
      off.row?.frozen && off.account == null, off)
    await rig.api('PUT', '/api/providers/muse/apikey-fallback', { enabled: true })
    own(karaStart, only('muse-spark-1.3'))
    const lacks = await wall('kofi')
    p.check('key: with the switch on, a key whose own catalog lacks the model is not a fallback (its entitlement is asked, never assumed)',
      lacks.row?.frozen && lacks.account == null
        && rig.engineLog().split(/\r?\n/).some((l) => l.includes('this Muse API key does not offer') && l.includes(K)), lacks)
    own(karaStart, only('muse-wonder-1.0'))
    const takes = await wall('kemi')
    await rig.waitTurns('kemi', 2, { timeout: 45000 }).catch(() => null)
    const kemiStart = log('kemi', 'start').at(-1)
    p.check('key: with the switch on, a key that offers the model takes the agent, in its own roots with its key',
      takes.account === K && kemiStart?.meta_api_key_set === true && /muse-key-/i.test(kemiStart?.xdg_config ?? ''),
      { account: takes.account, frozen: rig.agentRow('kemi')?.frozen, start: { xdg_config: kemiStart?.xdg_config, key: kemiStart?.meta_api_key_set } })
    // a pinned version: the user's own login offers Spark 1.3 and 1.2; a fresh profile P, whose only
    // reading is its own account-wide metadata read (room for any tier it offers), offers only 1.3
    fs.writeFileSync(path.join(rig.fakeDir, 'muse-catalog.json'), JSON.stringify({ source: 'providerCatalog', models: [
      { modelId: 'muse-wonder-1.0', isDefault: true, ...ROW }, { modelId: 'muse-spark-1.3', isDefault: false, ...ROW },
      { modelId: 'muse-spark-1.2', isDefault: false, ...ROW }] }))
    await rig.api('GET', '/api/muse/usage?force=true')
    const P = (await rig.api('POST', '/api/accounts', { provider: 'muse', kind: 'managed' })).id
    const pDir = rig.one(`SELECT config_dir FROM ot.accounts WHERE id = '${P}'`)?.config_dir ?? ''
    fs.mkdirSync(path.join(pDir, 'config'), { recursive: true })
    fs.writeFileSync(path.join(pDir, 'config', 'muse-catalog.json'), only('muse-spark-1.3'))
    await rig.api('GET', `/api/accounts/${P}/identity`)
    const pinned = await wall('pia', { tier: 'spark', version: '1.2' })
    const piaModel = log('pia', 'session').find((e) => e.action === 'start')?.model
    p.check('pin: a seat pinned to Spark 1.2 is not moved to a login that offers only Spark 1.3; it stays frozen on its own',
      piaModel === 'muse-spark-1.2' && pinned.row?.frozen && pinned.account == null,
      { model: piaModel, profile: P, account: pinned.account, frozen: pinned.row?.frozen, last_error: pinned.row?.last_error })
  } else {
    p.check('key: the API-key fallback fixtures could run (both logins started)', false, { ninaStart, karaStart })
  }
  return p.summary()
}
