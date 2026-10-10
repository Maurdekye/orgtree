// Proof: a pinned PANEL (the work docket) dragged by an edge handle far past the canvas edge stops at that edge
//   and the opposite side does not move (it no longer grows the other way). Run: rig run proofs/modal-pin-resize.mjs --ui <bundle>
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { runDesktop } from '../desktop.mjs'
import { Proof } from '../proof.mjs'

export default async function (rig) {
  const p = new Proof('modal-pin-resize')
  rig.scenario({ default: { turns: [{ name: 'default', steps: [{ text: 'OK.' }] }] } })
  await rig.waitFor(() => rig.sql('SELECT 1 FROM ot.turns WHERE ended_at IS NULL').length === 0, { what: 'seed turns', timeout: 60000 })
  const ui = await runDesktop(rig, fileURLToPath(new URL('../desktop/modal-pin-resize.cjs', import.meta.url)),
    { out: path.join(p.dir, 'desktop'), args: { org: rig.org }, timeout: 300000 })
  p.check('desktop script ran', ui.ok, ui.error)
  if (ui.ok) for (const e of ['s', 'e', 'n', 'w']) {
    p.check(e + '-opposite-side-fixed', ui.value[e]?.oppositeFixed === true, JSON.stringify(ui.value[e]))
    p.check(e + '-stops-at-edge', ui.value[e]?.stopsAtEdge === true, JSON.stringify(ui.value[e]))
  }
  p.keep(rig, { agents: ['alice'] }); return p.summary()
}
