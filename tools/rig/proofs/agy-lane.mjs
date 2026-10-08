// Proof: the Antigravity lane's turn paths, on the fake `agy` (stream-json
// print mode). The fake works like the CLI from the agent's folder: orgtree
// tools through the workspace plugin's MCP server (the engine's mcp-bridge
// over its named pipe), the rights and mail hooks from .agents/hooks.json.
//   providers: Antigravity installed and signed in (the rig's agy.exe).
//   gia:  a normal turn: a response, an orgtree tool through the bridge, a
//         native tool; tokens summed over the responses; after an engine
//         restart the next turn resumes her conversation.
//   hal:  mail that arrives mid-turn goes in through the PostInvocation hook
//         (agy-steer): one turn, the mail delivered in it.
//   ivo:  a seat without shell rights: the PreToolUse hook (agy-hook) denies
//         run_command, and the turn books the denial.
//   jen:  an interrupt ends the process tree; the next mail runs a turn.
//   kai:  the CLI dies mid-turn: connection freeze, the retry resumes the
//         conversation with the retry banner.
//   lia:  a quota error: a limit freeze that keeps the request (resume_texts).
//   max:  init names another model than the pinned one: the turn is refused.
// Run: node tools/rig/rig.mjs run tools/rig/proofs/agy-lane.mjs

import { Proof } from '../proof.mjs'

const AGENTS = ['gia', 'hal', 'ivo', 'jen', 'kai', 'lia', 'max']
// the countdown as 3.x measured it from the CLI (antigravity_limits.classify_countdown)
const QUOTA = 'You have exhausted your quota on this model. Resets in 2h53m47s.'

