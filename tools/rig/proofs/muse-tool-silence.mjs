// Proof: a Muse tool call that outlives the turn's silence limit ends by
// itself and the turn goes on (user 2026-10-13: "it shouldnt stop the turn,
// just end the tool call and allow the agent to continue"), on the fake
// `muse serve` with the protocol measured on Muse 1.4.6 (`task/stop` on the
// call's item id settles it `cancelled`; steered input arrives with that
// result). The silence limit is 4 s here.
//   tia: one silent powershell call: a note naming the limit is steered into
//        the turn, then the call alone is stopped; the turn carries on and
//        ends well, the host untouched, the chip saying why it stopped.
//   sol: the model itself goes silent (no call in flight): the turn stops
//        as before.
//   tom: two silent calls in a row: each is stopped in its turn.
//   ida: a call whose stop does not take: one stop, then a whole limit
//        later the turn stops as before (no endless stopping).
//   bea: work Muse moved to the background, then a silent model: nothing is
//        stopped; the turn stops as before.
//   cap: silent calls one after another under a 10 s total ceiling: the
//        ceiling still ends the turn.
// Run: node tools/rig/rig.mjs run tools/rig/proofs/muse-tool-silence.mjs

import { Proof } from '../proof.mjs'

const AGENTS = ['tia', 'sol', 'tom', 'ida', 'bea', 'cap']
const SILENT = { silent_ms: 120000 }
const IDLE_S = 4

