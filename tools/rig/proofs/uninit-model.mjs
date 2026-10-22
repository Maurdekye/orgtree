import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { runDesktop } from '../desktop.mjs'
import { Proof } from '../proof.mjs'

// Compare persisted hire fields, not changing runtime/mail/free-credit overlays.
export function draftTreeUnchanged(before, tree, grant) {
  if (!Array.isArray(before) || !Array.isArray(tree?.roots) || !Number.isFinite(grant)
    || tree.default_top_grant !== grant || before.some(a => a.name === 'selected-sol')) return false
  const actual = []
  const visit = nodes => {
    for (const a of nodes) {
      actual.push({ name: a.id, tier: a.tier, charter: a.charter, grant: a.grant,
        parent: a.parent, state: a.state, generation: a.generation })
      if (!Array.isArray(a.children)) return false
      if (!visit(a.children)) return false
    }
    return true
  }
  if (!visit(tree.roots) || new Set(actual.map(a => a.name)).size !== actual.length) return false
  const stable = rows => rows.map(({ name, tier, charter, grant, parent, state, generation }) =>
    ({ name, tier, charter, grant, parent, state, generation })).sort((a, b) => a.name.localeCompare(b.name))
  return isDeepStrictEqual(stable(before), stable(actual))
}

export function selectedHireOnly(before, rows, grant) {
  if (!Array.isArray(before) || !Array.isArray(rows) || !Number.isFinite(grant)
    || before.some(a => a.name === 'selected-sol') || rows.length !== before.length + 1) return false
  const ids = new Set(before.map(a => a.id))
  if (ids.size !== before.length || new Set(rows.map(a => a.id)).size !== rows.length) return false
  const added = rows.filter(a => !ids.has(a.id))
  const old = rows.filter(a => ids.has(a.id))
  const ordered = list => [...list].sort((a, b) => a.id - b.id)
  return isDeepStrictEqual(ordered(before), ordered(old)) && added.length === 1
    && added[0].name === 'selected-sol' && added[0].tier === 'sol'
    && added[0].charter === 'Keep this charter when choosing a new model.' && added[0].grant === grant
    && added[0].parent === null && added[0].state === 'live' && added[0].generation === 1
}

// Renderer-to-engine proof: a local draft edit must be the model admitted by Hire.
export default async function (rig) {
  const p = new Proof('uninit-model')
  const snapshot = () => rig.sql(`SELECT a.id,a.name,a.tier,a.charter,a.grant_credits::float8 AS grant,
    a.state,a.generation,p.name AS parent FROM ot.agents a LEFT JOIN ot.agents p ON p.id=a.parent_id
    WHERE a.org_id=(SELECT id FROM ot.orgs WHERE slug='${rig.org}') ORDER BY a.id`)
  const before = snapshot()
  const initial = await rig.api('GET', `/api/orgs/${rig.org}`)
  const grant = initial.default_top_grant
  p.file('before.json', { rows: before, tree: initial })
  const desktop = await runDesktop(rig, fileURLToPath(new URL('../desktop/uninit-model.cjs', import.meta.url)), {
    preset: '960x700', out: path.join(p.dir, 'desktop'), timeout: 90000, args: { org: rig.org },
  })
  p.check('desktop script completes', desktop.ok, desktop.ok ? undefined : desktop)
  const value = desktop.value
  p.check('uninitialized icon opens the model picker', value?.hasIcon === true, value)
  if (!desktop.ok || !value?.hasIcon) return p.summary()
  p.check('model selection leaves draft name, charter and provider theme correct',
    value.staged?.name === 'selected-sol' && value.staged?.charter === 'Keep this charter when choosing a new model.' && value.staged?.openai === true, value.staged)
  p.file('pre-hire.json', { opened: value.before, selected: value.selected })
  p.check('opening and choosing models did not create an agent', draftTreeUnchanged(before, initial, grant)
    && draftTreeUnchanged(before, value.before, grant) && draftTreeUnchanged(before, value.selected, grant))
  const rows = snapshot()
  p.file('after.json', { rows, expectedGrant: grant })
  p.check('engine creates exactly the selected Sol model with the original draft fields', selectedHireOnly(before, rows, grant), rows)
  p.keep(rig, { grep: /op=hire|selected-sol/ })
  return p.summary()
}
