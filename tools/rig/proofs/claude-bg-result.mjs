// Proof: a command Claude Code runs in the background reaches the agent when
// it finishes, on the fake CLI with the behaviour measured on Claude Code
// 2.1.292 (2026-10-14): the call returns at once, naming the task and its
// output file; the task's end is a `task_notification` (status, a summary
// with the exit code, the output file) and an empty live set; the CLI hands
// the model only that notification, never the output, into a turn running
// then, else into a turn it starts by itself at once (the engine interrupts
// that turn at its `system init`; the notification stays in the session).
//   cla: finishes while the agent is idle: its chip gets what the command
//        printed (read from the output file), the turn the CLI started by
//        itself is interrupted (none runs), and the agent is woken once through
//        its mailbox (the note names the command and how it ended, never the
//        output); its admitted turn follows. The desk counts the task while it
//        runs. The cancel is warned about.
//   cid: finishes while a later turn runs: that turn takes it, the earlier
//        chip gets the result, no wake message.
//   cim: finishes during a later turn's last model step: that turn does not
//        take it, so the CLI starts a turn of its own right after it
//        (interrupted), and only then is the agent woken, once.
//   cif: exits 3 while the agent is idle: the chip shows the output and the
//        CLI's summary as the error, the full output is kept for reading on
//        demand, and the wake says it failed with exit code 3.
// Run: node tools/rig/rig.mjs run tools/rig/proofs/claude-bg-result.mjs

import { Proof } from '../proof.mjs'

