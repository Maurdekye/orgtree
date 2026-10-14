// Proof: Orgtree answers every stage of a Muse approval, and a todo list a
// call writes shows on that call's own chip. Real Muse 1.4.6 asks about a
// compound shell command in stages, one per statement its policy cannot
// settle: `approval/request` names the first stage, each `approval/updated`
// the next, and the call has no item and never starts until every stage is
// decided (measured 2026-10-14: the user's agent bfp-bmi answered only the
// first and waited 6 min until interrupted). On the fake `muse serve`, which
// asks in stages the same way and, like real Muse, waits with no timeout of
// its own. The silence limit is 6 s, so a stage left unanswered shows within
// a run.
//   stan: the measured four-statement command (the last settled by Muse's
//         own policy): stages 0, 1 and 2 approved once each, in order; it runs.
//   stu:  the same with every update delivered twice: each stage still
//         decided once (a second decision would name a stale stage).
//   sten: the same on a seat without the shell: refused at its first stage
//         with `abort`, nothing more asked, the call rejected, one denial,
//         the turn goes on.
//   tod:  a write_todos call: Muse's todo list (`session/todoListChanged`,
//         sourceTool write_todos) lands on the call's own chip, shown as the
//         TodoWrite checklist; no second chip beside it.
// Run: node tools/rig/rig.mjs run tools/rig/proofs/muse-approval-stages.mjs

import { Proof } from '../proof.mjs'

const AGENTS = ['stan', 'stu', 'sten', 'tod']
const IDLE_S = 6
const COMMAND = "$d=[Environment]::GetFolderPath('Desktop'); Write-Host $d; Get-ChildItem -LiteralPath $d -Name | Select-Object -First 80"
const STAGES = [
  ['$d=[Environment]::GetFolderPath', "('Desktop')"],
  ['Write-Host', '$d'],
  ['Get-ChildItem', '-LiteralPath', '$d', '-Name'],
  { argv: ['Select-Object', '-First', '80'], policy: true },
]
const staged = (extra) => ({ tool: 'powershell', args: { command: COMMAND, description: 'List Desktop top level only' },
  approval: true, stages: STAGES, ...extra })
const TODOS = [{ status: 'in_progress', text: 'Locate the old project' }, { status: 'pending', text: 'Design the app' }]

