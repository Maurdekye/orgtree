import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runDesktop } from '../desktop.mjs'
import { rigHome } from '../lib.mjs'

// Presented-document read marks survive an engine restart and a fresh desktop
// run on the same profile (the user's report: every card turned unread again).
export async function setup() {
  return { fixture: { org: { name: 'Unread restart' },
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
  const script = path.join(path.dirname(fileURLToPath(import.meta.url)), '../desktop/unread-restart.cjs')
  const evidence = path.join(rigHome(), 'evidence', 'unread-restart-' + Date.now())
  const profile = path.join(rig.dir, 'electron-profiles', 'kept')
  const run = (r, phase) => runDesktop(r, script, { out: path.join(evidence, phase), profile, args: { org: r.org, phase }, timeout: 90000 })
  const first = await run(rig, 'open')
  if (!first.ok) throw Error(JSON.stringify(first))
  const rig2 = await rig.restart()
  const second = await run(rig2, 'check')
  if (!second.ok) throw Error(JSON.stringify(second))
  return { ok: true, evidence, url1: rig.url, url2: rig2.url, first: first.value, second: second.value }
}
