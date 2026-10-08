// Proof: an OpenRouter favourite's hire token shows its own letter (M for
// mimo-v2.6-pro), not the provider's R.
// Run: node tools/rig/rig.mjs run tools/rig/proofs/or-token-letter.mjs
import fs from 'node:fs'
import path from 'node:path'
import { runDesktop } from '../desktop.mjs'
import { RIG_DIR, rigHome } from '../lib.mjs'

export async function setup() {
  return {
    name: 'or-token-letter',
    fixture: { org: { name: 'OR letter' }, agents: [{ name: 'boss', tier: 'opus', grant: 24 }],
      scenario: { default: { turns: [{ steps: [{ text: 'OK.' }] }] } } },
    prepare: async ({ data }) => {
      fs.mkdirSync(path.join(data, 'openrouter'), { recursive: true })
      fs.writeFileSync(path.join(data, 'openrouter', 'state.json'), JSON.stringify({
        key: 'sk-or-rig-not-a-real-key',
        favorites: [{ id: 'xiaomi/mimo-v2.6-pro', tier: 'or-xiaomi-mimo-v2-6-pro', name: 'Xiaomi: MiMo V2.6 Pro', label: 'mimo-v2.6-pro', letter: 'M', color: '#d2691e', vendor: 'xiaomi', prompt: 1, completion: 2, context: 100000, tools: true }] }))
      const dir = path.join(data, 'rig-home', 'rig-usage'); fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, 'openrouter-key.json'), JSON.stringify({ status: 200, data: { label: 'rig key', limit: null, limit_remaining: null, limit_reset: null, usage: 1, usage_daily: 0, usage_weekly: 0, usage_monthly: 1, is_free_tier: false, total_credits: 10, total_usage: 1 } }))
    },
  }
}

export default async function (rig) {
  await rig.waitFor(() => rig.sql('SELECT 1 FROM ot.turns WHERE ended_at IS NULL').length === 0, { what: 'seed turns', timeout: 60000 })
  const out = path.join(rigHome(), 'evidence', 'or-token-letter-' + Date.now())
  const r = await runDesktop(rig, path.join(RIG_DIR, 'desktop', 'hire-tokens.cjs'), { preset: 'tall', out, timeout: 90000 })
  console.log(JSON.stringify(r.value ?? r, null, 1), '\n', out)
  if (!r.ok) throw Error(JSON.stringify(r))
}