export default async function (rig) {
  const p = new Proof('agy-lane')
  rig.scenario({
    agents: {
      gia: { turns: [
        { name: 'again', match: 'PROOF-AGAIN', steps: [{ text: 'Back after the restart.' }] },
        { name: 'hello', match: 'PROOF-HELLO', steps: [
          { text: 'Hi from gia on the Antigravity lane.' },
          { tool: 'orgtree_chart', args: {}, expect: 'boss' },
          { tool: 'run_command', args: { CommandLine: 'dir', Cwd: '.' }, result: 'a.txt' },
          { usage: { input: 3000, cached: 2000, output: 50 } },
          { text: 'Done.' },
        ] },
      ] },
      hal: { turns: [{ name: 'steered', match: 'STEER-1', once: true, steps: [
        { text: 'Working on it.' },
        { poll_mail: { every_ms: 300, timeout_ms: 20000 } },
        { text: 'Thanks, I have the extra note.' },
      ] }] },
      ivo: { turns: [{ name: 'shell', match: 'PROOF-SHELL', steps: [
        { tool: 'run_command', args: { CommandLine: 'del *', Cwd: '.' }, result: 'should not run' },
        { text: 'I may not use the shell.' },
      ] }] },
      jen: { turns: [{ name: 'long', match: 'PROOF-INT', once: true, steps: [{ text: 'Starting a long job.' }, { sleep_ms: 60000 }, { text: 'NEVER-SAID' }] }] },
      kai: { turns: [
        { name: 'retry', match: 'being retried', steps: [{ text: 'Recovered, continuing.' }] },
        { name: 'die', match: 'PROOF-EXIT', once: true, steps: [{ text: 'Starting.' }, { exit: 1 }] },
      ] },
      lia: { turns: [{ name: 'quota', match: 'PROOF-QUOTA', once: true, steps: [{ text: 'Let me look.' }, { error: QUOTA }] }] },
      max: { turns: [{ name: 'other-model', match: 'PROOF-PIN', once: true, steps: [{ init_model: 'gemini-9-unpinned' }, { text: 'Hello.' }] }] },
    },
    default: { turns: [{ name: 'default', steps: [{ text: 'OK.' }] }] },
  })
  await rig.waitFor(() => rig.sql(`SELECT 1 FROM ot.turns WHERE ended_at IS NULL`).length === 0, { what: 'seed turns to settle', timeout: 60000 })

  const prov = await rig.api('GET', '/api/providers')
  const agy = (prov?.providers ?? []).find(x => x.id === 'google')
  p.check('providers: Antigravity installed (the rig\'s agy.exe) and signed in', agy?.status?.installed && agy.status.connected
    && agy.status.source === 'rig' && agy.hire_enabled, agy?.status)
  for (const name of AGENTS) {
    await rig.op({ op: 'hire', name, parent: 'boss', tier: 'flash', title: 'Antigravity rig agent',
                   ...(name === 'ivo' ? { tools: { bash: false } } : {}) })
  }
  const ids = Object.fromEntries(AGENTS.map(a => [a, rig.agentRow(a)?.id]))
  p.check('seven flash agents hired on the Antigravity lane', AGENTS.every(a => ids[a]), ids)
  const log = (agent, kind) => rig.fakeLog(agent).filter(l => !kind || l.kind === kind)
  const convo = agent => rig.sql(`SELECT body FROM ot.convo WHERE agent_id = ${ids[agent]} ORDER BY seq`).map(r => r.body)
  const mailRow = text => rig.one(`SELECT id, state, turn_id FROM ot.mail WHERE body LIKE '${text.replace(/'/g, "''")}%' ORDER BY id DESC LIMIT 1`)

  // kai first: his retry waits ~30 s while the rest runs
  await rig.userMail('kai', 'PROOF-EXIT: please start the work.')

  // ---------------------------------------------------------------- gia: a normal turn
  await rig.userMail('gia', 'PROOF-HELLO: please say hi.')
  const [g1] = await rig.waitTurns('gia', 1)
  const row1 = rig.one(`SELECT * FROM ot.turns WHERE id = ${g1.id}`)
  p.check('gia: the turn completed without error', !row1.error && !row1.killed, row1.error)
  p.check('gia: tokens summed over her two responses (1200+3000 in, 900+2000 cached, 9+50 out)',
    row1.input_tokens === 4200 && row1.cache_read === 2900 && row1.toks === 59, { input: row1.input_tokens, cached: row1.cache_read, out: row1.toks })
  p.check('gia: priced as gemini-3.8-flash', row1.model === 'gemini-3.8-flash' && Number(row1.cost_usd) > 0 && row1.cost_source === 'priced',
    { model: row1.model, cost: row1.cost_usd, source: row1.cost_source })
  const mcp = log('gia', 'mcp_ready')[0]
  const chartRes = log('gia', 'tool_result').find(l => l.tool === 'orgtree_chart')
  p.check('gia: the orgtree tools reached the CLI through the workspace plugin (mcp-bridge over the pipe)', /orgtree-engine\.exe$/i.test(mcp?.command ?? '')
    && mcp.tools > 30 && chartRes?.ok === true, { mcp, chart: chartRes && String(chartRes.text).slice(0, 80) })
  const said = convo('gia').find(b => b.role === 'assistant' && /Hi from gia/.test(b.text ?? ''))
  p.check('gia: her message carries both tool chips with their results', ['orgtree_chart', 'run_command'].every(n => said?.tools?.some(t => t.name === n && t.result))
    && /boss/.test(said.tools.find(t => t.name === 'orgtree_chart').result), said?.tools?.map(t => [t.name, String(t.result).slice(0, 40)]))
  const conv = log('gia', 'start')[0]?.conversation
  p.check('gia: her conversation is her session', rig.agentRow('gia').session_id === conv, { session: rig.agentRow('gia').session_id, conv })

  // ---------------------------------------------------------------- hal: mid-turn mail through the hook
  await rig.userMail('hal', 'STEER-1: start the job.')
  await rig.waitFor(() => log('hal', 'step').some(l => l.step?.poll_mail), { what: 'hal to wait for mail mid-turn' })
  await rig.userMail('hal', 'STEER-2: an extra note for the running job.')
  const ht = await rig.waitTurns('hal', 1)
  const hooked = log('hal', 'hook_mail')[0]
  p.check('hal: the mid-turn mail reached the running turn through the PostInvocation hook', /STEER-2/.test(hooked?.text ?? '')
    && hooked.termination === 'force_continue', hooked && { text: String(hooked.text).slice(0, 120), termination: hooked.termination })
  await new Promise(r => setTimeout(r, 1500))
  const st = mailRow('STEER-2')
  p.check('hal: one turn for both mails; the steered mail is delivered in it', rig.turns('hal').length === 1 && st?.state === 'delivered'
    && st.turn_id === ht[0].id, { turns: rig.turns('hal').length, mail: st })
  p.check('hal: the conversation shows the mail delivered into the running turn',
    convo('hal').some(b => /STEER-2/.test(JSON.stringify(b)) && /running turn/.test(JSON.stringify(b))))

  // ---------------------------------------------------------------- ivo: the rights hook
  await rig.userMail('ivo', 'PROOF-SHELL: clean up the folder.')
  const [i1] = await rig.waitTurns('ivo', 1)
  const hook = log('ivo', 'hook').find(l => l.event === 'PreToolUse')
  const denied = log('ivo', 'tool_result').find(l => l.tool === 'run_command')
  p.check('ivo: without shell rights the PreToolUse hook denies run_command', hook?.decision === 'deny' && /shell rights/.test(hook.reason ?? '')
    && denied?.denied && /tool call denied by pre-tool hook: orgtree:/.test(denied.text), { hook, text: denied?.text?.slice(0, 120) })
  const irow = rig.one(`SELECT denials, error FROM ot.turns WHERE id = ${i1.id}`)
  p.check('ivo: the turn books the denial and goes on', irow?.denials === 1 && !irow.error, irow)

  // ---------------------------------------------------------------- jen: interrupt
  await rig.userMail('jen', 'PROOF-INT: start the long job.')
  await rig.waitFor(() => log('jen', 'step').some(l => l.step?.sleep_ms), { what: 'jen to be mid-turn' })
  const t0 = Date.now()
  const it = await rig.tool('boss', 'orgtree_interrupt', { node: 'jen' })
  const jt = await rig.waitTurns('jen', 1, { timeout: 20000 })
  p.check('jen: orgtree_interrupt ends the turn within 5 s without an error', it.ok && Date.parse(jt[0].ended_at) - t0 < 5000 && !jt[0].error,
    { ms: Date.parse(jt[0].ended_at) - t0, error: jt[0].error })
  p.check('jen: nothing after the interrupt was said', !convo('jen').some(b => /NEVER-SAID/.test(b.text ?? '')))
  await rig.userMail('jen', 'Next one, please.')
  const jt2 = await rig.waitTurns('jen', 2)
  p.check('jen: the next mail runs a turn on her conversation', !jt2[1].error && log('jen', 'start').at(-1)?.resumed === true,
    { error: jt2[1].error, starts: log('jen', 'start').map(l => l.resumed) })

  // ---------------------------------------------------------------- lia: a quota error
  await rig.userMail('lia', 'PROOF-QUOTA: please do the thing.')
  const lf = await rig.waitFor(() => rig.agentRow('lia')?.frozen, { what: 'lia to be frozen', timeout: 30000 }).catch(() => null)
  p.check('lia: a quota error freezes her as a usage limit and keeps the request', lf?.limit === true
    && /PROOF-QUOTA: please do the thing/.test((lf?.resume_texts ?? []).join('\n')), lf && { until: lf.until, at: lf.at, error: lf.error })
  if (lf) {
    const hours = (Date.parse(lf.until) - Date.parse(lf.at)) / 3600000
    p.note(`lia: held for ${hours.toFixed(2)} h; the error said "Resets in 2h53m47s" (2.90 h)`, { at: lf.at, until: lf.until })
  }

  // ---------------------------------------------------------------- max: the model pin
  await rig.userMail('max', 'PROOF-PIN: hello.')
  const [m1] = await rig.waitTurns('max', 1)
  p.check('max: a session serving another model than the pinned one is refused', /model pin refused/.test(m1.error ?? '')
    && /gemini-9-unpinned/.test(m1.error), m1.error)

  // ---------------------------------------------------------------- kai: died mid-turn, retried
  const kt = await rig.waitFor(() => { const t = rig.turns('kai'); return t.length >= 2 && t.every(x => x.ended_at) ? t : null },
    { what: 'kai\'s retry to finish', timeout: 120000, every: 1000 })
  p.check('kai: the dead turn is recorded with its exit', /exited|died/i.test(kt[0].error ?? ''), kt[0].error)
  p.check('kai: retried by the freeze timer after ~30 s, without error', !kt[1].error && !rig.agentRow('kai').frozen
    && (Date.parse(kt[1].started_at) - Date.parse(kt[0].ended_at)) / 1000 >= 25, { error: kt[1].error })
  const kStarts = log('kai', 'start')
  p.check('kai: the retry resumed his conversation with the retry banner', kStarts.length >= 2 && kStarts.at(-1).resumed
    && kStarts.at(-1).conversation === kStarts[0].conversation && /being retried/.test(log('kai', 'turn').find(l => l.script === 'retry')?.prompt ?? ''),
    kStarts.map(s => [s.conversation, s.resumed]))

  // ---------------------------------------------------------------- gia: after an engine restart
  await rig.restart()
  await rig.userMail('gia', 'PROOF-AGAIN: still there?')
  const g2 = await rig.waitTurns('gia', 2)
  const gStart = log('gia', 'start').at(-1)
  p.check('gia: after a restart the CLI is started on her conversation', !g2[1].error && gStart?.resumed && gStart.conversation === conv,
    { error: g2[1].error, conversation: gStart?.conversation, resumed: gStart?.resumed })

  p.keep(rig, { agents: AGENTS, grep: /agy|Agy|steer|bridge|hook/ })
  return p.summary()
}
