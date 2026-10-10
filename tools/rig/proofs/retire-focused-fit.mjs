// Proof: retiring the agent whose desk is focused returns the canvas to the
//   whole-org fit, whoever retires it (here boss, through the engine); retiring a
//   different agent leaves the view alone. Needs --ui.
// Run: node tools/rig/rig.mjs run tools/rig/proofs/retire-focused-fit.mjs --ui <bundle>

import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { runDesktop } from '../desktop.mjs'
import { Proof } from '../proof.mjs'

export default async function (rig) {
  const p = new Proof('retire-focused-fit')
  rig.scenario({ default: { turns: [{ name: 'default', steps: [{ text: 'OK.' }] }] } })
  await rig.waitFor(() => rig.sql('SELECT 1 FROM ot.turns WHERE ended_at IS NULL').length === 0, { what: 'seed turns', timeout: 60000 })
  const ui = await runDesktop(rig, fileURLToPath(new URL('../desktop/retire-focused-fit.cjs', import.meta.url)), { out: path.join(p.dir, 'desktop') })
  p.check('desktop script ran', ui.ok, ui.error)
  if (ui.ok) {
    for (const k of ['zoomedIn', 'otherRetireKeepsView', 'ownRetireReturnsToFit']) p.check(k, ui.value[k] === true, ui.value.detail)
    p.file('views.json', ui.value.detail)
  }
  p.keep(rig, { agents: ['alice'] })
  return p.summary()
}
