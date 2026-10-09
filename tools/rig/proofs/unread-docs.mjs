import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runDesktop } from '../desktop.mjs'
import { rigHome } from '../lib.mjs'

export async function setup() {
  return { fixture: { org: { name: 'Unread documents' },
    agents: [{ name: 'rhea', tier: 'luna', grant: 4 }],
    scenario: { default: { turns: [{ steps: [{ text: 'OK.' }] }] } } } }
}

export default async function (rig) {
  await rig.waitFor(() => rig.sql('SELECT 1 FROM ot.turns WHERE ended_at IS NULL').length === 0,
    { what: 'seed turn complete', timeout: 60000 })
  for (let n = 1; n <= 3; n++) {
    const r = await rig.tool('rhea', 'orgtree_present', { title: `Report ${n}`, body: `# Report ${n}\n\nUnique report body ${n}.` })
    if (!r.ok) throw Error(r.text)
  }
  const evidence = path.join(rigHome(), 'evidence', 'unread-docs-' + Date.now())
  const result = await runDesktop(rig,
    path.join(path.dirname(fileURLToPath(import.meta.url)), '../desktop/unread-docs.cjs'),
    { out: evidence, args: { org: rig.org }, timeout: 60000 })
  if (!result.ok) throw Error(JSON.stringify(result))
  return { ok: true, evidence, ...result.value }
}