export default async function (rig) {
  const p = new Proof('muse-tool-silence')
  rig.scenario({
    agents: {
      tia: { turns: [{ name: 'one silent call', match: 'PROOF-TOOL', once: true, steps: [
        { text: 'Listing the folder.' },
        { tool: 'powershell', args: { command: 'Get-ChildItem' }, ...SILENT },
        { text: 'TIA-CARRIED-ON after the stopped call.' }] }] },
      sol: { turns: [{ name: 'silent model', match: 'PROOF-SILENT', once: true, steps: [
        { text: 'Thinking it over.' }, { sleep_ms: 120000 }, { text: 'NEVER-SAID' }] }] },
      tom: { turns: [{ name: 'two silent calls', match: 'PROOF-TWO', once: true, steps: [
        { tool: 'powershell', args: { command: 'dir' }, ...SILENT },
        { tool: 'mcp__slow__wait', args: { for: 'ever' }, ...SILENT },
        { text: 'TOM-DONE after both stopped calls.' }] }] },
      ida: { turns: [{ name: 'stop does not take', match: 'PROOF-STUCK', once: true, steps: [
        { tool: 'powershell', args: { command: 'dir' }, ...SILENT, ignore_stop: true }, { text: 'NEVER-SAID' }] }] },
      bea: { turns: [{ name: 'background then silent', match: 'PROOF-BG', once: true, steps: [
        { tool: 'powershell', args: { command: 'npm test' }, ...SILENT, background_ms: 500 },
        { text: 'The tests run in the background.' }, { sleep_ms: 120000 }, { text: 'NEVER-SAID' }] }] },
      cap: { turns: [{ name: 'ceiling', match: 'PROOF-CEIL', once: true, steps: [
        ...Array.from({ length: 6 }, (_, i) => ({ tool: 'powershell', args: { command: `step ${i}` }, ...SILENT })),
        { text: 'NEVER-SAID' }] }] },
    },
    default: { turns: [{ name: 'default', steps: [{ text: 'OK.' }] }] },
  })
  await rig.waitFor(() => rig.sql('SELECT 1 FROM ot.turns WHERE ended_at IS NULL').length === 0, { what: 'seed turns to settle', timeout: 60000 })
  await rig.waitFor(async () => (await rig.api('GET', '/api/providers'))?.providers?.find((x) => x.id === 'muse' && x.muse?.catalog),
    { what: 'Muse discovery', timeout: 60000 })
  for (const name of AGENTS) await rig.op({ op: 'hire', name, parent: 'boss', tier: 'wonder', title: 'Muse silence agent' })
  const ids = Object.fromEntries(AGENTS.map((a) => [a, rig.agentRow(a)?.id]))
  p.check('six wonder agents hired on the Muse lane', Object.values(ids).every(Boolean), ids)

  const log = (agent, kind) => rig.fakeLog(agent).filter((l) => !kind || l.kind === kind)
  const convo = (agent) => rig.sql(`SELECT body FROM ot.convo WHERE agent_id = ${ids[agent]} ORDER BY seq`).map((r) => r.body)
  const chips = (agent) => convo(agent).flatMap((b) => b?.tools ?? [])
  const said = (agent, text) => convo(agent).some((b) => b?.role === 'assistant' && String(b.text ?? '').includes(text))
  const at = (l) => Date.parse(l.ts)
  const tools = (agent) => log(agent, 'send').map((l) => l.line).filter((f) => f?.method === 'item/started' && f.params?.item?.kind === 'toolCall')
    .map((f) => ({ id: f.params.item.itemId, tool: f.params.item.tool }))
  const startedAt = (agent, item) => {
    const l = log(agent, 'send').find((x) => x.line?.method === 'item/started' && x.line.params?.item?.itemId === item)
    return l ? at(l) : NaN
  }
  const silenceKill = (t) => t.killed && /produced nothing for too long/.test(t.error ?? '')

  await rig.api('PUT', '/api/app-settings/runtime', { turn_idle_s: IDLE_S })
  try {
    // ---------------------------------------------------------------- tia, sol, tom, ida, bea together
    for (const [name, mark] of [['tia', 'PROOF-TOOL'], ['sol', 'PROOF-SILENT'], ['tom', 'PROOF-TWO'], ['ida', 'PROOF-STUCK'], ['bea', 'PROOF-BG']]) {
      await rig.userMail(name, `${mark}: go.`)
    }
    for (const name of ['tia', 'sol', 'tom', 'ida', 'bea']) await rig.waitTurns(name, 1, { timeout: 60000 })

    // ---------------------------------------------------------------- tia
    const [tt] = rig.turns('tia')
    const [tCall] = tools('tia')
    const tStops = log('tia', 'task_stop')
    const tSteers = log('tia', 'steer')
    const tResult = log('tia', 'tool_result').find((l) => l.item === tCall?.id)
    p.check('tia: the turn carried on and ended well (no error, not killed)', tt && !tt.error && !tt.killed, tt)
    p.check('tia: the silent powershell call alone was stopped (task/stop on its item id), once, after the silence limit',
      tStops.length === 1 && tStops[0].task === tCall?.id && tStops[0].known === true && tCall?.tool === 'powershell'
        && at(tStops[0]) - startedAt('tia', tCall.id) >= (IDLE_S - 0.5) * 1000,
      { call: tCall, stops: tStops, afterMs: tStops[0] && at(tStops[0]) - startedAt('tia', tCall?.id) })
    p.check('tia: a note naming the call and the limit went into the turn first and reached the model with the call\'s result',
      tSteers.length === 1 && tStops.length === 1 && at(tSteers[0]) <= at(tStops[0])
        && /your powershell call: it produced no output for 4 seconds, the silence limit for a turn/.test(tSteers[0].text)
        && tResult?.stopped === true && JSON.stringify(tResult.steered) === JSON.stringify([tSteers[0].text]),
      { steers: tSteers.map((s) => s.text), result: tResult })
    p.check('tia: the model went on after the stop (its next step ran and its text landed)', said('tia', 'TIA-CARRIED-ON'), convo('tia').map((b) => b?.text))
    const tChip = chips('tia').find((c) => c.id === tCall?.id)
    p.check('tia: the transcript chip says Orgtree stopped the call at the silence limit',
      tChip?.name === 'powershell' && tChip.error === 'stopped by Orgtree: no output for 4 seconds (the silence limit)' && tChip.ended_at, tChip)
    const tEnd = log('tia', 'turn_end')[0]
    const upToEnd = (kind) => log('tia', kind).filter((l) => tEnd && at(l) <= at(tEnd))
    p.check('tia: the Muse host was neither killed nor restarted (one launch, no exit, up to the turn\'s end)',
      tEnd?.terminal === 'completed' && upToEnd('start').length === 1 && !upToEnd('exit').length,
      { starts: upToEnd('start').length, exits: upToEnd('exit'), end: tEnd })

    // ---------------------------------------------------------------- sol
    const [st] = rig.turns('sol')
    p.check('sol: the model itself went silent (no call in flight): the turn stopped as before, nothing stopped alone',
      st && silenceKill(st) && !log('sol', 'task_stop').length && !log('sol', 'steer').length, { turn: st, stops: log('sol', 'task_stop') })

    // ---------------------------------------------------------------- tom
    const [tm] = rig.turns('tom')
    const mCalls = tools('tom')
    const mStops = log('tom', 'task_stop')
    p.check('tom: two silent calls, each stopped in its turn (two stops, two items, each a full limit after it started)',
      mCalls.length === 2 && mStops.length === 2 && mStops.map((s) => s.task).join() === mCalls.map((c) => c.id).join()
        && mStops.every((s, i) => at(s) - startedAt('tom', mCalls[i].id) >= (IDLE_S - 0.5) * 1000),
      { calls: mCalls, stops: mStops.map((s) => ({ task: s.task, afterMs: at(s) - startedAt('tom', s.task) })) })
    p.check('tom: each stop came with its own note (the MCP call named too), and the turn ended well',
      log('tom', 'steer').length === 2 && /mcp__slow__wait call/.test(log('tom', 'steer')[1]?.text ?? '')
        && tm && !tm.error && !tm.killed && said('tom', 'TOM-DONE'), { turn: tm, steers: log('tom', 'steer').map((s) => s.text) })

    // ---------------------------------------------------------------- ida
    const [it] = rig.turns('ida')
    const [iCall] = tools('ida')
    const iStops = log('ida', 'task_stop')
    p.check('ida: a stop that does not take is asked once; a whole limit later the turn stops as before',
      iStops.length === 1 && it && silenceKill(it) && log('ida', 'tool_stop_seen')[0]?.ignored === true
        && Date.parse(it.ended_at) - startedAt('ida', iCall?.id) >= (2 * IDLE_S - 0.5) * 1000,
      { stops: iStops.length, turn: it, endedAfterMs: it && Date.parse(it.ended_at) - startedAt('ida', iCall?.id) })

    // ---------------------------------------------------------------- bea
    const [bt] = rig.turns('bea')
    p.check('bea: work Muse moved to the background is not stopped; the silent model\'s turn stops as before',
      log('bea', 'tool_background').length === 1 && !log('bea', 'task_stop').length && bt && silenceKill(bt),
      { background: log('bea', 'tool_background'), stops: log('bea', 'task_stop'), turn: bt })

    // ---------------------------------------------------------------- cap: the total ceiling still ends the turn
    await rig.api('PUT', '/api/app-settings/runtime', { turn_timeout_s: 10 })
    try {
      await rig.userMail('cap', 'PROOF-CEIL: go.')
      await rig.waitTurns('cap', 1, { timeout: 60000 })
    } finally {
      await rig.api('PUT', '/api/app-settings/runtime', { turn_timeout_s: 86400 })
    }
    const [ct] = rig.turns('cap')
    p.check('cap: silent calls are stopped one after another, and the 10 s total ceiling still ends the turn',
      ct && ct.killed && /ran past its time limit/.test(ct.error ?? '') && log('cap', 'task_stop').length >= 1
        && (Date.parse(ct.ended_at) - Date.parse(ct.started_at)) >= 9500,
      { turn: ct, stops: log('cap', 'task_stop').length })
  } finally {
    await rig.api('PUT', '/api/app-settings/runtime', { turn_idle_s: 600, turn_timeout_s: 86400 })
  }
  p.keep(rig, { agents: AGENTS, grep: /silence limit|task\/stop|turn\/steer|ending turn|did not take|silence note/i })
  return p.summary()
}
