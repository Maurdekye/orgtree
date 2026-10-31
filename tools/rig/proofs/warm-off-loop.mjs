// Proof: a replacement CLI warms off the agent's message loop (docket
//   warm-the-replacement-cli-outside-the-agent-s-mes; user 2026-10-31
//   m405acb968af7 "Yes, in 4.5.3"). Fake CLIs, warming on, and a CLI made
//   slow to start (`initialize-delay-ms` in the fake CLI's folder: 10 s, the
//   8-12 s the alpha.3 logs measured for a real replacement).
//   1. ada (opus) is idle with a parked CLI; her effort is saved to high,
//      which replaces it; mail sent 1.5 s into the warm-up starts her turn at
//      once (it waited for the whole warm-up before), on the one CLI launched
//      for high; a second mail sent during the warm-up is delivered too, in
//      order.
//   2. a second change during the warm-up supersedes the first: low, then
//      max 1.5 s later; her next turn runs on a max CLI, again without
//      waiting for either warm-up to end first, and the CLI started for low
//      exits (no orphan).
// Run: node tools/rig/rig.mjs run tools/rig/proofs/warm-off-loop.mjs

import fs from 'node:fs'
import path from 'node:path'

import { SEED_SETTLE_TIMEOUT } from '../seed-settle.mjs'
import { Proof } from '../proof.mjs'

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const WARM_MS = 10000
// a turn admitted from a warm-up's start: well under the warm-up itself
const PROMPT_MS = 3000

export async function setup() {
  // a safe start warms nothing; the replacement is a warm-up
  return { name: 'warm-off-loop', warming: true }
}

export default async function (rig) {
  const p = new Proof('warm-off-loop')
  rig.scenario({ default: { turns: [{ name: 'default', steps: [{ text: 'OK.' }] }] } })
  await rig.waitFor(() => rig.sql('SELECT 1 FROM ot.turns WHERE ended_at IS NULL').length === 0, { what: 'seed turns to settle', timeout: SEED_SETTLE_TIMEOUT })
  await rig.api('POST', `/api/orgs/${rig.org}/settings`, { default_effort: 'medium' })
  await rig.op({ op: 'hire', name: 'ada', parent: 'boss', tier: 'opus', title: 'Warm-up subject' })
  await rig.userMail('ada', 'Hello ada, start a session.')
  await rig.waitTurns('ada', 1)

  const log = () => rig.fakeLog('ada')
  const starts = () => log().filter(l => l.kind === 'start')
  const turnPids = () => log().filter(l => l.kind === 'turn').map(l => l.pid)
  const scope = effort => rig.api('POST', `/api/orgs/${rig.org}/nodes/ada/scope`, { effort })
  const alive = pid => { try { process.kill(pid, 0); return true } catch { return false } }
  const delay = path.join(rig.fakeDir, 'initialize-delay-ms')
  // mail at `sentAt` started the turn after `before` turns: how long it waited
  const waited = async (before, sentAt, what) => {
    const t = await rig.waitFor(() => rig.turns('ada')[before], { what, timeout: 90000 })
    return Date.parse(t.started_at) - sentAt
  }
  await rig.waitFor(() => starts().length >= 1 && turnPids().length >= 1, { what: "ada's first CLI and turn in the fake log" })
  fs.writeFileSync(delay, String(WARM_MS))

  // ---- 1. mail during a replacement's warm-up
  const turns1 = rig.turns('ada').length
  const starts1 = starts().length
  const r1 = await scope('high')
  p.check('the effort save is answered: {next_turn, high}', r1?.effort_delivery?.delivery === 'next_turn' && r1?.effort_delivery?.effort === 'high', r1?.effort_delivery)
  await sleep(1500)
  const sent1 = Date.now()
  await rig.userMail('ada', 'WARM-A: mail during the warm-up.')
  await sleep(200)
  await rig.userMail('ada', 'WARM-B: more mail during the warm-up.')
  const wait1 = await waited(turns1, sent1, "ada's turn for the mail sent during the warm-up")
  p.check(`mail sent 1.5 s into a ${WARM_MS / 1000} s warm-up starts her turn within ${PROMPT_MS / 1000} s (it waited for the whole warm-up before)`,
    wait1 < PROMPT_MS, { waited_ms: wait1 })
  await rig.waitFor(() => rig.sql(`SELECT 1 FROM ot.mail m JOIN ot.agents a ON a.id = m.recipient_agent_id
                                     WHERE a.name = 'ada' AND m.state = 'pending'`).length === 0
                         && !rig.turns('ada').some(t => !t.ended_at), { what: 'both warm-up mails delivered', timeout: 120000 })
  const mails = rig.sql(`SELECT m.id, m.turn_id, m.state, m.body FROM ot.mail m JOIN ot.agents a ON a.id = m.recipient_agent_id
                          WHERE a.name = 'ada' AND (m.body LIKE 'WARM-A%' OR m.body LIKE 'WARM-B%') ORDER BY m.id`)
  p.check('both mails sent during the warm-up were delivered, in order', mails.length === 2 && mails.every(m => m.turn_id)
    && mails[0].body.startsWith('WARM-A') && Number(mails[0].turn_id) <= Number(mails[1].turn_id), mails.map(m => ({ turn: m.turn_id, state: m.state, body: m.body.slice(0, 6) })))
  const new1 = starts().slice(starts1)
  const pid1 = turnPids().at(-1)
  p.check('her turn ran on the one CLI launched for high (no second, cold start)',
    new1.length === 1 && new1[0].effort === 'high' && new1[0].pid === pid1, { started: new1.map(s => ({ pid: s.pid, effort: s.effort })), turn_pid: pid1 })

  // ---- 2. a second change during the warm-up supersedes the first
  const turns2 = rig.turns('ada').length
  const starts2 = starts().length
  await scope('low')
  await sleep(1500)
  await scope('max')
  await sleep(1000)
  const sent2 = Date.now()
  await rig.userMail('ada', 'WARM-C: mail after two changes.')
  const wait2 = await waited(turns2, sent2, "ada's turn after two changes")
  p.check(`with two changes under way her turn still starts within ${PROMPT_MS / 1000} s`, wait2 < PROMPT_MS, { waited_ms: wait2 })
  await rig.waitTurns('ada', turns2 + 1, { timeout: 120000 })
  const pid2 = turnPids().at(-1)
  const new2 = starts().slice(starts2)
  const ran = new2.find(s => s.pid === pid2)
  p.check('her turn ran on a CLI started with max', ran?.effort === 'max', { started: new2.map(s => ({ pid: s.pid, effort: s.effort })), turn_pid: pid2 })
  const low = new2.filter(s => s.effort === 'low')
  if (low.length) {
    await rig.waitFor(() => low.every(s => !alive(s.pid)), { what: 'the CLI started for low to exit', timeout: 30000 }).catch(() => null)
  }
  p.check('no CLI started for the superseded level is left running', low.every(s => !alive(s.pid)),
    low.map(s => ({ pid: s.pid, alive: alive(s.pid) })))

  fs.rmSync(delay, { force: true })
  p.keep(rig, { agents: ['ada'], grep: /launch|warm|replac|effort/i })
  return p.summary()
}
