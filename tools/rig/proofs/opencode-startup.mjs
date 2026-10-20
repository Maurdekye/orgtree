// Restart a running ACP turn before harness discovery has completed. Fake CLI,
// scratch database and synthetic key only; no provider calls or real sign-ins.
import fs from 'node:fs'
import path from 'node:path'
import { Proof } from '../proof.mjs'
import { setup as keysSetup } from './openrouter-keys.mjs'

export async function setup() { return { ...(await keysSetup()), name: 'opencode-startup', recover: true } }

export default async function (rig) {
  const p = new Proof('opencode-startup')
  const providers = () => rig.api('GET', '/api/providers')
  await rig.waitFor(async () => !(await providers()).checking, { what: 'initial discovery' })
  await rig.api('PUT', '/api/openrouter/keys/openrouter-1', { harness: 'opencode' })
  await rig.op({ op: 'hire', name: 'startup-acp', parent: 'boss', tier: 'or-rig-fake-model',
    grant: 1, title: 'ACP startup fixture' })
  await rig.userMail('startup-acp', 'Establish the synthetic ACP session')
  await rig.waitTurns('startup-acp', 1)
  const agent = rig.agentRow('startup-acp')
  const scratch = rig.one(`SELECT scratch_dir FROM ot.agents WHERE id=${agent.id}`).scratch_dir
  const fixture = path.join(scratch, 'acp-fixture.json')
  const set = doc => fs.writeFileSync(fixture, JSON.stringify(doc))
  const observed = () => fs.readFileSync(path.join(scratch, 'acp-observed.jsonl'), 'utf8')
    .trim().split(/\r?\n/).filter(Boolean).map(JSON.parse)
  const before = observed().length
  set({ text: 'BEFORE_CRASH', delayMs: 30000 })
  await rig.userMail('startup-acp', 'Begin the interrupted synthetic turn')
  await rig.waitFor(() => observed().length > before, { what: 'ACP prompt before crash' })
  const interrupted = observed().at(-1)
  const count = observed().length
  p.check('fixture has an active persisted ACP session', !!agent.session_id
    && interrupted.session === agent.session_id && rig.turns('startup-acp').some(t => !t.ended_at))

  // This existing fake CLI control delays the first discovery --version call.
  // ACP initialize is independent of it, so recovery can prove that it launches
  // before discovery, rather than just winning an uncontrolled scheduling race.
  const delay = path.join(rig.fakeDir, 'version-delay-ms')
  fs.writeFileSync(delay, '12000')
  await rig.crash()
  set({ text: 'AUTOMATIC_RESUME' })
  await rig.restart()
  let checking = (await providers()).checking
  p.check('restart is observed while provider discovery is pending', checking === true)
  // A refusal is a result too; preserve it as a measured failing assertion.
  await rig.waitFor(() => observed().length > count || rig.agentRow('startup-acp').last_error,
    { what: 'automatic recovery admission or refusal', timeout: 10000, every: 100 })
  const after = observed().at(-1)
  checking = (await providers()).checking
  p.check('recovery starts a fresh ACP process before discovery completes',
    after.pid !== interrupted.pid && checking === true,
    { interruptedPid: interrupted.pid, afterPid: after.pid, checking, error: rig.agentRow('startup-acp').last_error })
  p.check('automatic recovery loads the same native session',
    after.pid !== interrupted.pid && after.session === agent.session_id,
    { before: agent.session_id, after: after.session })
  // Remove the delay for subsequent probes, without truncating the already
  // sleeping first version process. No extra wake is sent before these checks.
  fs.unlinkSync(delay)
  if (after.pid !== interrupted.pid) await rig.waitTurns('startup-acp', 3)
  const node = `/api/orgs/${rig.org}/nodes/startup-acp`
  const chat = () => rig.api('GET', `${node}/chat`)
  p.check('automatic recovery finishes normally without an extra user wake',
    JSON.stringify(await chat()).includes('ACP_FIXTURE AUTOMATIC_RESUME')
    && !rig.turns('startup-acp').at(-1).error)
  p.check('recovered history is not replayed into the transcript',
    !JSON.stringify(await chat()).includes('REPLAY_MUST_NOT_APPEAR'))

  await rig.waitFor(async () => !(await providers()).checking, { what: 'delayed discovery finishes' })
  const completed = rig.turns('startup-acp').filter(t => t.ended_at).length
  set({ text: 'AFTER_DISCOVERY' })
  await rig.userMail('startup-acp', 'Post-discovery control')
  await rig.waitTurns('startup-acp', completed + 1)
  p.check('normal post-discovery ACP turn still succeeds',
    JSON.stringify(await chat()).includes('ACP_FIXTURE AFTER_DISCOVERY')
    && !rig.turns('startup-acp').at(-1).error)
  p.file('observed.json', observed())
  p.file('turns.json', rig.turns('startup-acp'))
  p.keep(rig, { grep: /OpenCode|ACP|recovery|not installed/ })
  return p.summary()
}
