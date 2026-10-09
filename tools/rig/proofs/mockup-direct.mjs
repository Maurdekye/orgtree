import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runDesktop } from '../desktop.mjs'
import { rigHome } from '../lib.mjs'

export async function setup() {
  return { fixture: { org: { name: 'Mockup direct' },
    agents: [{ name: 'rhea', tier: 'luna', grant: 4 }],
    scenario: { default: { turns: [{ steps: [{ text: 'OK.' }] }] } } } }
}

export default async function (rig) {
  await rig.waitFor(() => rig.sql('SELECT 1 FROM ot.turns WHERE ended_at IS NULL').length === 0,
    { what: 'seed turn complete', timeout: 60000 })
  const scratch = path.join(rig.data, 'scratch', rig.org, 'rhea')
  fs.mkdirSync(scratch, { recursive: true })
  fs.writeFileSync(path.join(scratch, 'mock.html'), '<!doctype html><html><body><h1>Mockup</h1></body></html>')
  const r = await rig.tool('rhea', 'orgtree_present', { title: 'Mockup', path: 'mock.html' })
  if (!r.ok) throw Error(r.text)
  const here = path.dirname(fileURLToPath(import.meta.url))
  const out = {}
  for (const s of ['mockup-direct', 'mockup-panel']) {
    const res = await runDesktop(rig, path.join(here, `../desktop/${s}.cjs`),
      { out: path.join(rigHome(), 'evidence', `${s}-` + Date.now()), args: {}, timeout: 60000 })
    if (!res.ok) throw Error(s + ': ' + JSON.stringify(res).slice(0, 1200))
    out[s] = res.value
  }
  return { ok: true, ...out }
}
