// Regression control: run this same proof at 2bf5e71 (expected 1 pass / 2 fails)
// and at the fix. Both runs use the existing fake CLI; no real profile or CLI.
import fs from 'node:fs'
import path from 'node:path'
import { Proof } from '../proof.mjs'

export default async function (rig) {
  const p = new Proof('skills-idle')
  const source = path.join(rig.data, 'rig-home', '.claude/skills/idle-control')
  fs.mkdirSync(source, { recursive: true })
  fs.writeFileSync(path.join(source, 'SKILL.md'), '---\nname: idle-control\ndescription: Idle stability control\n---\nUNCHANGED SKILL\n')
  const refresh = () => rig.api('POST', '/api/skills/refresh')
  const initial = await refresh()
  rig.scenario({ default: { turns: [{ name: 'default', steps: [{ text: 'OK.' }] }] } })
  await rig.op({ op: 'hire', name: 'skillidle', parent: 'boss', tier: 'haiku', title: 'Skill idle control', grant: 1 })
  const starts = () => rig.fakeLog('skillidle').filter(x => x.kind === 'start')
  const turn = async () => {
    const count = rig.turns('skillidle').filter(x => x.ended_at).length
    await rig.userMail('skillidle', 'Idle control turn.')
    await rig.waitTurns('skillidle', count + 1)
  }
  const alive = pid => { try { process.kill(pid, 0); return true } catch { return false } }
  await turn()
  const first = starts().at(-1)
  const count = starts().length
  const root = first?.add_dirs?.find(x => x.replaceAll('\\', '/').includes('/shared-skills/'))
  const entry = root && path.join(root, '.claude/skills/idle-control/SKILL.md')
  const bytes = entry && fs.readFileSync(entry, 'utf8')
  p.check('control: a parked CLI loaded the shared skill', !!initial.digest && alive(first?.pid) && bytes?.includes('UNCHANGED SKILL'))
  for (let cycle = 1; cycle <= 2; cycle++) {
    const refreshed = await refresh()
    // Span the actual actor timer, not a simulated fingerprint calculation.
    await new Promise(resolve => setTimeout(resolve, 22000))
    const stayedAlive = alive(first?.pid)
    const snap = await rig.api('GET', `/api/orgs/${rig.org}/records`)
    const forecast = snap?.runtime?.agents?.[String(rig.agentRow('skillidle').id)]?.cache_forecast
    await turn()
    const current = starts().at(-1)
    p.check(`unchanged refresh cycle ${cycle}: same fingerprint, bytes and parked process after idle timer and next turn`,
      refreshed.digest === initial.digest && !!forecast && !(forecast.changed_inputs ?? []).includes('startup') &&
      stayedAlive && alive(first?.pid) && current?.pid === first?.pid && starts().length === count &&
      !!entry && fs.readFileSync(entry, 'utf8') === bytes,
      { originalPid: first?.pid, currentPid: current?.pid, startsBefore: count, startsAfter: starts().length,
        stayedAlive, changedInputs: forecast?.changed_inputs ?? null, digestUnchanged: refreshed.digest === initial.digest })
  }
  p.keep(rig, { agents: ['skillidle'] })
  return p.summary()
}
