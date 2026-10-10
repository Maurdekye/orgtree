// Proof: the effort bar on an agent's desk takes a press anywhere along it.
//   rest -> hover between dots previews the level -> press at the left and drag right -> release sets it
// Run: ORGTREE_RIG_UI=<bundle> node tools/rig/rig.mjs run tools/rig/proofs/effort-bar.mjs --ui <bundle>

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Proof } from '../proof.mjs'
import { runDesktop } from '../desktop.mjs'
import { rigHome } from '../lib.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))

export default async function (rig) {
  const p = new Proof('effort-bar')
  rig.scenario({ default: { turns: [{ name: 'default', steps: [{ text: 'OK.' }] }] } })
  await rig.waitFor(() => rig.sql(`SELECT 1 FROM ot.turns WHERE ended_at IS NULL`).length === 0, { what: 'seed turns to settle', timeout: 60000 })
  await rig.op({ op: 'hire', name: 'eve', parent: 'boss', tier: 'sonnet', title: 'Effort agent' })
  if (process.env.ORGTREE_RIG_UI) {
    const evidence = path.join(rigHome(), 'evidence', 'effort-bar-' + Date.now())
    fs.mkdirSync(evidence, { recursive: true })
    const r = await runDesktop(rig, path.join(here, '../desktop/effort-bar.cjs'), { args: { agent: 'eve' }, out: evidence, timeout: 90000 })
    const v = r.value ?? {}
    p.check('the desk bar ran (screenshots in ' + evidence + ')', r.ok !== false && !!v.rest, JSON.stringify(r).slice(0, 500))
    p.check('hovering between dots previews a level in the label', /^Effort \(\w+\)$/.test(v.hovered ?? ''), v)
    p.check('dragging moves the pick live to the far end (max)', /\(max\)/.test(v.dragging ?? ''), v)
    p.check('releasing sets it: the desk button reads max', v.after === 'max', v)
  }
  p.keep(rig, { agents: ['eve'], grep: /effort/i })
  return p.summary()
}
