// Proof: Orgtree can refuse a Muse approval. Real Muse 1.4.6 offers no
// "denied" choice: its refusal is `abort` ("Reject", once), which rejects that
// one call while the turn goes on (measured 2026-10-13). On the fake
// `muse serve`, which offers that measured choice set and, like real Muse,
// waits for a decision with no timeout of its own. The silence limit is 6 s,
// so an unanswered approval shows within a run.
//   rex: a read outside his folders, which his scope refuses: refused at once
//        with `abort`; the call settles rejected, booked as a denial, and the
//        turn goes on.
//   sam: a shell command on a seat without the shell: refused with `abort`,
//        never the persistent prefix rule.
//   sal: a shell command his scope allows: approved with `allow_once`, never
//        `allow_local_prefix` (a rule that would persist).
// Run: node tools/rig/rig.mjs run tools/rig/proofs/muse-refusal.mjs

import { Proof } from '../proof.mjs'

const AGENTS = ['rex', 'sam', 'sal']
const IDLE_S = 6
const OUTSIDE = 'C:/orgtree-rig-nowhere/secret.txt'

export default async function (rig) {
  const p = new Proof('muse-refusal')
  rig.scenario({
    agents: {
      rex: { turns: [{ name: 'refused read', match: 'PROOF-REFUSE-READ', once: true, steps: [
        { tool: 'read_file', args: { path: OUTSIDE }, approval: true, subject: { kind: 'fileAccess', access: 'read', path: OUTSIDE } },
        { text: 'REX-CARRIED-ON after the refused read.' }] }] },
      sam: { turns: [{ name: 'refused shell', match: 'PROOF-REFUSE-SHELL', once: true, steps: [
        { tool: 'powershell', args: { command: 'Remove-Item notes.txt' }, approval: true },
        { text: 'SAM-CARRIED-ON after the refused command.' }] }] },
      sal: { turns: [{ name: 'approved shell', match: 'PROOF-APPROVE-SHELL', once: true, steps: [
        { tool: 'powershell', args: { command: 'Get-ChildItem' }, approval: true, result: 'SAL-LISTING' },
        { text: 'SAL-DONE after the approved command.' }] }] },
    },
    default: { turns: [{ name: 'default', steps: [{ text: 'OK.' }] }] },
  })
  await rig.waitFor(() => rig.sql('SELECT 1 FROM ot.turns WHERE ended_at IS NULL').length === 0, { what: 'seed turns to settle', timeout: 60000 })
  await rig.waitFor(async () => (await rig.api('GET', '/api/providers'))?.providers?.find((x) => x.id === 'muse' && x.muse?.catalog),
    { what: 'Muse discovery', timeout: 60000 })
  await rig.op({ op: 'hire', name: 'rex', parent: 'boss', tier: 'wonder', title: 'Muse refusal agent' })
  await rig.op({ op: 'hire', name: 'sam', parent: 'boss', tier: 'wonder', title: 'Muse refusal agent', tools: { bash: false } })
  await rig.op({ op: 'hire', name: 'sal', parent: 'boss', tier: 'wonder', title: 'Muse refusal agent' })
  const ids = Object.fromEntries(AGENTS.map((a) => [a, rig.agentRow(a)?.id]))
  p.check('three wonder agents hired on the Muse lane (sam without the shell)', Object.values(ids).every(Boolean), ids)

  const log = (agent, kind) => rig.fakeLog(agent).filter((l) => !kind || l.kind === kind)
  const convo = (agent) => rig.sql(`SELECT body FROM ot.convo WHERE agent_id = ${ids[agent]} ORDER BY seq`).map((r) => r.body)
  const said = (agent, text) => convo(agent).some((b) => b?.role === 'assistant' && String(b.text ?? '').includes(text))
  const requests = (agent) => log(agent, 'send').map((l) => l.line).filter((f) => f?.method === 'approval/request')
  const decided = (agent) => log(agent, 'decide')
  const settled = (agent, tool) => log(agent, 'send').map((l) => l.line)
    .find((f) => f?.method === 'item/completed' && f.params?.item?.kind === 'toolCall' && f.params.item.tool === tool)?.params?.item
  const denials = (turn) => rig.one(`SELECT denials FROM ot.turns WHERE id = ${turn.id}`)?.denials
  const logStart = rig.engineLog().length

  await rig.api('PUT', '/api/app-settings/runtime', { turn_idle_s: IDLE_S })
  try {
    await rig.userMail('rex', 'PROOF-REFUSE-READ: go.')
    await rig.userMail('sam', 'PROOF-REFUSE-SHELL: go.')
    await rig.userMail('sal', 'PROOF-APPROVE-SHELL: go.')
    for (const name of AGENTS) await rig.waitTurns(name, 1, { timeout: 60000 })

    // ---------------------------------------------------------------- rex
    const [rt] = rig.turns('rex')
    const [rq] = requests('rex')
    const rd = decided('rex')
    const ra = log('rex', 'approval')[0]
    const rcall = settled('rex', 'read_file')
    p.check('rex: Muse offered its measured set (allow_once, abort "Reject"; no "denied" choice)',
      JSON.stringify(rq?.params?.availableChoices?.map((c) => [c.choiceId, c.decision, c.scope])) === JSON.stringify([['allow_once', 'approved', 'once'], ['abort', 'abort', 'once']]),
      rq?.params?.availableChoices)
    p.check('rex: Orgtree refused the read outside his folders with the once-only abort, at once',
      rd.length === 1 && rd[0].choice === 'abort' && ra?.choice === 'abort' && ra.waited_ms < 2000, { decided: rd, approval: ra })
    p.check('rex: the call settled rejected ("approval aborted") without being stopped, and the model went on',
      rcall?.status === 'rejected' && rcall.failureReason === 'approval aborted' && !log('rex', 'task_stop').length && said('rex', 'REX-CARRIED-ON'),
      { call: rcall && { status: rcall.status, reason: rcall.failureReason }, stops: log('rex', 'task_stop') })
    p.check('rex: the turn ended well and the refusal is booked as a denial', rt && !rt.error && !rt.killed && denials(rt) === 1,
      { turn: rt, denials: rt && denials(rt) })

    // ---------------------------------------------------------------- sam
    const [st] = rig.turns('sam')
    const [sq] = requests('sam')
    const sd = decided('sam')
    p.check('sam: a shell command his scope refuses: abort, never the persistent prefix rule Muse offered',
      sq?.params?.availableChoices?.some((c) => c.choiceId === 'allow_local_prefix' && c.scope === 'localPersistent')
        && sd.length === 1 && sd[0].choice === 'abort' && settled('sam', 'powershell')?.status === 'rejected',
      { offered: sq?.params?.availableChoices?.map((c) => c.choiceId), decided: sd })
    p.check('sam: the turn went on and ended well, one denial', st && !st.error && !st.killed && said('sam', 'SAM-CARRIED-ON') && denials(st) === 1,
      { turn: st, denials: st && denials(st) })

    // ---------------------------------------------------------------- sal
    const [lt] = rig.turns('sal')
    const ld = decided('sal')
    p.check('sal: a shell command his scope allows: allow_once, never the persistent allow_local_prefix; it ran',
      ld.length === 1 && ld[0].choice === 'allow_once' && !log('sal', 'persistent_rule').length
        && settled('sal', 'powershell')?.status === 'completed' && lt && !lt.error && denials(lt) === 0 && said('sal', 'SAL-DONE'),
      { decided: ld, rules: log('sal', 'persistent_rule'), turn: lt })

    const left = rig.engineLog().slice(logStart).split(/\r?\n/).filter((l) => /no once-only choice for this approval/.test(l))
    p.check('the engine always had a choice to answer with (no approval left waiting)', left.length === 0, left.slice(0, 3))
  } finally {
    await rig.api('PUT', '/api/app-settings/runtime', { turn_idle_s: 600 })
  }
  p.keep(rig, { agents: AGENTS, grep: /approval|once-only|denied|abort/i })
  return p.summary()
}
