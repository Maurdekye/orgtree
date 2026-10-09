import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runDesktop } from '../desktop.mjs'
import { rigHome } from '../lib.mjs'

export async function setup() {
  return { fixture: { org: { name: 'Rainbow popout' },
    agents: [{ name: 'rhea', tier: 'luna', grant: 4 }],
    scenario: { default: { turns: [{ steps: [{ text: 'OK.' }] }] } } } }
}

export default async function (rig) {
  await rig.waitFor(() => rig.sql('SELECT 1 FROM ot.turns WHERE ended_at IS NULL').length === 0,
    { what: 'seed turn complete', timeout: 60000 })
  const evidence = path.join(rigHome(), 'evidence', 'rainbow-popout-' + Date.now())
  const result = await runDesktop(rig,
    path.join(path.dirname(fileURLToPath(import.meta.url)), '../desktop/rainbow-popout.cjs'),
    { out: evidence, args: {}, timeout: 90000, preset: 'tall' })
  if (!result.ok) throw Error(JSON.stringify(result).slice(0, 1500))
  return { ok: true, evidence, ...result.value }
}
