// Proof: a shell command Muse moves to the background reaches the agent when
// it finishes, on the fake `muse serve` with the behaviour measured on Muse
// 1.4.6 (2026-10-13): the call's item settles under the turn it started in,
// even after that turn ended; Muse hands the result to the session itself,
// into a turn running then, else by starting turns of its own (again at once
// after each cancel) until a turn of the client's arrives or one cancelled
// turn takes it; a host that ends meanwhile says nothing of the command.
//   ivy: finishes while the agent is idle: the chip gets the result, the agent
//        is woken once through its mailbox (the note names the command and
//        how it ended, never the output), every turn Muse starts is cancelled,
//        the result goes into the admitted turn; the desk counts the command
//        as background work while it runs.
//   dan: finishes while a later turn runs: the earlier chip gets the result,
//        that turn gets it from Muse, no wake message.
//   sam: finishes inside its own turn: recorded as before, no wake message.
//   fay: exits non-zero while the agent is idle: the chip and the wake say it
//        failed and why; its full failed output is kept for reading on demand.
//   hal: the host is stopped (halt) while the command runs: the chip says it
//        ended with its host, the agent is told once (no result will arrive),
//        and reads that when unhalted.
//   fro: its turn hits a quota wall while the command runs: Orgtree closes the
//        host at a usage limit, so the command ends with it; the chip says
//        so, and the agent is told once, the message waiting in its mailbox
//        while it is frozen.
//   que: finishes while the agent waits for a turn slot (kit's turn holds the
//        only one), its host alive: the chip gets the result and the wake
//        waits in the mailbox; each turn Muse starts meanwhile is cancelled
//        (none runs), the cancels are warned about once, not one line each,
//        and the result goes into the turn admitted when the slot frees.
// Run: node tools/rig/rig.mjs run tools/rig/proofs/muse-bg-result.mjs

import { Proof } from '../proof.mjs'

