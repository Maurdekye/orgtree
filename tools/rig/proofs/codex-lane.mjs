// Proof: the openai lane's turn paths, on the fake `codex app-server`.
//   providers: the Codex login in the rig's fake home reads as connected.
//   dana: a normal turn: reasoning, a message, an orgtree_* dynamic tool the
//         engine answers, a command behind an approval, a transient error the
//         server retries itself; the turn's tokens are booked as a difference
//         of the thread's totals. After an engine restart her next turn
//         resumes the same thread and books only that turn's tokens.
//   erin: mail that arrives mid-turn goes in with turn/steer: no second turn.
//   fern: an interrupt stops the turn; the next mail runs a normal turn.
//   gus:  the app-server dies mid-turn → connection freeze → the retry turn
//         resumes the same thread.
//   hana: usageLimitExceeded → a limit freeze until the reset the turn's own
//         rate-limit notification named; her superior is told.
//   ivy:  unauthorized → the turn fails with the provider's words, the
//         superior is told, no park (3.x read a 401 only from Claude's result).
//   jay:  the Windows sandbox runner failing before the shell starts → the
//         engine steers its hint into the running turn.
// Run: node tools/rig/rig.mjs run tools/rig/proofs/codex-lane.mjs

import { Proof } from '../proof.mjs'

const AGENTS = ['dana', 'erin', 'fern', 'gus', 'hana', 'ivy', 'jay']
const RUNNER = 'Failed to create unified exec process: timed out after 15000ms connecting runner pipe-in'

