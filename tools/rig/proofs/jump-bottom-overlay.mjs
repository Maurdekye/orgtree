import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runDesktop } from '../desktop.mjs'
import { rigHome } from '../lib.mjs'

export async function setup() {
  return { fixture: { org: { name: 'Jump bottom overlay' }, agents: [
    { name: 'rhea', tier: 'luna', grant: 4 }, { name: 'noa', parent: 'rhea', tier: 'luna' },
  ], scenario: { default: { turns: [{ steps: [{ text: 'OK.' }] }] } } } }
}

export default async function (rig) {
  const transcript = Array.from({ length: 35 }, (_, i) => `Paragraph ${i + 1}. A transcript row for checking scroll layout.`).join('\n\n')
  rig.scenario({ default: { turns: [{ steps: [{ text: transcript }] }] } })
  await rig.userMail('rhea', 'Write the scroll layout sample.')
  await rig.waitFor(() => rig.sql('SELECT 1 FROM ot.turns WHERE ended_at IS NULL').length === 0 && rig.turns('rhea').length > 0,
    { what: 'sample transcript completes', timeout: 60000 })
  const evidence = path.join(rigHome(), 'evidence', 'jump-bottom-' + Date.now())
  const result = await runDesktop(rig,
    path.join(path.dirname(fileURLToPath(import.meta.url)), '../desktop/jump-bottom-overlay.cjs'),
    { out: evidence, timeout: 60000 })
  if (!result.ok) throw Error(JSON.stringify(result))
  return { ok: true, evidence, ...result.value }
}