const AGENTS = ['ivy', 'dan', 'sam', 'fay', 'hal', 'fro', 'que', 'kit']
const BG = (command, extra) => ({ tool: 'powershell', args: { command }, silent_ms: 600000, background_ms: 300, ...extra })
const FINISHED = 'Your background command has finished'
// the engine's warning about cancelled Muse-started turns: one line per cancel
// before this change, at most one a minute after it
const CANCEL_LINES = ['cancelling a Muse turn Orgtree did not start', 'cancelling turns the Muse host started by itself']
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export default async function (rig) {
  const p = new Proof('muse-bg-result')
  const wall = Date.now() + 3600 * 1000
  rig.scenario({
    agents: {
      ivy: { turns: [
        { name: 'background build', match: 'PROOF-IVY', once: true, steps: [
          BG('npm run build', { finish_ms: 5000, output: 'IVY-BUILD-OK' }), { text: 'The build runs in the background.' }] },
        { name: 'woken', match: FINISHED, once: true, steps: [{ text: 'IVY-WOKEN: the build finished.' }] }] },
      dan: { turns: [
        { name: 'background tests', match: 'PROOF-DAN-1', once: true, steps: [
          BG('npm test', { finish_ms: 8000, output: 'DAN-TESTS-OK' }), { text: 'The tests run in the background.' }] },
        { name: 'later turn', match: 'PROOF-DAN-2', once: true, steps: [{ text: 'Working on something else.' }, { sleep_ms: 12000 }, { text: 'DAN-T2-DONE' }] }] },
      sam: { turns: [
        { name: 'finishes in its turn', match: 'PROOF-SAM', once: true, steps: [
          BG('npm run lint', { finish_ms: 1500, output: 'SAM-LINT-OK' }), { sleep_ms: 3500 }, { text: 'SAM-DONE' }] }] },
      fay: { turns: [
        { name: 'background failure', match: 'PROOF-FAY', once: true, steps: [
          BG('npm run e2e', { finish_ms: 4000, finish_status: 'failed', failure: 'process exited with status 3', output: 'FAY-PARTIAL' }),
          { text: 'The e2e suite runs in the background.' }] },
        { name: 'woken', match: FINISHED, once: true, steps: [{ text: 'FAY-WOKEN' }] }] },
      hal: { turns: [
        { name: 'long background job', match: 'PROOF-HAL', once: true, steps: [
          BG('npm run soak', { finish_ms: 120000, output: 'NEVER' }), { text: 'The soak test runs in the background.' }] },
        { name: 'told', match: 'did not finish', once: true, steps: [{ text: 'HAL-TOLD' }] }] },
      fro: { turns: [
        { name: 'background then wall', match: 'PROOF-FRO', once: true, steps: [
          BG('npm run bench', { finish_ms: 3000, output: 'FRO-BENCH-OK' }), { quota: { resetsAtMs: wall } }] }] },
      que: { turns: [
        { name: 'background profile', match: 'PROOF-QUE', once: true, steps: [
          BG('npm run profile', { finish_ms: 6000, output: 'QUE-PROFILE-OK', drain_after: 1500 }), { text: 'The profile runs in the background.' }] },
        { name: 'woken', match: FINISHED, once: true, steps: [{ text: 'QUE-WOKEN' }] }] },
      kit: { turns: [
        { name: 'holds the only slot', match: 'PROOF-KIT', once: true, steps: [{ text: 'Holding the turn slot.' }, { sleep_ms: 120000 }, { text: 'KIT-DONE' }] }] },
    },
    default: { turns: [{ name: 'default', steps: [{ text: 'OK.' }] }] },
  })
  await rig.waitFor(() => rig.sql('SELECT 1 FROM ot.turns WHERE ended_at IS NULL').length === 0, { what: 'seed turns to settle', timeout: 60000 })
  await rig.waitFor(async () => (await rig.api('GET', '/api/providers'))?.providers?.find((x) => x.id === 'muse' && x.muse?.catalog),
    { what: 'Muse discovery', timeout: 60000 })
  for (const name of AGENTS) await rig.op({ op: 'hire', name, parent: 'boss', tier: 'wonder', title: 'Muse background agent' })
  const ids = Object.fromEntries(AGENTS.map((a) => [a, rig.agentRow(a)?.id]))
  p.check('eight wonder agents hired on the Muse lane', Object.values(ids).every(Boolean), ids)

  const log = (agent, kind) => rig.fakeLog(agent).filter((l) => !kind || l.kind === kind)
  const convo = (agent) => rig.sql(`SELECT body FROM ot.convo WHERE agent_id = ${ids[agent]} ORDER BY seq`).map((r) => r.body)
  const chipOf = (agent) => {
    const item = log(agent, 'tool_background')[0]?.item
    return { item, chip: convo(agent).flatMap((b) => b?.tools ?? []).find((c) => c.id === item) }
  }
  const said = (agent, text) => convo(agent).some((b) => b?.role === 'assistant' && String(b.text ?? '').includes(text))
  const mails = (agent, like) => rig.sql(`SELECT m.uid, m.sender, m.notice, m.state, m.body FROM ot.mail m
    WHERE m.recipient_agent_id = ${ids[agent]} AND m.body LIKE '${like.replace(/'/g, "''")}' ORDER BY m.id`)
  const wakes = (agent) => log(agent, 'send').map((l) => l.line).filter((f) => f?.method === 'turn/started')
    .map((f) => f.params.turnId).filter((t) => !log(agent, 'turn_start').some((s) => s.turn === t))
  const cancels = (agent) => log(agent, 'cancel').map((l) => l.turn)
  const ownRan = (agent) => log(agent, 'bg_delivered').some((l) => l.how === "Muse's own turn ran")
  const delivered = (agent) => log(agent, 'bg_delivered')
  // the desk's view of an agent: its node in the org tree, runtime overlay
  // included; a node carries the agent's name in `id` (it has no `name`)
  const find = (nodes, name) => {
    for (const n of nodes ?? []) {
      if (n.id === name) return n
      const kid = find(n.children, name)
      if (kid) return kid
    }
    return null
  }
  const nodeOf = async (agent) => find((await rig.api('GET', `/api/orgs/${rig.org}`))?.roots, agent)
  // one desk field, read until it holds (the tree is the feed's snapshot); its last value otherwise
  const deskRead = async (agent, field, ok, timeout = 3000) => {
    let last = null
    await rig.waitFor(async () => { last = (await nodeOf(agent))?.[field] ?? null; return ok(last) },
      { what: `${agent}'s ${field} on the desk`, timeout, every: 200 }).catch(() => null)
    return last
  }
  const allCancelled = (agent) => wakes(agent).every((w) => cancels(agent).includes(w)) && !ownRan(agent)
  // the feed adds a hired agent to its tree a moment after the hire
  await rig.waitFor(async () => { const roots = (await rig.api('GET', `/api/orgs/${rig.org}`))?.roots; return AGENTS.every((a) => find(roots, a)) },
    { what: 'the hired agents on the desk', timeout: 30000, every: 250 }).catch(() => null)

  // ---------------------------------------------------------------- six start together
  for (const [name, mark] of [['ivy', 'PROOF-IVY'], ['dan', 'PROOF-DAN-1'], ['sam', 'PROOF-SAM'], ['fay', 'PROOF-FAY'], ['hal', 'PROOF-HAL'], ['fro', 'PROOF-FRO']]) {
    await rig.userMail(name, `${mark}: go.`)
  }
  // ivy: the desk counts the command as background work while it runs (it finishes 5 s after it started)
  await rig.waitTurns('ivy', 1, { timeout: 60000 })
  const ivyRunning = await deskRead('ivy', 'bg_tasks', (v) => v === 1)
  // dan's later turn starts at once and is still running when its first command finishes (8 s after it started)
  await rig.waitTurns('dan', 1, { timeout: 60000 })
  await rig.userMail('dan', 'PROOF-DAN-2: next task.')
  for (const name of ['fay', 'hal', 'fro']) await rig.waitTurns(name, 1, { timeout: 60000 })
  const halHeld = await deskRead('hal', 'bg_tasks', (v) => v === 1)

  // ---------------------------------------------------------------- ivy
  await rig.waitTurns('ivy', 2, { timeout: 60000 }).catch(() => null)
  const ivy = chipOf('ivy')
  p.check('ivy: the chip of the command Muse moved to the background got its result after the turn ended',
    ivy.chip?.result === 'IVY-BUILD-OK' && ivy.chip?.ended_at && !ivy.chip?.error && rig.turns('ivy')[0]?.ended_at
      && Date.parse(ivy.chip.ended_at) > Date.parse(rig.turns('ivy')[0].ended_at), { ivy, turn1: rig.turns('ivy')[0] })
  const ivyMail = mails('ivy', `${FINISHED}%`)
  p.check('ivy: woken once through its mailbox; the note names the command and how it ended, never the output',
    ivyMail.length === 1 && /has finished \(it completed\): powershell `npm run build`/.test(ivyMail[0].body)
      && !ivyMail[0].body.includes('IVY-BUILD-OK') && !ivyMail[0].notice, ivyMail)
  const ivyTurns = rig.turns('ivy')
  p.check('ivy: that wake was an admitted turn, which read the note and answered', ivyTurns.length === 2 && !ivyTurns[1].error && said('ivy', 'IVY-WOKEN'),
    ivyTurns)
  const ivyStarts = log('ivy', 'turn_start')
  p.check('ivy: every turn Muse started to deliver the result was cancelled (none ran), and the result went into the admitted turn',
    allCancelled('ivy') && delivered('ivy').length === 1 && delivered('ivy')[0].how === "into the client's next turn"
      && delivered('ivy')[0].into === ivyStarts[1]?.turn,
    { wakes: wakes('ivy').length, cancels: cancels('ivy').length, delivered: delivered('ivy'), starts: ivyStarts.map((s) => s.turn) })
  const ivyAfter = await deskRead('ivy', 'bg_tasks', (v) => v === 0)
  p.check('ivy: the desk counted the command as background work while it ran, and stops counting once it finished',
    ivyRunning === 1 && ivyAfter === 0, { running: ivyRunning, after: ivyAfter })

  // ---------------------------------------------------------------- dan
  await rig.waitTurns('dan', 2, { timeout: 60000 }).catch(() => null)
  const dan = chipOf('dan')
  const danTurns = rig.turns('dan')
  const danFinished = log('dan', 'tool_finished')[0]
  p.check('dan: the command finished while the later turn ran (the fake says so)',
    danFinished && danFinished.running && danFinished.running !== danFinished.turn, danFinished)
  p.check('dan: the earlier turn\'s chip got the result', dan.chip?.result === 'DAN-TESTS-OK' && dan.chip?.ended_at && !dan.chip?.error, dan)
  p.check('dan: Muse gave the running turn the result; no wake message and no extra turn',
    delivered('dan')[0]?.how === 'into the running turn' && delivered('dan')[0]?.into === danFinished?.running
      && mails('dan', `${FINISHED}%`).length === 0 && danTurns.length === 2 && !danTurns[1].error && said('dan', 'DAN-T2-DONE'),
    { delivered: delivered('dan'), turns: danTurns })

  // ---------------------------------------------------------------- sam
  await rig.waitTurns('sam', 1, { timeout: 60000 })
  const sam = chipOf('sam')
  p.check('sam: finished inside its own turn: recorded as before, no wake message, one turn',
    sam.chip?.result === 'SAM-LINT-OK' && delivered('sam')[0]?.how === 'into the running turn' && mails('sam', `${FINISHED}%`).length === 0
      && rig.turns('sam').length === 1 && said('sam', 'SAM-DONE'), { sam, delivered: delivered('sam') })

  // ---------------------------------------------------------------- fay
  await rig.waitTurns('fay', 2, { timeout: 60000 }).catch(() => null)
  const fay = chipOf('fay')
  const fayMail = mails('fay', `${FINISHED}%`)
  p.check('fay: a failed background command: the chip shows the output and the reason',
    fay.chip?.result === 'FAY-PARTIAL' && fay.chip?.error === 'process exited with status 3', fay)
  const fayKept = fay.item && rig.one(`SELECT c.tool_inputs->'${fay.item}'->'failed_shell_output'->>'output' AS out FROM ot.convo c
    WHERE c.agent_id = ${ids.fay} AND c.tool_inputs ? '${fay.item}'`)
  p.check('fay: its full failed output is kept for reading on demand, as for any failed shell call',
    fayKept?.out === 'FAY-PARTIAL' && Number.isInteger(fay.chip?.output_seq), { kept: fayKept, output_seq: fay.chip?.output_seq })
  p.check('fay: the wake says it failed and why, once; the admitted turn ran and took the result',
    fayMail.length === 1 && fayMail[0].body.includes('(it failed: process exited with status 3)') && rig.turns('fay').length === 2
      && said('fay', 'FAY-WOKEN') && allCancelled('fay') && delivered('fay').length === 1
      && delivered('fay')[0].how === "into the client's next turn" && delivered('fay')[0].into === log('fay', 'turn_start')[1]?.turn,
    { mail: fayMail, turns: rig.turns('fay'), delivered: delivered('fay') })

  // ---------------------------------------------------------------- hal
  await rig.op({ op: 'halt', nodes: ['hal'] })
  await rig.waitFor(() => mails('hal', '%did not finish%').length > 0, { what: 'hal told its command ended with its host', timeout: 20000 }).catch(() => null)
  const hal = chipOf('hal')
  const halMail = mails('hal', '%did not finish%')
  p.check('hal: while it ran, the desk counted it as background work', halHeld === 1, { halHeld })
  p.check('hal: halting stopped the host; the chip says the command ended with it',
    /^ended with its Muse host \(the host was stopped\) before it finished$/.test(hal.chip?.error ?? '') && hal.chip?.ended_at && !hal.chip?.result,
    hal)
  p.check('hal: the agent is told once that no result will arrive, naming the command',
    halMail.length === 1 && /A command you ran in the background did not finish: the Muse host running it stopped \(the host was stopped\)/.test(halMail[0].body)
      && halMail[0].body.includes('- powershell `npm run soak`') && !halMail[0].notice && !log('hal', 'tool_finished').length, halMail)
  p.check('hal: no turn ran while halted', rig.turns('hal').length === 1, rig.turns('hal'))
  await rig.op({ op: 'unhalt', nodes: ['hal'] })
  await rig.waitTurns('hal', 2, { timeout: 60000 }).catch(() => null)
  p.check('hal: unhalted, it read that message in its next turn', rig.turns('hal').length === 2 && said('hal', 'HAL-TOLD'), rig.turns('hal'))

  // ---------------------------------------------------------------- fro
  await rig.waitFor(() => mails('fro', '%did not finish%').length > 0, { what: 'fro told its command ended with its host', timeout: 20000 }).catch(() => null)
  const fro = chipOf('fro')
  const froRow = rig.agentRow('fro')
  const froMail = mails('fro', '%did not finish%')
  p.check('fro: frozen at a quota wall while the command ran', rig.turns('fro')[0]?.ended_at && rig.sql(`SELECT frozen IS NOT NULL AS f FROM ot.agents WHERE id = ${ids.fro}`)[0]?.f === true,
    { turn: rig.turns('fro')[0], frozen: froRow?.frozen })
  p.check('fro: Orgtree closes the host at a usage limit, so the command ended with it: the chip says so, and no result came',
    /^ended with its Muse host \(the host was closed\) before it finished$/.test(fro.chip?.error ?? '') && fro.chip?.ended_at && !fro.chip?.result
      && !log('fro', 'tool_finished').length, fro)
  p.check('fro: the agent is told once that no result will arrive; the message waits in its mailbox while it is frozen, and no turn ran',
    froMail.length === 1 && froMail[0].state === 'pending' && !froMail[0].notice
      && /the Muse host running it stopped \(the host was closed\)/.test(froMail[0].body) && froMail[0].body.includes('- powershell `npm run bench`')
      && rig.turns('fro').length === 1, { mail: froMail, turns: rig.turns('fro') })

  // ---------------------------------------------------------------- que: waits for a turn slot, its host alive
  await rig.waitFor(() => rig.sql('SELECT 1 FROM ot.turns WHERE ended_at IS NULL').length === 0, { what: 'no turn running before the slot phase', timeout: 60000 })
  await rig.api('PUT', '/api/app-settings/runtime', { max_concurrent_turns: 1 })
  await rig.userMail('que', 'PROOF-QUE: go.')
  await rig.waitTurns('que', 1, { timeout: 60000 })
  // kit's turn takes the only slot before que's command finishes (6 s after it started)
  await rig.userMail('kit', 'PROOF-KIT: hold the only turn slot.')
  await rig.waitFor(() => rig.sql(`SELECT 1 FROM ot.turns WHERE agent_id = ${ids.kit} AND ended_at IS NULL`).length > 0,
    { what: 'kit\'s turn to hold the slot', timeout: 20000 })
  const kitFirst = log('que', 'tool_finished').length === 0
  await rig.waitFor(() => mails('que', `${FINISHED}%`).length > 0, { what: 'que\'s wake', timeout: 30000 }).catch(() => null)
  // Muse's delivery turns keep coming meanwhile, each cancelled
  await sleep(3000)
  const slot = await deskRead('que', 'queued_for_slot', (v) => !!v, 5000)
  const queued = { kitFirst, chip: chipOf('que').chip ?? null, mail: mails('que', `${FINISHED}%`), slot,
    turns: rig.turns('que').length, wakes: wakes('que').length }
  await rig.api('POST', `/api/orgs/${rig.org}/nodes/kit/interrupt`)
  await rig.waitTurns('que', 2, { timeout: 60000 }).catch(() => null)
  await rig.api('PUT', '/api/app-settings/runtime', { max_concurrent_turns: 16 })
  p.check('que: its command finished while it waited for a turn slot: the chip got the result, and the wake waited in its mailbox',
    queued.kitFirst && queued.chip?.result === 'QUE-PROFILE-OK' && !queued.chip?.error && queued.mail.length === 1
      && queued.mail[0].state === 'pending' && !!queued.slot && queued.turns === 1, queued)
  const queStarts = log('que', 'turn_start')
  p.check('que: no turn ran while it waited: each turn Muse started was cancelled (none ran), and the result went into the turn admitted when the slot freed',
    queued.wakes >= 10 && allCancelled('que') && delivered('que').length === 1 && delivered('que')[0].how === "into the client's next turn"
      && delivered('que')[0].into === queStarts[1]?.turn && rig.turns('que').length === 2 && said('que', 'QUE-WOKEN'),
    { wakesWhileWaiting: queued.wakes, wakes: wakes('que').length, cancels: cancels('que').length, delivered: delivered('que'), turns: rig.turns('que') })
  const cancelLines = rig.engineLog().split('\n').filter((l) => CANCEL_LINES.some((t) => l.includes(t)) && /agent=que\b/.test(l))
  p.check('que: the cancels were warned about once, not one line each', cancels('que').length >= 10 && cancelLines.length === 1,
    { cancels: cancels('que').length, lines: cancelLines.length, sample: cancelLines.slice(0, 2) })

  p.keep(rig, { agents: AGENTS, grep: /background|cancelling turns the Muse host|cancelling a Muse turn|ended with their host|settled after its turn|followed past its turn|turn slot/i })
  return p.summary()
}
