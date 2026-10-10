// Proof: the "queued / undelivered" separator in an agent's transcript counts
//   the entries waiting below it ("1 queued / undelivered", then "3 ..."),
//   and disappears when the agent takes them. alice is halted so mail waits.
// Run: node tools/rig/rig.mjs run tools/rig/proofs/queue-count.mjs --ui <bundle>

import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { runDesktop } from '../desktop.mjs'
import { Proof } from '../proof.mjs'

export default async function (rig) {
  const p = new Proof('queue-count')
  rig.scenario({ default: { turns: [{ name: 'default', steps: [{ text: 'OK.' }] }] } })
  await rig.waitFor(() => rig.sql('SELECT 1 FROM ot.turns WHERE ended_at IS NULL').length === 0, { what: 'seed turns', timeout: 60000 })
  await rig.op({ op: 'halt', nodes: ['alice'] })
  await rig.userMail('alice', 'WAITING one')
  const ui = await runDesktop(rig, fileURLToPath(new URL('../desktop/queue-count.cjs', import.meta.url)),
    { out: path.join(p.dir, 'desktop'), args: { org: rig.org }, timeout: 200000 })
  p.check('desktop script ran', ui.ok, ui.error)
  if (ui.ok) for (const [k, v] of Object.entries(ui.value)) if (k !== 'detail') p.check(k, v === true, ui.value.detail)
  p.keep(rig, { agents: ['alice'] }); return p.summary()
}
