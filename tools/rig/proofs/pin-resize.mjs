// Proof: a pinned window flush against an edge of the canvas does not change size (or move its opposite side)
//   when that edge's handle is dragged 100 px outward; an inward drag shrinks it; a normal resize still grows it.
// Run: node tools/rig/rig.mjs run tools/rig/proofs/pin-resize.mjs --ui <bundle>

import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { runDesktop } from '../desktop.mjs'
import { Proof } from '../proof.mjs'

export default async function (rig) {
  const p = new Proof('pin-resize')
  rig.scenario({ default: { turns: [{ name: 'default', steps: [{ text: 'OK.' }] }] } })
  await rig.waitFor(() => rig.sql('SELECT 1 FROM ot.turns WHERE ended_at IS NULL').length === 0, { what: 'seed turns', timeout: 60000 })
  const ui = await runDesktop(rig, fileURLToPath(new URL('../desktop/pin-resize.cjs', import.meta.url)),
    { out: path.join(p.dir, 'desktop'), args: { org: rig.org, agent: 'alice' }, timeout: 300000 })
  p.check('desktop script ran', ui.ok, ui.error)
  if (ui.ok) {
    const v = ui.value
    for (const e of ['s', 'n', 'e', 'w', 'se', 'nw']) p.check('flush-' + e + '-unchanged', v[e]?.unchanged === true, JSON.stringify(v[e]))
    for (const k of Object.keys(v).filter((k) => k.startsWith('approach-'))) {
      p.check(k + '-opposite-fixed', v[k].oppositeFixed === true, JSON.stringify(v[k]))
      p.check(k + '-stops-at-edge', v[k].stopsAtEdge === true, JSON.stringify(v[k]))
    }
    p.check('inward-shrinks', v.inwardS?.shrank === true, JSON.stringify(v.inwardS))
    p.check('normal-resize-grows', v.normal?.grew === true, JSON.stringify(v.normal))
  }
  p.keep(rig, { agents: ['alice'] }); return p.summary()
}
