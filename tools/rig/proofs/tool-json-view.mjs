// Proof: expanded tool calls show their JSON input and output as a structured
//   view (key/value rows, nested folds, lists, text blocks) with a Raw toggle;
//   a large output starts collapsed past the first level; plain-text output is
//   unchanged. Needs --ui.
// Run: node tools/rig/rig.mjs run tools/rig/proofs/tool-json-view.mjs --ui <bundle>

import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { runDesktop } from '../desktop.mjs'
import { Proof } from '../proof.mjs'

export default async function (rig) {
  const p = new Proof('tool-json-view')
  const nested = { query: 'select *', options: { limit: 10, filters: { status: ['open', 'blocked'], owner: null } },
    note: 'line one\nline two', tags: [] }
  const big = { items: Array.from({ length: 700 }, (_, i) => ({ i })) }
  rig.scenario({ default: { turns: [
    { name: 'json', match: ['PROOF-JSON'], steps: [
      { tool: 'Task', args: nested, result: JSON.stringify({ status: 'ok', data: { count: 2, rows: [{ id: 1 }, { id: 2 }] } }) },
      { tool: 'Grep', args: { pattern: 'x' }, result: JSON.stringify(big) },
      { tool: 'Read', args: { file_path: 'a.txt' }, result: 'PLAIN TEXT RESULT' },
      { text: 'done.' },
    ] },
    { name: 'default', steps: [{ text: 'OK.' }] },
  ] } })
  await rig.waitFor(() => rig.sql('SELECT 1 FROM ot.turns WHERE ended_at IS NULL').length === 0, { what: 'seed turns', timeout: 60000 })
  await rig.userMail('alice', 'PROOF-JSON: run the tools.')
  await rig.waitFor(() => {
    const t = rig.turns('alice'); return t.length && t.every(x => x.ended_at) ? t : null
  }, { what: 'alice turn', timeout: 90000 })
  const ui = await runDesktop(rig, fileURLToPath(new URL('../desktop/tool-json-view.cjs', import.meta.url)), { out: path.join(p.dir, 'desktop') })
  p.check('desktop script ran', ui.ok, ui.error)
  if (ui.ok) for (const [k, v] of Object.entries(ui.value)) p.check(k, v === true, v)
  p.keep(rig, { agents: ["alice"] }); return p.summary()
}