const AGENTS = ['cla', 'cid', 'cim', 'cif']
const FINISHED = 'Your background command has finished'
const BG = (task, command, extra) => ({ bg: { task, id: `toolu_${task}`, command, ...extra } })
const OWN = "into an interrupted turn of the CLI's own"
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export default async function (rig) {
  const p = new Proof('claude-bg-result')
  rig.scenario({
    agents: {
      cla: { turns: [
        { name: 'background build', match: 'PROOF-CLA', once: true, steps: [
          BG('bcla1', 'npm run build', { finish_ms: 5000, output: 'CLA-BUILD-OK\n' }), { text: 'The build runs in the background.' }] },
        { name: 'woken', match: FINISHED, once: true, steps: [{ text: 'CLA-WOKEN' }] }] },
      cid: { turns: [
        { name: 'background tests', match: 'PROOF-CID-1', once: true, steps: [
          BG('bcid1', 'npm test', { finish_ms: 6000, output: 'CID-TESTS-OK\n' }), { text: 'The tests run in the background.' }] },
        { name: 'later turn', match: 'PROOF-CID-2', once: true, steps: [{ text: 'Working on something else.' }, { sleep_ms: 10000 }, { text: 'CID-T2-DONE' }] }] },
      cim: { turns: [
        { name: 'background lint', match: 'PROOF-CIM-1', once: true, steps: [
          BG('bcim1', 'npm run lint', { finish_ms: 6000, output: 'CIM-LINT-OK\n', miss_running_turn: true }), { text: 'Lint runs in the background.' }] },
        { name: 'later turn', match: 'PROOF-CIM-2', once: true, steps: [{ text: 'Thinking it over.' }, { sleep_ms: 10000 }, { text: 'CIM-T2-DONE' }] },
        { name: 'woken', match: FINISHED, once: true, steps: [{ text: 'CIM-WOKEN' }] }] },
      cif: { turns: [
        { name: 'background failure', match: 'PROOF-CIF', once: true, steps: [
          BG('bcif1', 'npm run e2e', { finish_ms: 4000, status: 'failed', exit_code: 3, output: 'CIF-PARTIAL\n' }),
          { text: 'The e2e suite runs in the background.' }] },
        { name: 'woken', match: FINISHED, once: true, steps: [{ text: 'CIF-WOKEN' }] }] },
    },
    default: { turns: [{ name: 'default', steps: [{ text: 'OK.' }] }] },
  })
  await rig.waitFor(() => rig.sql('SELECT 1 FROM ot.turns WHERE ended_at IS NULL').length === 0, { what: 'seed turns to settle', timeout: 60000 })
  for (const name of AGENTS) await rig.op({ op: 'hire', name, parent: 'boss', tier: 'haiku', title: 'Claude background agent' })
  const ids = Object.fromEntries(AGENTS.map((a) => [a, rig.agentRow(a)?.id]))
  p.check('four haiku agents hired on the Claude lane', Object.values(ids).every(Boolean), ids)

  const log = (agent, kind) => rig.fakeLog(agent).filter((l) => !kind || l.kind === kind)
  const convo = (agent) => rig.sql(`SELECT body FROM ot.convo WHERE agent_id = ${ids[agent]} ORDER BY seq`).map((r) => r.body)
  const chipOf = (agent, task) => convo(agent).flatMap((b) => b?.tools ?? []).find((c) => c.id === `toolu_${task}`) ?? null
  const said = (agent, text) => convo(agent).some((b) => b?.role === 'assistant' && String(b.text ?? '').includes(text))
  const mails = (agent, like) => rig.sql(`SELECT m.uid, m.sender, m.notice, m.state, m.body FROM ot.mail m
    WHERE m.recipient_agent_id = ${ids[agent]} AND m.body LIKE '${like.replace(/'/g, "''")}' ORDER BY m.id`)
  const delivered = (agent) => log(agent, 'bg_delivered')
  const ownRan = (agent) => delivered(agent).some((l) => l.how === "the CLI's own turn ran")
  // the desk's view of an agent: its node in the org tree (a node carries the agent's name in `id`)
  const find = (nodes, name) => {
    for (const n of nodes ?? []) {
      if (n.id === name) return n
      const kid = find(n.children, name)
      if (kid) return kid
    }
    return null
  }
  const nodeOf = async (agent) => find((await rig.api('GET', `/api/orgs/${rig.org}`))?.roots, agent)
  const deskRead = async (agent, field, ok, timeout = 3000) => {
    let last = null
    await rig.waitFor(async () => { last = (await nodeOf(agent))?.[field] ?? null; return ok(last) },
      { what: `${agent}'s ${field} on the desk`, timeout, every: 200 }).catch(() => null)
    return last
  }
  await rig.waitFor(async () => { const roots = (await rig.api('GET', `/api/orgs/${rig.org}`))?.roots; return AGENTS.every((a) => find(roots, a)) },
    { what: 'the hired agents on the desk', timeout: 30000, every: 250 }).catch(() => null)

  // ---------------------------------------------------------------- all four start
  for (const [name, mark] of [['cla', 'PROOF-CLA'], ['cid', 'PROOF-CID-1'], ['cim', 'PROOF-CIM-1'], ['cif', 'PROOF-CIF']]) {
    await rig.userMail(name, `${mark}: go.`)
  }
  await rig.waitTurns('cla', 1, { timeout: 60000 })
  const claRunning = await deskRead('cla', 'bg_tasks', (v) => v === 1)
  // cid's and cim's later turns start at once and still run when their commands finish (6 s after they started)
  await rig.waitTurns('cid', 1, { timeout: 60000 })
  await rig.userMail('cid', 'PROOF-CID-2: next task.')
  await rig.waitTurns('cim', 1, { timeout: 60000 })
  await rig.userMail('cim', 'PROOF-CIM-2: next task.')

  // ---------------------------------------------------------------- cla
  await rig.waitTurns('cla', 2, { timeout: 60000 }).catch(() => null)
  const cla = chipOf('cla', 'bcla1')
  const claTurn1 = rig.turns('cla')[0]
  p.check('cla: the chip of the command run in the background got what it printed, read from its output file, after the turn ended',
    cla?.result === 'CLA-BUILD-OK\n' && cla?.result_lines === 1 && cla?.ended_at && !cla?.error && claTurn1?.ended_at
      && Date.parse(cla.ended_at) > Date.parse(claTurn1.ended_at), { chip: cla, turn1: claTurn1 })
  p.check('cla: the turn the CLI started by itself to hand it over was interrupted (none ran)',
    delivered('cla').length === 1 && delivered('cla')[0].how === OWN && log('cla', 'own_turn').length === 1 && !ownRan('cla'),
    { delivered: delivered('cla'), own: log('cla', 'own_turn') })
  const claMail = mails('cla', `${FINISHED}%`)
  p.check('cla: woken once through its mailbox; the note names the command and how it ended, never the output',
    claMail.length === 1 && /has finished \(it completed, exit code 0\): Bash `npm run build`/.test(claMail[0].body)
      && !claMail[0].body.includes('CLA-BUILD-OK') && !claMail[0].notice && claMail[0].sender === '@system', claMail)
  const claTurns = rig.turns('cla')
  p.check('cla: that wake was an admitted turn, which read the note and answered', claTurns.length === 2 && !claTurns[1].error && said('cla', 'CLA-WOKEN'),
    claTurns)
  const claAfter = await deskRead('cla', 'bg_tasks', (v) => v === 0)
  p.check('cla: the desk counted the task as background work while it ran, and stops once it ended',
    claRunning === 1 && claAfter === 0, { running: claRunning, after: claAfter })
  const claCancel = rig.engineLog().split('\n').filter((l) => l.includes('cancelling turns the Claude Code CLI started by itself') && /agent=cla\b/.test(l))
  p.check('cla: the cancelled turn is warned about once', claCancel.length === 1, { lines: claCancel.length, sample: claCancel.slice(0, 1) })

  // ---------------------------------------------------------------- cid
  await rig.waitTurns('cid', 2, { timeout: 60000 }).catch(() => null)
  await sleep(4000)
  const cid = chipOf('cid', 'bcid1')
  const cidFinished = log('cid', 'bg_finished')[0]
  p.check('cid: the command finished while the later turn ran (the fake says so)', cidFinished?.running === true && !cidFinished?.miss, cidFinished)
  p.check("cid: the earlier turn's chip got the result", cid?.result === 'CID-TESTS-OK\n' && cid?.ended_at && !cid?.error, cid)
  p.check('cid: the running turn took it; no turn of the CLI\'s own, no wake message, no extra turn',
    delivered('cid').length === 1 && delivered('cid')[0].how === 'into the running turn' && !log('cid', 'own_turn').length
      && mails('cid', `${FINISHED}%`).length === 0 && rig.turns('cid').length === 2 && said('cid', 'CID-T2-DONE'),
    { delivered: delivered('cid'), turns: rig.turns('cid') })

  // ---------------------------------------------------------------- cim
  await rig.waitTurns('cim', 3, { timeout: 60000 }).catch(() => null)
  const cim = chipOf('cim', 'bcim1')
  const cimFinished = log('cim', 'bg_finished')[0]
  const cimMail = mails('cim', `${FINISHED}%`)
  p.check('cim: the command finished during the later turn\'s last model step, which did not take it (the fake says so)',
    cimFinished?.running === true && cimFinished?.miss === true, cimFinished)
  p.check('cim: right after that turn, the CLI started a turn of its own to hand it over, interrupted (none ran)',
    delivered('cim').length === 1 && delivered('cim')[0].how === OWN && !ownRan('cim'), delivered('cim'))
  p.check('cim: the agent was woken once for it, and its admitted turn followed; the chip has the result',
    cimMail.length === 1 && /has finished \(it completed, exit code 0\): Bash `npm run lint`/.test(cimMail[0].body)
      && rig.turns('cim').length === 3 && said('cim', 'CIM-WOKEN') && cim?.result === 'CIM-LINT-OK\n',
    { mail: cimMail, turns: rig.turns('cim'), chip: cim })

  // ---------------------------------------------------------------- cif
  await rig.waitTurns('cif', 2, { timeout: 60000 }).catch(() => null)
  const cif = chipOf('cif', 'bcif1')
  const cifMail = mails('cif', `${FINISHED}%`)
  p.check('cif: a failed background command: the chip shows the output and the CLI\'s summary as the error',
    cif?.result === 'CIF-PARTIAL\n' && cif?.error === 'Background command "npm run e2e" failed with exit code 3', cif)
  const cifKept = rig.one(`SELECT c.tool_inputs->'toolu_bcif1'->'failed_shell_output'->>'output' AS out FROM ot.convo c
    WHERE c.agent_id = ${ids.cif} AND c.tool_inputs ? 'toolu_bcif1'`)
  p.check('cif: its full failed output is kept for reading on demand, as for any failed shell call',
    cifKept?.out === 'CIF-PARTIAL\n' && Number.isInteger(cif?.output_seq), { kept: cifKept, output_seq: cif?.output_seq })
  p.check('cif: the wake says it failed with exit code 3, once; the admitted turn ran',
    cifMail.length === 1 && cifMail[0].body.includes('(it failed, exit code 3)') && rig.turns('cif').length === 2 && said('cif', 'CIF-WOKEN')
      && delivered('cif')[0]?.how === OWN, { mail: cifMail, turns: rig.turns('cif'), delivered: delivered('cif') })

  p.keep(rig, { agents: AGENTS, grep: /background|started by itself|turn outside|kept open|stays open|not taken by it/i })
  return p.summary()
}
