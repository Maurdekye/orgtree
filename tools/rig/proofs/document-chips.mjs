import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runDesktop } from '../desktop.mjs'
import { rigHome } from '../lib.mjs'

export async function setup() {
  return { fixture: { org: { name: 'Document chip order' },
    agents: [{ name: 'rhea', tier: 'luna', grant: 4 }],
    scenario: { default: { turns: [{ steps: [{ text: 'OK.' }] }] } } } }
}

export default async function (rig) {
  await rig.waitFor(() => rig.sql('SELECT 1 FROM ot.turns WHERE ended_at IS NULL').length === 0,
    { what: 'seed turn complete', timeout: 60000 })
  const scratch = path.join(rig.data, 'scratch', rig.org, 'rhea')
  fs.mkdirSync(scratch, { recursive: true })
  for (let n = 1; n <= 6; n++) {
    const result = await rig.tool('rhea', 'orgtree_present', {
      title: `Report ${n}`, body: `# Report ${n}\n\nUnique report body ${n}.`,
    })
    if (!result.ok) throw Error(result.text)
    if (n === 2 || n === 6) {
      const name = `delivery-${n}.txt`
      fs.writeFileSync(path.join(scratch, name), `Delivered file ${n}`)
      const sent = await rig.tool('rhea', 'orgtree_send_file', { path: name })
      if (!sent.ok) throw Error(sent.text)
    }
  }
  const docs = rig.sql("SELECT title FROM ot.documents WHERE node_name='rhea' ORDER BY at DESC,id DESC")
  if (docs.length !== 6) throw Error('Expected six presentations')
  const evidence = path.join(rigHome(), 'evidence', 'document-chips-' + Date.now())
  const result = await runDesktop(rig,
    path.join(path.dirname(fileURLToPath(import.meta.url)), '../desktop/document-chips.cjs'),
    { out: evidence, args: { expected: docs.slice(0, 4).map(d => `read ${d.title}`) }, timeout: 60000 })
  if (!result.ok) throw Error(JSON.stringify(result))
  return { ok: true, evidence, ...result.value }
}
