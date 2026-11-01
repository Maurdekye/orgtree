// Proof: a replacement CLI warming off the loop survives the actor's idle
//   exit (docket warm-the-replacement-cli-outside-the-agent-s-mes, reopened
//   2026-11-01 from the 4.5.3-alpha.4 engine log: on the user's real Save all
//   10 warmed CLIs died 1.8-2.7 s after starting, and the Save waited out its
//   2 s effort reply and reported an idle agent as busy).
//   ada (opus) has been idle with a parked CLI for longer than the actor's
//   60 s idle exit. Her effort is saved to high together with a new charter,
//   which replaces the CLI off the loop (the fake CLI takes 3 s to start).
//   1. the Save is answered at once, without "busy" (the actor is not gone
//      and holds no queue);
//   2. the CLI started for high is still running after its start-up, and it
//      is the one parked (the actor did not exit and cancel it);
//   3. her next mail's turn runs on that CLI: no second, cold start.
// Run: node tools/rig/rig.mjs run tools/rig/proofs/warm-idle-exit.mjs

import fs from 'node:fs'
import path from 'node:path'

import { SEED_SETTLE_TIMEOUT } from '../seed-settle.mjs'
import { Proof } from '../proof.mjs'

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
// the engine's ACTOR_IDLE_EXIT is 60 s: idle past it
const IDLE_MS = 65000
const WARM_MS = 3000

export async function setup() {
  return { name: 'warm-idle-exit', warming: true }
}

export default async function (rig) {
  const p = new Proof('warm-idle-exit')
  rig.scenario({ default: { turns: [{ name: 'default', steps: [{ text: 'OK.' }] }] } })
  await rig.waitFor(() => rig.sql('SELECT 1 FROM ot.turns WHERE ended_at IS NULL').length === 0, { what: 'seed turns to settle', timeout: SEED_SETTLE_TIMEOUT })
  await rig.api('POST', `/api/orgs/${rig.org}/settings`, { default_effort: 'medium' })
  await rig.op({ op: 'hire', name: 'ada', parent: 'boss', tier: 'opus', title: 'Idle-exit subject' })
  await rig.userMail('ada', 'Hello ada, start a session.')
  await rig.waitTurns('ada', 1)
  await rig.waitFor(() => !rig.turns('ada').some(t => !t.ended_at), { what: "ada's first turn to end" })

  const log = () => rig.fakeLog('ada')
  const starts = () => log().filter(l => l.kind === 'start')
  const turnPids = () => log().filter(l => l.kind === 'turn').map(l => l.pid)
  const alive = pid => { try { process.kill(pid, 0); return true } catch { return false } }
  await rig.waitFor(() => starts().length >= 1 && turnPids().length >= 1, { what: "ada's first CLI and turn in the fake log" })
  const parked = turnPids().at(-1)

  // idle past the actor's idle exit, her CLI parked
  await sleep(IDLE_MS)
  p.check(`her first CLI is still parked after ${IDLE_MS / 1000} s idle`, alive(parked), { pid: parked })
  fs.writeFileSync(path.join(rig.fakeDir, 'initialize-delay-ms'), String(WARM_MS))

  const before = starts().length
  const t0 = Date.now()
  const r = await rig.api('POST', `/api/orgs/${rig.org}/nodes/ada/scope`, { effort: 'high', charter: 'Idle-exit subject, edited.' })
  const saveMs = Date.now() - t0
  const d = r?.effort_delivery
  p.check('the Save is answered within 1.5 s, and not as "busy"', saveMs < 1500 && d?.effort === 'high' && !/busy/i.test(d?.reason || ''),
    { save_ms: saveMs, effort_delivery: d })

  await rig.waitFor(() => starts().length > before, { what: 'the replacement CLI to start', timeout: 30000 })
  await sleep(WARM_MS + 3000)
  const warm = starts().slice(before)
  const w = warm[0]
  p.check('one replacement CLI was started, for high', warm.length === 1 && w?.effort === 'high', warm.map(s => ({ pid: s.pid, effort: s.effort })))
  p.check('it is still running after its start-up (the idle exit did not cancel it)', !!w && alive(w.pid), { pid: w?.pid, alive: w && alive(w.pid) })
  p.check('the replaced CLI exited', !alive(parked), { pid: parked })

  const turns = rig.turns('ada').length
  await rig.userMail('ada', 'IDLE-A: mail after the replacement.')
  await rig.waitTurns('ada', turns + 1, { timeout: 60000 })
  await rig.waitFor(() => turnPids().length > 1, { what: "the new turn in the fake log" })
  const ran = turnPids().at(-1)
  const after = starts().slice(before)
  p.check('her next turn ran on that warmed CLI, with no second start', ran === w?.pid && after.length === 1,
    { turn_pid: ran, started: after.map(s => ({ pid: s.pid, effort: s.effort })) })

  fs.rmSync(path.join(rig.fakeDir, 'initialize-delay-ms'), { force: true })
  p.keep(rig, { agents: ['ada'], grep: /launch|warm|replac|effort|idle exit|actor/i })
  return p.summary()
}
