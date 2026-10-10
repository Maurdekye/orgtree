// Proof: the agent-settings and org-default effort controls are the effort bar (they were dropdowns):
// a click between dots sets the nearest level, a second click on it clears back to inherit, in dark and light.
// Run: ORGTREE_RIG_UI=<bundle> node tools/rig/rig.mjs run tools/rig/proofs/effort-selects.mjs --ui <bundle>

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Proof } from '../proof.mjs'
import { runDesktop } from '../desktop.mjs'
import { rigHome } from '../lib.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))

export default async function (rig) {
  const p = new Proof('effort-selects')
  rig.scenario({ default: { turns: [{ name: 'default', steps: [{ text: 'OK.' }] }] } })
  await rig.waitFor(() => rig.sql(`SELECT 1 FROM ot.turns WHERE ended_at IS NULL`).length === 0, { what: 'seed turns to settle', timeout: 60000 })
  await rig.op({ op: 'hire', name: 'eve', parent: 'boss', tier: 'sonnet', title: 'Effort agent' })
  if (process.env.ORGTREE_RIG_UI) {
    const evidence = path.join(rigHome(), 'evidence', 'effort-selects-' + Date.now())
    fs.mkdirSync(evidence, { recursive: true })
    for (const theme of ['charcoal', 'light']) {
      const r = await runDesktop(rig, path.join(here, '../desktop/effort-selects.cjs'), { args: { org: rig.org, theme, agent: 'eve' }, out: path.join(evidence, theme), timeout: 150000 })
      const v = r.value ?? {}
      p.check(`${theme}: agent settings shows the bar, not a dropdown (shots in ${evidence})`, r.ok !== false && (v.agentRest ?? []).length > 0, JSON.stringify(r).slice(0, 600))
      p.check(`${theme}: the fill runs past the pip at every level, with the track's own padding (shots in ${evidence})`,
        (v.fill ?? []).length === 5 && v.fill.every((x) => x.padR >= 3.5 && x.padR <= 4.5 && x.fillL === 0), v.fill)
      const gx = (v.glide ?? []).map((q) => q[1]); const gmin = Math.min(...gx), gmax = Math.max(...gx)
      p.check(`${theme}: a click glides the pip (intermediate positions between the two levels)`, gx.some((x) => x > gmin + 5 && x < gmax - 5) && gmax - gmin > 40, v.glide)
      p.check(`${theme}: hovering does not move the pip`, v.pipBefore != null && v.pipBefore === v.pipHover, [v.pipBefore, v.pipHover])
      p.check(`${theme}: a click between dots sets a level; a second click on it clears to inherit`,
        !!v.agentAfterClick?.[0]?.pinned && v.agentAfterClear?.[0]?.pinned === '', v)
      p.check(`${theme}: the org default is the bar too`, Array.isArray(v.orgDefault) && v.orgDefault.length > 0, v.orgDefault)
    }
  }
  p.keep(rig, { agents: ['eve'], grep: /effort/i })
  return p.summary()
}