export default async function (rig) {
  const p = new Proof('codex-lane')
  const resetAt = Math.floor(Date.now() / 1000) + 7200
  rig.scenario({
    agents: {
      dana: { turns: [
        { name: 'again', match: 'PROOF-AGAIN', steps: [{ text: 'Back after the restart.' }] },
        { name: 'hello', match: 'PROOF-HELLO', steps: [
          { thinking: 'Reading the mail first.' },
          { error: { message: 'Reconnecting... 1/5', codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: null } } }, will_retry: true },
          { text: 'Hi from dana on the Codex lane.' },
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
      gus: { turns: [
        { name: 'retry', match: 'being retried', steps: [{ text: 'Recovered, continuing.' }] },
        { name: 'die', match: 'PROOF-EXIT', once: true, steps: [{ text: 'Starting.' }, { exit: 1 }] },
      ] },
      hana: { turns: [
        { name: 'limited', match: 'PROOF-LIMIT', once: true, steps: [
          { rate_limit: { primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: resetAt },
                          secondary: { usedPercent: 40, windowDurationMins: 10080, resetsAt: resetAt + 86400 } } },
          { error: { message: "You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro) or try again later.",
                     codexErrorInfo: 'usageLimitExceeded' } },
        ] },
      ] },
      ivy: { turns: [
        { name: 'refused', match: 'PROOF-401', once: true, steps: [
          { error: { message: 'unexpected status 401 Unauthorized: Missing bearer or basic authentication in header',
                     codexErrorInfo: 'unauthorized' } },
        ] },
      ] },
      jay: { turns: [
        { name: 'runner', match: 'PROOF-RUNNER', once: true, steps: [
          { raw: { jsonrpc: '2.0', method: 'item/completed', params: { item: {
            type: 'commandExecution', id: 'cmd_runner', command: 'dir', cwd: '.', status: 'failed', source: 'unifiedExecStartup',
            processId: null, durationMs: 0, exitCode: null, aggregatedOutput: RUNNER } } } },
          { poll_mail: { every_ms: 200, timeout_ms: 20000 } },
          { text: 'Retrying once as told.' },
        ] },
      ] },
    },
    default: { turns: [{ name: 'default', steps: [{ text: 'OK.' }] }] },
  })
  await rig.waitFor(() => rig.sql(`SELECT 1 FROM ot.turns WHERE ended_at IS NULL`).length === 0, { what: 'seed turns to settle', timeout: 60000 })

  // ---------------------------------------------------------------- the lane
  const prov = await rig.api('GET', '/api/providers')
  const codex = (prov?.providers ?? prov ?? []).find?.(x => x.id === 'openai')
  p.check('providers: Codex installed and signed in from the fake home', codex?.status?.installed && codex.status.connected
    && codex.status.email === 'rig@example.invalid' && codex.hire_enabled, codex?.status)
  for (const name of AGENTS) await rig.op({ op: 'hire', name, parent: 'boss', tier: 'luna', title: 'Codex rig agent' })
  const ids = Object.fromEntries(AGENTS.map(a => [a, rig.agentRow(a)?.id]))
  p.check('seven luna agents hired on the openai lane', AGENTS.every(a => ids[a]), ids)
  const log = (agent, kind) => rig.fakeLog(agent).filter(l => !kind || l.kind === kind)
  const mailRow = text => rig.one(`SELECT id, state, turn_id FROM ot.mail WHERE body LIKE '${text.replace(/'/g, "''")}%' ORDER BY id DESC LIMIT 1`)
  const toBoss = (who, like) => rig.sql(`SELECT body, ev->>'variant' AS variant FROM ot.mail WHERE recipient_agent_id = ${rig.agentRow('boss').id}
    AND sender = '@system' AND body LIKE '${who}%${like}%' ORDER BY id`)
  const convo = agent => rig.sql(`SELECT body FROM ot.convo WHERE agent_id = ${ids[agent]} ORDER BY seq`).map(r => r.body)

  // gus first: his retry waits ~30 s while the rest runs
  await rig.userMail('gus', 'PROOF-EXIT: please start the work.')

  // ---------------------------------------------------------------- dana: a normal turn
  await rig.userMail('dana', 'PROOF-HELLO: please say hi.')
  const [t1] = await rig.waitTurns('dana', 1)
  const row1 = rig.one(`SELECT * FROM ot.turns WHERE id = ${t1.id}`)
  p.check('dana: the turn completed without error (a willRetry error is not a failure)', !row1.error && !row1.killed, row1.error)
  p.check('dana: tokens are the thread total minus the cached part (5000 in, 4000 cached, 120 out)',
    row1.input_tokens === 1000 && row1.cache_read === 4000 && row1.toks === 120, { input: row1.input_tokens, cached: row1.cache_read, out: row1.toks })
  p.check('dana: priced as gpt-6-luna', row1.model === 'gpt-6-luna' && Number(row1.cost_usd) > 0 && row1.cost_source === 'priced',
    { model: row1.model, cost: row1.cost_usd, source: row1.cost_source })
  p.check('dana: occupancy is the last call\'s input', rig.one(`SELECT occupancy FROM ot.agents WHERE id = ${ids.dana}`)?.occupancy === 5000)
  const rows = convo('dana')
  p.check('dana: the reasoning is in the conversation', rows.some(b => /Reading the mail first/.test(b.thinking ?? '')))
  const said = rows.find(b => b.role === 'assistant' && /Hi from dana/.test(b.text ?? ''))
  const chart = said?.tools?.find(t => t.name === 'orgtree_chart')
  p.check('dana: her message carries the dynamic tool call and its answer', !!chart && /boss/.test(chart.result ?? ''), said?.tools)
  const tr = log('dana', 'tool_result').find(l => l.tool === 'orgtree_chart')
  p.check('dana: the app-server got the engine\'s answer to item/tool/call', tr?.ok === true && !tr.is_error, tr && { ok: tr.ok, text: String(tr.text).slice(0, 80) })
  const approval = log('dana', 'approval')[0]
  p.check('dana: the command approval was answered, and a decline is booked as a denial',
    !!approval && ['accept', 'decline'].includes(approval.decision) && (approval.decision === 'accept') === (row1.denials === 0),
    { decision: approval?.decision, denials: row1.denials })
  const thread = log('dana', 'thread').find(l => l.action === 'start')?.thread

  // ---------------------------------------------------------------- erin: steer
  await rig.userMail('erin', 'STEER-1: start the job.')
  await rig.waitFor(() => log('erin', 'step').some(l => l.step?.poll_mail), { what: 'erin to wait for mail mid-turn' })
  await rig.userMail('erin', 'STEER-2: an extra note for the running job.')
  const et = await rig.waitTurns('erin', 1)
  const polled = log('erin', 'poll_mail')[0]
  p.check('erin: the mid-turn mail reached the running turn (turn/steer)', polled?.delivered && polled.texts.some(t => /STEER-2/.test(t)),
    polled && { delivered: polled.delivered, text: String(polled.texts?.[0] ?? '').slice(0, 120) })
  await new Promise(r => setTimeout(r, 1500))
  const st = mailRow('STEER-2')
  p.check('erin: one turn for both mails; the steered mail is delivered in it', rig.turns('erin').length === 1
    && st?.state === 'delivered' && st.turn_id === et[0].id, { turns: rig.turns('erin').length, mail: st })
  p.check('erin: the conversation shows the mail delivered into the running turn',
    convo('erin').some(b => /STEER-2/.test(JSON.stringify(b)) && /running turn/.test(JSON.stringify(b))))

  // ---------------------------------------------------------------- fern: interrupt
  await rig.userMail('fern', 'PROOF-INT: start the long job.')
  await rig.waitFor(() => log('fern', 'step').some(l => l.step?.sleep_ms), { what: 'fern to be mid-turn' })
  const ti = Date.now()
  const it = await rig.tool('boss', 'orgtree_interrupt', { node: 'fern' })
  const ft = await rig.waitTurns('fern', 1, { timeout: 20000 })
  const fEnd = log('fern', 'turn_end')[0]
  p.check('fern: orgtree_interrupt sent turn/interrupt; the turn ended as interrupted', it.ok && log('fern', 'interrupt').length >= 1
    && fEnd?.status === 'interrupted', { tool: it.ok, end: fEnd?.status })
  p.check('fern: ended within 5 s, no error, not frozen', Date.parse(ft[0].ended_at) - ti < 5000 && !ft[0].error && !rig.agentRow('fern').frozen,
    { ms: Date.parse(ft[0].ended_at) - ti, error: ft[0].error })
  p.check('fern: nothing after the interrupt was said', !convo('fern').some(b => /NEVER-SAID/.test(b.text ?? '')))
  await rig.userMail('fern', 'Next one, please.')
  const ft2 = await rig.waitTurns('fern', 2)
  p.check('fern: the next mail runs a normal turn on the same thread', !ft2[1].error
    && new Set(log('fern', 'thread').map(l => l.thread)).size === 1, { error: ft2[1].error, threads: log('fern', 'thread').map(l => l.action) })

  // ---------------------------------------------------------------- hana: usage limit
  await rig.userMail('hana', 'PROOF-LIMIT: please do the thing.')
  const hf = await rig.waitFor(() => rig.agentRow('hana')?.frozen, { what: 'hana to be frozen' })
  p.check('hana: usageLimitExceeded → a limit freeze', hf.limit === true && !hf.connection, hf)
  p.check('hana: held until the reset her turn\'s rate-limit notification named', Math.abs(Date.parse(hf.until) / 1000 - resetAt) <= 5,
    { until: hf.until, resetsAt: new Date(resetAt * 1000).toISOString() })
  const told = await rig.waitFor(() => toBoss('hana', 'usage limit')[0], { what: 'boss to be told about hana', timeout: 15000 }).catch(() => null)
  p.check('hana: her superior is told she is held', !!told, told)
  const unstick = await rig.tool('boss', 'orgtree_unstick', { node: 'hana' })
  const resumed = await rig.waitFor(() => log('hana', 'turn').length >= 2 ? log('hana', 'turn')[1] : null,
    { what: 'hana to resume', timeout: 30000 }).catch(() => null)
  p.note('hana after orgtree_unstick: does the resumed turn carry the original request? (3.x replayed the failed turn\'s text)',
    { unstick: unstick.ok ? 'ok' : unstick.text, resumed: !!resumed, carries: resumed ? /PROOF-LIMIT/.test(resumed.prompt) : null,
      prompt: resumed ? String(resumed.prompt).slice(-400) : null })

  // ---------------------------------------------------------------- ivy: unauthorized
  await rig.userMail('ivy', 'PROOF-401: please do the thing.')
  const it1 = await rig.waitTurns('ivy', 1)
  p.check('ivy: the turn failed with the provider\'s words', /401 Unauthorized/.test(it1[0].error ?? ''), it1[0].error)
  const iv = rig.agentRow('ivy')
  p.check('ivy: not parked (as 3.x: its auth park read a 401 off a Claude result only)', !iv.frozen, iv.frozen)
  const stalled = await rig.waitFor(() => toBoss('ivy', 'error')[0], { what: 'boss to be told about ivy', timeout: 15000 }).catch(() => null)
  p.check('ivy: her superior is told the turn ended with an error', stalled?.variant === 'runtime.report_stalled' || /ended with an error/.test(stalled?.body ?? ''), stalled)

  // ---------------------------------------------------------------- jay: the runner hint
  await rig.userMail('jay', 'PROOF-RUNNER: run dir.')
  await rig.waitTurns('jay', 1)
  const hint = log('jay', 'poll_mail')[0]
  p.check('jay: a runner startup failure → the engine steers its hint into the turn', hint?.delivered
    && hint.texts.some(t => /sandbox runner failed before the shell process started/.test(t)), hint && String(hint.texts?.[0] ?? '').slice(0, 120))

  // ---------------------------------------------------------------- gus: died mid-turn, retried
  const gt = await rig.waitFor(() => { const t = rig.turns('gus'); return t.length >= 2 && t.every(x => x.ended_at) ? t : null },
    { what: 'gus\'s retry to finish', timeout: 120000, every: 1000 })
  p.check('gus: the dead turn is recorded with its exit', /exited|died/i.test(gt[0].error ?? ''), gt[0].error)
  p.check('gus: the retry completed without error and the freeze cleared', !gt[1].error && !rig.agentRow('gus').frozen, gt[1].error)
  const retryAfter = (Date.parse(gt[1].started_at) - Date.parse(gt[0].ended_at)) / 1000
  p.check('gus: retried by the freeze timer after ~30 s', retryAfter >= 25 && retryAfter <= 50, { retryAfterS: retryAfter })
  const gThreads = log('gus', 'thread')
  p.check('gus: a new app-server resumed the same thread for the retry', log('gus', 'start').length >= 2
    && gThreads.length >= 2 && gThreads[1].action === 'resume' && gThreads[1].thread === gThreads[0].thread, gThreads.map(l => [l.action, l.thread]))
  p.check('gus: the retry prompt carries the retry banner', /being retried/.test(log('gus', 'turn').find(l => l.script === 'retry')?.prompt ?? ''))

  // ---------------------------------------------------------------- dana: after an engine restart
  await rig.restart()
  await rig.userMail('dana', 'PROOF-AGAIN: still there?')
  const dt = await rig.waitTurns('dana', 2)
  const row2 = rig.one(`SELECT * FROM ot.turns WHERE id = ${dt[1].id}`)
  const dThreads = log('dana', 'thread')
  p.check('dana: after a restart the new app-server resumed her thread', dThreads.at(-1)?.action === 'resume' && dThreads.at(-1).thread === thread,
    dThreads.map(l => [l.action, l.thread]))
  p.check('dana: the resumed turn books only its own tokens (300 in, 900 cached)', !row2.error && row2.input_tokens === 300 && row2.cache_read === 900,
    { input: row2.input_tokens, cached: row2.cache_read, error: row2.error })

  p.keep(rig, { agents: [...AGENTS, 'probe'], grep: /codex|Codex|steer|interrupt/ })
  return p.summary()
}
