// Proof: background work keeps an agent's process open (user 2026-10-14,
// gap 11: "keep open", Muse and Claude Code). With warming off a turn's end
// does not close the process while a command it ran in the background still
// runs or its result is still owed to the agent; switching warming off or the
// idle cap evicting it does not close it either; a process held this way is
// outside the idle cap (neither counted nor evicted); it closes once the work
// is over. The idle cap is 1 in this run (`maxParked`), so the cap acts.
//   kc1: warming on: its process, parked with a command running, is evicted
//        by the cap when kc2 parks: it is held instead (proc_held), not
//        closed; kc3 parking next evicts kc2, not kc1 (a held process does
//        not count); the result reaches kc1 on the same process.
//   kco: warming switched off while its parked process runs a command: the
//        other processes close, kco's is held; the result reaches it; after
//        that turn (warming off now) the process closes.
//   kcl: Claude, warming off: its turn's end holds the process (bg_tasks 1);
//        the command's end reaches it (chip, the CLI's own turn interrupted,
//        one wake); the woken turn runs on the same process, after which the
//        process closes by itself (its input closed, no kill).
//   kmu: Muse, warming off: the same on the fake `muse serve`.
//   krc: Muse, warming off: the result settles during a later turn's last
//        model step: that turn's end holds the host for a short grace, the
//        turn Muse starts by itself shows the result was not taken, the agent
//        is woken once and the result goes into its next turn, same host.
//   ked: Claude, warming off: an edit of its startup file while it is held
//        does not replace the process (that would end the command); the
//        result reaches it; its next turn starts a fresh process (the edit).
// Run: node tools/rig/rig.mjs run tools/rig/proofs/bg-keep-open.mjs

import fs from 'node:fs'
import path from 'node:path'
import { Proof } from '../proof.mjs'

export async function setup() {
  return { maxParked: 1 }
}

