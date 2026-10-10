// Proof: at far zoom the hover name label of a card with a long agent name shows the whole name.
// Run: node tools/rig/rig.mjs run tools/rig/proofs/hover-name.mjs --ui <bundle>
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { runDesktop } from '../desktop.mjs'
import { Proof } from '../proof.mjs'

export default async function (rig) {
  const p = new Proof('hover-name')
  const name = 'localserver-research-sonnet'
  rig.scenario({ default: { turns: [{ name: 'default', steps: [{ text: 'OK.' }] }] } })
  await rig.waitFor(() => rig.sql('SELECT 1 FROM ot.turns WHERE ended_at IS NULL').length === 0, { what: 'seed turns', timeout: 60000 })
  await rig.op({ op: 'hire', name, parent: 'boss', tier: 'sonnet', title: 'Long name' })
  await rig.waitFor(() => rig.sql('SELECT 1 FROM ot.turns WHERE ended_at IS NULL').length === 0, { what: 'hire turn', timeout: 60000 })
  const ui = await runDesktop(rig, fileURLToPath(new URL('../desktop/hover-name.cjs', import.meta.url)),
    { out: path.join(p.dir, 'desktop'), args: { agent: name }, timeout: 200000 })
  p.check('desktop script ran', ui.ok, ui.error)
  if (ui.ok) for (const [k, v] of Object.entries(ui.value)) if (k !== 'detail') p.check(k, v === true, JSON.stringify(ui.value.detail))
  p.keep(rig, { agents: [name] }); return p.summary()
}
