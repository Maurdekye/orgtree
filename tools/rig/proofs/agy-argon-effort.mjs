// Synthetic only: provider offers -> saved setting -> actual fake-AGY argv.
// This proves Orgtree delivery, not Google's inference behavior or account availability.
import fs from 'node:fs'
import path from 'node:path'
import { Proof } from '../proof.mjs'

export default async function (rig) {
  const p = new Proof('agy-argon-effort')
  rig.scenario({ default: { turns: [{ name: 'default', steps: [{ text: 'OK.' }] }] } })
  await rig.waitFor(() => rig.sql('SELECT 1 FROM ot.turns WHERE ended_at IS NULL').length === 0,
    { what: 'seed turns to settle', timeout: 60000 })
  fs.writeFileSync(path.join(rig.fakeDir, 'agy-models.txt'),
    'gemini-4-argon-low\tGemini 4 Argon (Low)\n'
    + 'gemini-4-argon-medium\tGemini 4 Argon (Medium)\n'
    + 'gemini-4-argon-high\tGemini 4 Argon (High)\n')
  // Discovery has a 30-second reuse window. Retry through its ordinary API.
  await rig.waitFor(async () => {
    await rig.api('POST', '/api/providers/agy-models/refresh')
    const providers = (await rig.api('GET', '/api/providers')).providers ?? []
    return providers.find(x => x.id === 'google')?.tiers?.some(t => t.tier === 'argon')
  }, { what: 'synthetic Argon registry to be offered', timeout: 60000 })

  await rig.op({ op: 'hire', name: 'argon-effort', parent: 'boss', tier: 'argon',
    effort: 'high', title: 'Synthetic Argon effort subject' })
  const name = 'argon-effort'
  await rig.userMail(name, 'ARGON-HIGH')
  await rig.waitTurns(name, 1)
  const starts = () => rig.fakeLog(name).filter(l => l.kind === 'start')
  const flag = (start, key) => {
    const args = start?.args ?? []
    const i = args.indexOf(key)
    return i < 0 ? null : args[i + 1]
  }
  const high = starts().at(-1)
  p.check('control: high reaches the AGY launch', flag(high, '--effort') === 'high'
    && flag(high, '--model') === 'gemini-4-argon', high)
  let error = null
  try {
    await rig.api('POST', `/api/orgs/${rig.org}/nodes/${name}/scope`, { effort: 'medium' })
  } catch (e) { error = String(e.message ?? e) }
  p.check('Argon accepts a saved medium effort selection', error === null, error)
  if (error !== null) return p.summary()

  const count = rig.turns(name).filter(t => t.ended_at).length
  await rig.userMail(name, 'ARGON-MEDIUM')
  await rig.waitTurns(name, count + 1)
  const medium = starts().at(-1)
  p.check('next turn launches AGY with medium and the same pinned base model',
    flag(medium, '--effort') === 'medium' && flag(medium, '--model') === 'gemini-4-argon', medium)
  p.check('changed effort replaces the old process at the turn boundary',
    high?.pid !== medium?.pid && medium?.resumed === true, { high: high?.pid, medium: medium?.pid, resumed: medium?.resumed })
  const last = rig.turns(name).at(-1)
  p.check('medium turn completes without a model-pin or launch error', !!last?.ended_at && !last.error && !last.killed, last)
  p.keep(rig, { agents: [name], grep: /effort|model pin/i })
  return p.summary()
}
