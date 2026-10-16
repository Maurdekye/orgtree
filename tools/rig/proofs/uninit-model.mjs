import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runDesktop } from '../desktop.mjs'
import { Proof } from '../proof.mjs'

// Renderer-to-engine proof: a local draft edit must be the model admitted by Hire.
export default async function (rig) {
  const p = new Proof('uninit-model')
  const before = rig.sql(`SELECT name,tier FROM ot.agents WHERE org_id=(SELECT id FROM ot.orgs WHERE slug='${rig.org}')`)
  const desktop = await runDesktop(rig, fileURLToPath(new URL('../desktop/uninit-model.cjs', import.meta.url)), {
    preset: '960x700', out: path.join(p.dir, 'desktop'), timeout: 90000, args: { org: rig.org },
  })
  p.check('desktop script completes', desktop.ok, desktop.ok ? undefined : desktop)
  const value = desktop.value
  p.check('uninitialized icon opens the model picker', value?.hasIcon === true, value)
  if (!desktop.ok || !value?.hasIcon) return p.summary()
  p.check('model selection leaves draft name, charter and provider theme correct',
    value.staged?.name === 'selected-sol' && value.staged?.charter === 'Keep this charter when choosing a new model.' && value.staged?.openai === true, value.staged)
  p.check('opening and choosing models did not create an agent', before.length === 0 && value.before?.roots?.length === 0)
  const rows = rig.sql(`SELECT name,tier,charter,grant_credits::float8 AS grant FROM ot.agents WHERE org_id=(SELECT id FROM ot.orgs WHERE slug='${rig.org}')`)
  p.check('engine creates exactly the selected Sol model with the original draft fields', rows.length === 1
    && rows[0].name === 'selected-sol' && rows[0].tier === 'sol'
    && rows[0].charter === 'Keep this charter when choosing a new model.' && rows[0].grant === 12, rows)
  p.keep(rig, { grep: /op=hire|selected-sol/ })
  return p.summary()
}
