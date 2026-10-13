// Proof on the REAL Muse Code: a shell command Muse moves to the background
// and that finishes after the turn reaches the agent (item
// muse-results-of-shell-commands-moved-to-the-back; small synthetic
// subscription turns, scratch only). One write seat (Spark, the lowest effort
// its catalog names):
//   turn 1: one powershell call that outlives its foreground wait, so Muse
//           moves it to the background, and the turn ends;
//   then:   the command finishes; its chip in turn 1 gets the output; the
//           agent, idle, is woken once through its mailbox (the note names
//           the command, not the output); each turn Muse starts by itself to
//           deliver the result is cancelled before any model step (Muse's own
//           session log is read for that, when the run used the user's own
//           login); the admitted turn knows exactly what the command printed.
// Run: node tools/rig/rig.mjs run tools/rig/proofs/muse-bg-result-real.mjs --real-muse <muse-bin-*.exe>

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Proof } from '../proof.mjs'

const FINISHED = 'Your background command has finished'

/** Muse's own session log, read for protocol facts only (record kinds, never text). */
function sessionFacts(sessionId) {
  if (!sessionId) return { found: false }
  const root = path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'muse', 'sessions')
  let file = null
  const walk = (dir, depth) => {
    if (file || depth > 4 || !fs.existsSync(dir)) return
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!e.isDirectory()) continue
      const p = path.join(dir, e.name)
      if (e.name === sessionId && fs.existsSync(path.join(p, 'session.jsonl'))) { file = path.join(p, 'session.jsonl'); return }
      walk(p, depth + 1)
    }
  }
  walk(root, 0)
  if (!file) return { found: false }
  const recs = []
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue
    let v; try { v = JSON.parse(line) } catch { continue }
    const kids = Array.isArray(v.children) ? v.children : []
    for (const c of kids) { try { recs.push(JSON.parse(c.record_json)) } catch {} }
    if (!kids.length && v.record_type) recs.push(v)
  }
  // runs in order: their origin (a delivery of Muse's inbox, or a client turn) and whether a model step ran
  const runs = []
  let cur = null
  for (const r of recs) {
    const e = r.payload?.event ?? {}
    if (r.payload_type === 'runtime.retained_fact' && /run_origin$/.test(r.payload?.record?.payload_type ?? '')) {
      cur = { origin: r.payload.record.payload_type, model: false, terminal: null }
      runs.push(cur)
    } else if (cur && e.kind === 'model_completed') cur.model = true
    else if (cur && e.kind === 'terminal') cur.terminal = e.reason ?? 'ended'
  }
  const drained = recs.filter((r) => r.payload?.event?.kind === 'inbox_item_drained' && r.payload.event.delivery_snapshot?.source?.source === 'background_task_terminal').length
  const wakes = runs.filter((r) => /^inbox_delivery/.test(r.origin))
  return { found: true, runs: runs.length, wakes: wakes.length, wakesWithModelStep: wakes.filter((r) => r.model).length,
           wakeEnds: [...new Set(wakes.map((r) => r.terminal))], drained }
}