const CLAUDE = ['kc1', 'kc2', 'kc3', 'kco', 'kcl', 'ked']
const MUSE = ['kmu', 'krc']
const AGENTS = [...CLAUDE, ...MUSE]
const FINISHED = 'Your background command has finished'
const OWN = "into an interrupted turn of the CLI's own"
const NEXT = "into the client's next turn"
const BG = (task, command, extra) => ({ bg: { task, id: `toolu_${task}`, command, ...extra } })
const MBG = (command, extra) => ({ tool: 'powershell', args: { command }, silent_ms: 600000, background_ms: 300, ...extra })
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export default async function (rig) {
  const p = new Proof('bg-keep-open')
  rig.scenario({
    agents: {
      kc1: { turns: [
        { name: 'long background job', match: 'PROOF-KC1', once: true, steps: [
          BG('bkc1', 'npm run soak', { finish_ms: 25000, output: 'KC1-SOAK-OK\n' }), { text: 'The soak runs in the background.' }] },
        { name: 'woken', match: FINISHED, once: true, steps: [{ text: 'KC1-WOKEN' }] }] },
      kco: { turns: [
        { name: 'background job', match: 'PROOF-KCO', once: true, steps: [
          BG('bkco', 'npm run bench', { finish_ms: 12000, output: 'KCO-BENCH-OK\n' }), { text: 'The bench runs in the background.' }] },
        { name: 'woken', match: FINISHED, once: true, steps: [{ text: 'KCO-WOKEN' }] }] },
      kcl: { turns: [
        { name: 'background job', match: 'PROOF-KCL', once: true, steps: [
          BG('bkcl', 'npm run build', { finish_ms: 8000, output: 'KCL-BUILD-OK\n' }), { text: 'The build runs in the background.' }] },
        { name: 'woken', match: FINISHED, once: true, steps: [{ text: 'KCL-WOKEN' }] }] },
      ked: { turns: [
        { name: 'background job', match: 'PROOF-KED', once: true, steps: [
          BG('bked', 'npm run docs', { finish_ms: 45000, output: 'KED-DOCS-OK\n' }), { text: 'The docs build runs in the background.' }] },
        { name: 'woken', match: FINISHED, once: true, steps: [{ text: 'KED-WOKEN' }] }] },
      kmu: { turns: [
        { name: 'background job', match: 'PROOF-KMU', once: true, steps: [
          MBG('npm run build', { finish_ms: 8000, output: 'KMU-BUILD-OK' }), { text: 'The build runs in the background.' }] },
        { name: 'woken', match: FINISHED, once: true, steps: [{ text: 'KMU-WOKEN' }] }] },
      krc: { turns: [
        { name: 'background job', match: 'PROOF-KRC-1', once: true, steps: [
          MBG('npm run lint', { finish_ms: 6000, output: 'KRC-LINT-OK', miss_running_turn: true }), { text: 'Lint runs in the background.' }] },
        { name: 'later turn', match: 'PROOF-KRC-2', once: true, steps: [{ text: 'Thinking it over.' }, { sleep_ms: 10000 }, { text: 'KRC-T2-DONE' }] },
        { name: 'woken', match: FINISHED, once: true, steps: [{ text: 'KRC-WOKEN' }] }] },
    },
    default: { turns: [{ name: 'default', steps: [{ text: 'OK.' }] }] },
  })
  const runtime = (body) => rig.api('PUT', '/api/app-settings/runtime', body)
  await rig.waitFor(() => rig.sql('SELECT 1 FROM ot.turns WHERE ended_at IS NULL').length === 0, { what: 'seed turns to settle', timeout: 60000 })
  await rig.waitFor(async () => (await rig.api('GET', '/api/providers'))?.providers?.find((x) => x.id === 'muse' && x.muse?.catalog),
    { what: 'Muse discovery', timeout: 60000 })
  for (const name of CLAUDE) await rig.op({ op: 'hire', name, parent: 'boss', tier: 'haiku', title: 'Keep-open agent' })
  for (const name of MUSE) await rig.op({ op: 'hire', name, parent: 'boss', tier: 'wonder', title: 'Keep-open agent' })
  const ids = Object.fromEntries(AGENTS.map((a) => [a, rig.agentRow(a)?.id]))
  p.check('six Claude and two Muse agents hired', Object.values(ids).every(Boolean), ids)

  const log = (agent, kind) => rig.fakeLog(agent).filter((l) => !kind || l.kind === kind)
  const convo = (agent) => rig.sql(`SELECT body FROM ot.convo WHERE agent_id = ${ids[agent]} ORDER BY seq`).map((r) => r.body)
  const chips = (agent) => convo(agent).flatMap((b) => b?.tools ?? [])
  const chipOf = (agent, id) => chips(agent).find((c) => c.id === id) ?? null
  const museChip = (agent) => chipOf(agent, log(agent, 'tool_background')[0]?.item)
  const said = (agent, text) => convo(agent).some((b) => b?.role === 'assistant' && String(b.text ?? '').includes(text))
  const mails = (agent, like) => rig.sql(`SELECT m.uid, m.sender, m.notice, m.state, m.body FROM ot.mail m
    WHERE m.recipient_agent_id = ${ids[agent]} AND m.body LIKE '${like.replace(/'/g, "''")}' ORDER BY m.id`)
  const delivered = (agent) => log(agent, 'bg_delivered')
  // the processes an agent's turns ran on (every fake log line carries its process's pid)
  const turnPids = (agent) => log(agent, 'turn').map((l) => l.pid)
  const find = (nodes, name) => {
    for (const n of nodes ?? []) {
      if (n.id === name) return n
      const kid = find(n.children, name)
      if (kid) return kid
    }
    return null
  }
  const tree = async () => (await rig.api('GET', `/api/orgs/${rig.org}`))?.roots
  const nodeOf = async (agent) => find(await tree(), agent)
  const deskRead = async (agent, field, ok, timeout = 3000) => {
    let last = null
    await rig.waitFor(async () => { last = (await nodeOf(agent))?.[field] ?? null; return ok(last) },
      { what: `${agent}'s ${field} on the desk`, timeout, every: 200 }).catch(() => null)
    return last
  }
  const desk = async (agent) => {
    const n = await nodeOf(agent)
    return { live: n?.proc_live ?? null, held: n?.proc_held ?? null, bg: n?.bg_tasks ?? null, relaunch: n?.proc_relaunch ?? null }
  }
  await rig.waitFor(async () => { const roots = await tree(); return AGENTS.every((a) => find(roots, a)) },
    { what: 'the hired agents on the desk', timeout: 30000, every: 250 }).catch(() => null)

  // ---------------------------------------------------------------- kc1: the cap evicts a parked process running a command
  // (the rig starts no CLI at a hire, SAFE_START: a turn's end parks one, warming being on)
  await rig.userMail('kc1', 'PROOF-KC1: go.')
  await rig.waitTurns('kc1', 1, { timeout: 60000 })
  const kc1Parked = await deskRead('kc1', 'proc_live', (v) => v === true)
  await rig.userMail('kc2', 'PROOF-KC2: say OK.')
  await rig.waitTurns('kc2', 1, { timeout: 60000 })
  // kc2 parks after kc1: past the cap, the one parked longest (kc1) is asked to close
  await deskRead('kc1', 'proc_held', (v) => v === true, 10000)
  const kc1Evicted = await desk('kc1')
  const kc2Parked = await desk('kc2')
  p.check('kc1: evicted by the idle cap with a command running, its process is held open instead of closed',
    kc1Parked === true && kc1Evicted.held === true && kc1Evicted.live === true && kc1Evicted.bg === 1 && kc2Parked.live === true,
    { kc1Parked, kc1: kc1Evicted, kc2: kc2Parked })
  await rig.userMail('kc3', 'PROOF-KC3: say OK.')
  await rig.waitTurns('kc3', 1, { timeout: 60000 })
  // kc3 parks next: the cap evicts kc2, as the held kc1 does not count
  await deskRead('kc2', 'proc_live', (v) => v === false, 10000)
  const capped = { kc1: await desk('kc1'), kc2: await desk('kc2'), kc3: await desk('kc3') }
  p.check('kc1: a held process does not count toward the cap: kc3 parking evicted kc2, and kc1 stays open',
    capped.kc2.live === false && capped.kc1.held === true && capped.kc1.live === true && capped.kc3.live === true, capped)
  await rig.waitTurns('kc1', 2, { timeout: 60000 }).catch(() => null)
  const kc1 = chipOf('kc1', 'toolu_bkc1')
  p.check("kc1: the command's end reached it on that same process: chip, the CLI's own turn interrupted, one wake, its admitted turn",
    kc1?.result === 'KC1-SOAK-OK\n' && delivered('kc1')[0]?.how === OWN && mails('kc1', `${FINISHED}%`).length === 1
      && rig.turns('kc1').length === 2 && said('kc1', 'KC1-WOKEN') && new Set(turnPids('kc1')).size === 1,
    { chip: kc1, delivered: delivered('kc1'), pids: turnPids('kc1'), turns: rig.turns('kc1').length })

  // ---------------------------------------------------------------- kco: warming switched off while its parked process runs a command
  await rig.userMail('kco', 'PROOF-KCO: go.')
  await rig.waitTurns('kco', 1, { timeout: 60000 })
  const kcoParked = await deskRead('kco', 'proc_live', (v) => v === true)
  await runtime({ warming_enabled: false })
  await deskRead('kco', 'proc_held', (v) => v === true, 10000)
  await sleep(2000)
  const kcoHeld = await desk('kco')
  const stillLive = []
  for (const a of AGENTS.filter((x) => x !== 'kco')) if ((await desk(a)).live) stillLive.push(a)
  p.check('kco: warming switched off closed the parked processes, but its command keeps its process open (held)',
    kcoParked === true && kcoHeld.held === true && kcoHeld.live === true && stillLive.length === 0, { kcoParked, kco: kcoHeld, stillLive })
  await rig.waitTurns('kco', 2, { timeout: 60000 }).catch(() => null)
  await deskRead('kco', 'proc_live', (v) => v === false, 10000)
  const kcoAfter = await desk('kco')
  p.check("kco: the command's end reached it on that same process, and after that turn (warming off) the process closed",
    chipOf('kco', 'toolu_bkco')?.result === 'KCO-BENCH-OK\n' && mails('kco', `${FINISHED}%`).length === 1 && said('kco', 'KCO-WOKEN')
      && new Set(turnPids('kco')).size === 1 && kcoAfter.live === false && kcoAfter.held === false,
    { pids: turnPids('kco'), after: kcoAfter })

  // ---------------------------------------------------------------- warming off from here on
  for (const [name, mark] of [['kcl', 'PROOF-KCL'], ['kmu', 'PROOF-KMU'], ['krc', 'PROOF-KRC-1'], ['ked', 'PROOF-KED']]) {
    await rig.userMail(name, `${mark}: go.`)
  }
  await rig.waitTurns('kcl', 1, { timeout: 60000 })
  await deskRead('kcl', 'proc_held', (v) => v === true, 5000)
  const kclHeld = await desk('kcl')
  await rig.waitTurns('kmu', 1, { timeout: 60000 })
  await deskRead('kmu', 'proc_held', (v) => v === true, 5000)
  const kmuHeld = await desk('kmu')
  // krc's later turn starts at once and still runs when its command finishes (6 s after it started)
  await rig.waitTurns('krc', 1, { timeout: 60000 })
  await deskRead('krc', 'proc_held', (v) => v === true, 5000)
  const krcHeld = await desk('krc')
  await rig.userMail('krc', 'PROOF-KRC-2: next task.')
  await rig.waitTurns('ked', 1, { timeout: 60000 })
  await deskRead('ked', 'proc_held', (v) => v === true, 5000)
  const kedHeld = await desk('ked')
  const kedPid = turnPids('ked')[0]
  // an edit of ked's startup file (its folder's CLAUDE.md) while its process is held
  const kedCwd = log('ked', 'start').filter((l) => l.pid === kedPid).at(-1)?.cwd
  if (kedCwd) fs.writeFileSync(path.join(kedCwd, 'CLAUDE.md'), '# ked\nAn edit made while its process is held.\n')
  const editedAt = Date.now()

  // ---------------------------------------------------------------- kcl
  p.check("kcl: with warming off, its turn's end keeps the process open while the command runs (held, counted as background work)",
    kclHeld.held === true && kclHeld.live === true && kclHeld.bg === 1, kclHeld)
  await rig.waitTurns('kcl', 2, { timeout: 60000 }).catch(() => null)
  await deskRead('kcl', 'proc_live', (v) => v === false, 10000)
  const kclAfter = await desk('kcl')
  const kclPids = [...new Set(turnPids('kcl'))]
  p.check("kcl: the command's end reached it (chip, the CLI's own turn interrupted, one wake), and the woken turn ran on the same process",
    chipOf('kcl', 'toolu_bkcl')?.result === 'KCL-BUILD-OK\n' && delivered('kcl')[0]?.how === OWN && mails('kcl', `${FINISHED}%`).length === 1
      && said('kcl', 'KCL-WOKEN') && kclPids.length === 1, { pids: kclPids, delivered: delivered('kcl') })
  const kclExit = log('kcl', 'exit').filter((l) => l.pid === kclPids[0])
  p.check('kcl: after that turn the process closed by itself (its input closed, no kill) and is no longer held',
    kclAfter.live === false && kclAfter.held === false && kclExit.length === 1 && kclExit[0].why === 'stdin closed', { after: kclAfter, exit: kclExit })

  // ---------------------------------------------------------------- kmu
  p.check("kmu: with warming off, the Muse host stays open after the turn while the command runs (held, counted as background work)",
    kmuHeld.held === true && kmuHeld.live === true && kmuHeld.bg === 1, kmuHeld)
  await rig.waitTurns('kmu', 2, { timeout: 60000 }).catch(() => null)
  await deskRead('kmu', 'proc_live', (v) => v === false, 10000)
  const kmuAfter = await desk('kmu')
  const kmuStarts = log('kmu', 'turn_start')
  const kmuMail = mails('kmu', `${FINISHED}%`)
  p.check("kmu: the command's end reached it on the same host (chip, one wake, the result in its admitted turn); then the host closed",
    museChip('kmu')?.result === 'KMU-BUILD-OK' && kmuMail.length === 1 && /has finished \(it completed\): powershell `npm run build`/.test(kmuMail[0].body)
      && delivered('kmu')[0]?.how === NEXT && delivered('kmu')[0]?.into === kmuStarts[1]?.turn && said('kmu', 'KMU-WOKEN')
      && new Set(turnPids('kmu')).size === 1 && kmuAfter.live === false && kmuAfter.held === false,
    { chip: museChip('kmu'), mail: kmuMail, delivered: delivered('kmu'), pids: turnPids('kmu'), after: kmuAfter })

  // ---------------------------------------------------------------- krc
  await rig.waitTurns('krc', 3, { timeout: 90000 }).catch(() => null)
  await deskRead('krc', 'proc_live', (v) => v === false, 10000)
  const krcAfter = await desk('krc')
  const krcStarts = log('krc', 'turn_start')
  const krcMail = mails('krc', `${FINISHED}%`)
  p.check("krc: held after its first turn while the command ran", krcHeld.held === true && krcHeld.live === true, krcHeld)
  p.check("krc: the result settled during the later turn's last model step, which did not take it (the fake says so); its chip got it",
    log('krc', 'bg_missed_turn').length === 1 && museChip('krc')?.result === 'KRC-LINT-OK', { missed: log('krc', 'bg_missed_turn'), chip: museChip('krc') })
  p.check("krc: the turn Muse started by itself after it showed that: the agent was woken once and the result went into its next turn, on the same host",
    krcMail.length === 1 && rig.turns('krc').length === 3 && said('krc', 'KRC-WOKEN') && delivered('krc').length === 1
      && delivered('krc')[0].how === NEXT && delivered('krc')[0].into === krcStarts[2]?.turn && new Set(turnPids('krc')).size === 1,
    { mail: krcMail, delivered: delivered('krc'), starts: krcStarts.map((s) => s.turn), pids: turnPids('krc') })
  p.check('krc: after that turn the host closed', krcAfter.live === false && krcAfter.held === false, krcAfter)

  // ---------------------------------------------------------------- ked
  // the engine re-reads an idle agent's startup files every 20 s; its command runs 45 s
  await sleep(Math.max(0, editedAt + 26000 - Date.now()))
  const kedEdited = await desk('ked')
  const kedLater = log('ked', 'start').filter((l) => l.pid !== kedPid && l.ts > (log('ked', 'turn')[0]?.ts ?? ''))
  p.check('ked: an edit of its startup file did not replace the held process (that would end the command); the desk says the next turn starts a fresh one',
    !!kedCwd && kedHeld.held === true && kedEdited.held === true && kedEdited.live === true && kedEdited.relaunch === true && kedLater.length === 0
      && !log('ked', 'exit').some((l) => l.pid === kedPid), { before: kedHeld, after: kedEdited, starts: kedLater.length })
  await rig.waitTurns('ked', 2, { timeout: 60000 }).catch(() => null)
  const kedPids = turnPids('ked')
  const kedFresh = log('ked', 'start').filter((l) => l.pid === kedPids[1])
  p.check("ked: the command's end reached it (chip, one wake), and its next turn started a fresh process resuming the session",
    chipOf('ked', 'toolu_bked')?.result === 'KED-DOCS-OK\n' && mails('ked', `${FINISHED}%`).length === 1 && said('ked', 'KED-WOKEN')
      && kedPids.length === 2 && kedPids[0] !== kedPids[1] && kedFresh[0]?.resumed === true, { pids: kedPids, fresh: kedFresh })

  p.keep(rig, { agents: AGENTS, grep: /background|stays open|kept open|started by itself|not taken by it|evicted|cli\.evicted/i })
  return p.summary()
}