export default async function (rig) {
  const p = new Proof('muse-approval-stages')
  rig.scenario({
    agents: {
      stan: { turns: [{ name: 'staged command', match: 'PROOF-STAGES', once: true, steps: [
        staged({ result: 'STAN-LISTING' }), { text: 'STAN-DONE after the staged command.' }] }] },
      stu: { turns: [{ name: 'staged command, updates twice', match: 'PROOF-STAGES-TWICE', once: true, steps: [
        staged({ result: 'STU-LISTING', dup_updates: true }), { text: 'STU-DONE after the staged command.' }] }] },
      sten: { turns: [{ name: 'staged command refused', match: 'PROOF-STAGES-REFUSED', once: true, steps: [
        staged({}), { text: 'STEN-CARRIED-ON after the refused command.' }] }] },
      tod: { turns: [{ name: 'todo list', match: 'PROOF-TODOS', once: true, steps: [
        { tool: 'write_todos', args: { todos: TODOS }, result: '{"ok":true,"revision":1,"items":2}' },
        { text: 'TOD-DONE with the list written.' }] }] },
    },
    default: { turns: [{ name: 'default', steps: [{ text: 'OK.' }] }] },
  })
  await rig.waitFor(() => rig.sql('SELECT 1 FROM ot.turns WHERE ended_at IS NULL').length === 0, { what: 'seed turns to settle', timeout: 60000 })
  await rig.waitFor(async () => (await rig.api('GET', '/api/providers'))?.providers?.find((x) => x.id === 'muse' && x.muse?.catalog),
    { what: 'Muse discovery', timeout: 60000 })
  await rig.op({ op: 'hire', name: 'stan', parent: 'boss', tier: 'wonder', title: 'Muse staged approval agent' })
  await rig.op({ op: 'hire', name: 'stu', parent: 'boss', tier: 'wonder', title: 'Muse staged approval agent' })
  await rig.op({ op: 'hire', name: 'sten', parent: 'boss', tier: 'wonder', title: 'Muse staged approval agent', tools: { bash: false } })
  await rig.op({ op: 'hire', name: 'tod', parent: 'boss', tier: 'wonder', title: 'Muse todo agent' })
  const ids = Object.fromEntries(AGENTS.map((a) => [a, rig.agentRow(a)?.id]))
  p.check('four wonder agents hired on the Muse lane (sten without the shell)', Object.values(ids).every(Boolean), ids)

  const log = (agent, kind) => rig.fakeLog(agent).filter((l) => !kind || l.kind === kind)
  const sent = (agent, method) => log(agent, 'send').map((l) => l.line).filter((f) => f?.method === method)
  const convo = (agent) => rig.sql(`SELECT body FROM ot.convo WHERE agent_id = ${ids[agent]} ORDER BY seq`).map((r) => r.body)
  const chips = (agent) => convo(agent).flatMap((b) => b?.tools ?? [])
  const said = (agent, text) => convo(agent).some((b) => b?.role === 'assistant' && String(b.text ?? '').includes(text))
  const requests = (agent) => log(agent, 'send').map((l) => l.line).filter((f) => f?.method === 'approval/request')
  const decided = (agent) => log(agent, 'decide')
  const stale = (agent) => log(agent, 'decide_stale')
  const settled = (agent, tool) => sent(agent, 'item/completed').map((f) => f.params?.item)
    .find((i) => i?.kind === 'toolCall' && i.tool === tool)
  const denials = (turn) => rig.one(`SELECT denials FROM ot.turns WHERE id = ${turn.id}`)?.denials
  const stagesOf = (agent) => decided(agent).map((d) => d.requirement?.sourceIndex)
  const logStart = rig.engineLog().length

  await rig.api('PUT', '/api/app-settings/runtime', { turn_idle_s: IDLE_S })
  try {
    await rig.userMail('stan', 'PROOF-STAGES: go.')
    await rig.userMail('stu', 'PROOF-STAGES-TWICE: go.')
    await rig.userMail('sten', 'PROOF-STAGES-REFUSED: go.')
    await rig.userMail('tod', 'PROOF-TODOS: go.')
    for (const name of AGENTS) await rig.waitTurns(name, 1, { timeout: 60000 })

    // ---------------------------------------------------------------- stan
    const [nt] = rig.turns('stan')
    const [nq] = requests('stan')
    const na = log('stan', 'approval')[0]
    const ncall = settled('stan', 'powershell')
    p.check('stan: Muse asked once, naming the first of four stages (the last settled by its own policy)',
      requests('stan').length === 1 && nq?.params?.currentRequirementId?.sourceIndex === 0 && nq.params.subject?.stages?.length === 4
        && nq.params.subject.stages[3]?.resolution?.kind === 'policyAllow',
      { requests: requests('stan').length, current: nq?.params?.currentRequirementId, kinds: nq?.params?.subject?.stages?.map((s) => s.resolution?.kind) })
    p.check('stan: Orgtree answered stages 0, 1 and 2 once each, in order, allow_once, each naming the current stage',
      JSON.stringify(stagesOf('stan')) === '[0,1,2]' && decided('stan').every((d) => d.choice === 'allow_once') && stale('stan').length === 0,
      { decided: decided('stan'), stale: stale('stan') })
    p.check('stan: Muse moved on twice (approval/updated for stages 1 and 2) and resolved the approval approved',
      sent('stan', 'approval/updated').length === 2 && sent('stan', 'approval/resolved').map((f) => f.params?.decision).join() === 'approved',
      { updates: sent('stan', 'approval/updated').map((f) => f.params?.currentRequirementId), resolved: sent('stan', 'approval/resolved').map((f) => f.params?.decision) })
    p.check('stan: the command ran, was never stopped, and the model went on',
      ncall?.status === 'completed' && String(ncall.visibleOutput ?? '').includes('STAN-LISTING') && !log('stan', 'task_stop').length && said('stan', 'STAN-DONE'),
      { call: ncall && { status: ncall.status, reason: ncall.failureReason }, stops: log('stan', 'task_stop') })
    p.check('stan: the turn ended well, no denial, the approval settled in under 3 s (the silence limit is 6 s)',
      nt && !nt.error && !nt.killed && denials(nt) === 0 && na?.decided === 3 && na.waited_ms < 3000,
      { turn: nt, denials: nt && denials(nt), approval: na })
    const nchip = chips('stan').find((c) => c.id === ncall?.itemId)
    p.check("stan: the transcript chip shows the command's result",
      String(nchip?.result ?? '').includes('STAN-LISTING') && !nchip?.error, nchip)

    // ---------------------------------------------------------------- stu
    const [ut] = rig.turns('stu')
    p.check('stu: every update delivered twice, every stage still decided once (none stale), and the command ran',
      sent('stu', 'approval/updated').length === 4 && JSON.stringify(stagesOf('stu')) === '[0,1,2]' && stale('stu').length === 0
        && settled('stu', 'powershell')?.status === 'completed' && ut && !ut.error && said('stu', 'STU-DONE'),
      { updates: sent('stu', 'approval/updated').length, decided: decided('stu'), stale: stale('stu'), turn: ut })

    // ---------------------------------------------------------------- sten
    const [et] = rig.turns('sten')
    const ecall = settled('sten', 'powershell')
    p.check('sten: refused at its first stage with abort, nothing more asked; rejected ("approval aborted"); one denial; the turn went on',
      JSON.stringify(stagesOf('sten')) === '[0]' && decided('sten')[0]?.choice === 'abort' && !sent('sten', 'approval/updated').length
        && ecall?.status === 'rejected' && ecall.failureReason === 'approval aborted'
        && et && !et.error && !et.killed && denials(et) === 1 && said('sten', 'STEN-CARRIED-ON'),
      { decided: decided('sten'), call: ecall && { status: ecall.status, reason: ecall.failureReason }, turn: et, denials: et && denials(et) })

    // ---------------------------------------------------------------- tod
    const [dt] = rig.turns('tod')
    const started = sent('tod', 'item/started').map((f) => f.params?.item).find((i) => i?.tool === 'write_todos')
    const lists = sent('tod', 'session/todoListChanged')
    const tchips = chips('tod')
    const own = tchips.filter((c) => c.id === started?.itemId)
    p.check('tod: one chip for the write_todos call: the TodoWrite checklist on the call itself, no second chip',
      lists.length === 1 && lists[0].params?.sourceTool === 'write_todos' && own.length === 1 && own[0].name === 'TodoWrite'
        && own[0].native_tool === 'write_todos' && !tchips.some((c) => String(c.id).startsWith('plan-'))
        && JSON.stringify(own[0].todos?.map((t) => [t.content, t.status])) === JSON.stringify([['Locate the old project', 'in_progress'], ['Design the app', 'pending']]),
      { lists: lists.length, chips: tchips.map((c) => ({ id: c.id, name: c.name, native: c.native_tool, todos: c.todos?.length })) })
    p.check("tod: the call's chip kept its own timing and result, and the turn ended well",
      own.length >= 1 && own.every((c) => c.started_at && c.ended_at && String(c.result ?? '').includes('"ok":true')) && dt && !dt.error && said('tod', 'TOD-DONE'),
      { chips: own, turn: dt })

    const left = rig.engineLog().slice(logStart).split(/\r?\n/).filter((l) => /no once-only choice for this approval/.test(l))
    p.check('the engine always had a choice to answer with (no approval left waiting)', left.length === 0, left.slice(0, 3))
  } finally {
    await rig.api('PUT', '/api/app-settings/runtime', { turn_idle_s: 600 })
  }
  p.keep(rig, { agents: AGENTS, grep: /approval|stage|once-only|denied|abort|todo/i })
  return p.summary()
}