export default async function (rig) {
  const p = new Proof('muse-bg-result-real')
  if (!rig.run.realMuse) throw new Error('run this proof with --real-muse <muse-bin-*.exe>')
  const mark = `BG-REAL-${Date.now() % 100000}`
  await rig.waitFor(() => rig.sql('SELECT 1 FROM ot.turns WHERE ended_at IS NULL').length === 0, { what: 'seed turns to settle', timeout: 60000 })
  const muse = await rig.waitFor(async () => (await rig.api('GET', '/api/providers'))?.providers?.find((x) => x.id === 'muse' && x.muse?.catalog),
    { what: 'Muse discovery', timeout: 120000 })
  const spark = (muse.tiers ?? []).find((t) => t.tier === 'spark')
  p.check('discovery: the real Muse Code, signed in, offering Spark', !!spark && muse.status?.connected === true, { tiers: (muse.tiers ?? []).map((t) => t.tier) })
  const effort = spark?.efforts?.[0] ?? ''
  await rig.op({ op: 'hire', parent: 'boss', name: 'bgr', tier: 'spark', title: 'Background result test', effort, account_fallback: false,
    tools: { edit: true, bash: true } })
  const id = rig.agentRow('bgr')?.id
  p.check('a write seat (shell) hired on Spark at its lowest effort', !!id, { effort })
  await rig.userMail('bgr', [
    'PROOF-BG-REAL: an automated test of your shell tool. Do exactly this, nothing else:',
    `Call your powershell tool once with the command: Start-Sleep -Seconds 12; Write-Output ${mark}`,
    'and with yield_time_ms set to 2000, so that it continues in the background.',
    'When the tool says it continues in the background, do not wait or poll: end your turn at once with a one-line reply.',
    'Later, when you are told the command finished, reply with one line quoting exactly what it printed, and use no tools.'].join('\n'))
  await rig.waitTurns('bgr', 1, { timeout: 300000 })
  await rig.waitTurns('bgr', 2, { timeout: 300000 }).catch(() => null)
  await rig.waitFor(() => rig.sql(`SELECT 1 FROM ot.turns WHERE agent_id = ${id} AND ended_at IS NULL`).length === 0, { what: 'bgr idle', timeout: 120000 }).catch(() => null)
  const turns = rig.sql(`SELECT id, error, killed, started_at, ended_at FROM ot.turns WHERE agent_id = ${id} ORDER BY id`)
  const rows = rig.sql(`SELECT body FROM ot.convo WHERE agent_id = ${id} ORDER BY seq`).map((r) => r.body)
  const shell = rows.flatMap((b) => b?.tools ?? []).find((c) => c.name === 'powershell')
  const replies = rows.filter((b) => b?.role === 'assistant' && b.text).map((b) => String(b.text))
  const mail = rig.sql(`SELECT m.body, m.notice, m.state FROM ot.mail m WHERE m.recipient_agent_id = ${id} AND m.body LIKE '${FINISHED}%' ORDER BY m.id`)
  const followed = rig.engineLog().split(/\r?\n/).filter((l) => /followed past its turn|settled after its turn|cancelling turns the Muse host started by itself/.test(l))
  const session = rig.one(`SELECT session_id FROM ot.agents WHERE id = ${id}`)?.session_id
  const facts = sessionFacts(session)
  p.file('observed.json', { mark, turns, shell, replies, mail, followed, facts })
  p.check('turn 1 ended with the command moved to the background (the engine followed it past its turn)',
    turns[0] && !turns[0].error && followed.some((l) => /followed past its turn/.test(l)), { turn: turns[0], followed })
  p.check('the command finished after turn 1, and its chip got the output',
    !!shell && String(shell.result ?? '').includes(mark) && !shell.error && Date.parse(shell.ended_at) > Date.parse(turns[0]?.ended_at),
    shell && { result: String(shell.result ?? '').slice(0, 200), ended_at: shell.ended_at, error: shell.error })
  p.check('the idle agent was woken once through its mailbox; the note names the command, not its output',
    mail.length === 1 && mail[0].body.includes('Start-Sleep -Seconds 12') && !mail[0].body.replace(`Write-Output ${mark}`, '').includes(mark) && !mail[0].notice,
    mail)
  p.check('the admitted turn knew exactly what the command printed', turns.length === 2 && !turns[1].error && replies.slice(1).some((t) => t.includes(mark)),
    { turns: turns.length, replies })
  p.check('no turn Muse started by itself reached a model step (Muse\'s session log), when the run used a readable session log',
    !facts.found || (facts.wakesWithModelStep === 0 && facts.drained === 1), facts)
  p.keep(rig, { agents: [], grep: /CLI started|background|cancelling turns|settled after its turn|followed past its turn/i })
  return p.summary()
}
