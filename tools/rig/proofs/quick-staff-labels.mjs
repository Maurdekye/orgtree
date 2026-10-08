// Proof: the docket's quick staff menu labels models as the hire flow does
// (`sonnet (antigravity)`, an OpenRouter model's short label), with the
// Antigravity Claude tiers enabled and an OpenRouter model favourited.
// Run: node tools/rig/rig.mjs run tools/rig/proofs/quick-staff-labels.mjs
// (set ORGTREE_RIG_UI to a built renderer to compare before and after)
import fs from 'node:fs'
import path from 'node:path'
import { runDesktop } from '../desktop.mjs'
import { RIG_DIR, rigHome } from '../lib.mjs'

export async function setup() {
  return {
    name: 'quick-staff-labels',
    fixture: { org: { name: 'Quick staff' },
      agents: [{ name: 'boss', tier: 'opus', grant: 24 }, { name: 'alice', parent: 'boss', tier: 'sonnet' }],
      docket: [{ as: 'boss', args: { action: 'create', title: 'Staffing proof', objective: 'A backlogged item to staff.', owner: 'alice', status: 'backlogged' } }],
      scenario: { default: { turns: [{ steps: [{ text: 'OK.' }] }] } } },
    prepare: async ({ data }) => {
      fs.mkdirSync(path.join(data, 'openrouter'), { recursive: true })
      fs.writeFileSync(path.join(data, 'openrouter', 'state.json'), JSON.stringify({
        key: 'sk-or-rig-not-a-real-key',
        favorites: [{ id: 'rig/fake-model', tier: 'or-rig-fake-model', name: 'Rig fake model', label: 'fake-model', vendor: 'rig', prompt: 1, completion: 2, context: 100000, tools: true }] }))
      const dir = path.join(data, 'rig-home', 'rig-usage'); fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, 'openrouter-key.json'), JSON.stringify({ status: 200, data: { label: 'rig key', limit: null, limit_remaining: null, limit_reset: null, usage: 1, usage_daily: 0, usage_weekly: 0, usage_monthly: 1, is_free_tier: false, total_credits: 10, total_usage: 1 } }))
    },
  }
}

export default async function (rig) {
  await rig.waitFor(() => rig.sql('SELECT 1 FROM ot.turns WHERE ended_at IS NULL').length === 0, { what: 'seed turns', timeout: 60000 })
  await rig.api('PUT', '/api/app-settings/runtime', { antigravity_claude_enabled: true })
  const out = path.join(rigHome(), 'evidence', 'quick-staff-labels-' + Date.now())
  const r = await runDesktop(rig, path.join(RIG_DIR, 'desktop', 'quick-staff-menu.cjs'), { preset: 'tall', out, timeout: 90000 })
  console.log(JSON.stringify(r.value ?? r, null, 1), '\n', out)
  if (!r.ok) throw Error(JSON.stringify(r))
}
