// Proof: resolved scope and credit requests draw as answered-style cards, not a field dump.
//   sky: scope request, one item approved, one denied, one skipped (tool, folder, folder)
//   kim: credit request, counter-offered
//   tia: credit request, denied
// The desktop part opens each desk offscreen and saves a screenshot of the card.
// Run: ORGTREE_RIG_UI=<bundle> node tools/rig/rig.mjs run tools/rig/proofs/resolution-cards.mjs

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Proof } from '../proof.mjs'
import { runDesktop } from '../desktop.mjs'
import { rigHome } from '../lib.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))

export default async function (rig) {
  const p = new Proof('resolution-cards')
  rig.scenario({ default: { turns: [{ name: 'default', steps: [{ text: 'OK.' }] }] } })
  await rig.waitFor(() => rig.sql(`SELECT 1 FROM ot.turns WHERE ended_at IS NULL`).length === 0, { what: 'seed turns to settle', timeout: 60000 })
  const inner = path.join(rig.data, 'rig-shared', 'sub')
  const outside = path.join(rig.data, 'rig-outside')
  for (const d of [inner, outside]) fs.mkdirSync(d, { recursive: true })
  await rig.api('POST', `/api/orgs/${rig.org}/settings`, { max_top_grant: 50 })
  for (const [name, grant] of [['sky', 3], ['kim', 4], ['tia', 4]]) {
    await rig.op({ op: 'hire', name, parent: 'boss', tier: 'haiku', title: 'Request agent', grant, tools: { web: false } })
    await rig.api('POST', `/api/orgs/${rig.org}/audiences`, { action: 'grant', node: name, reason: 'proof: may ask the user' })
  }
  const id = name => rig.agentRow(name).id
  const row = name => rig.one(`SELECT uid, rev FROM ot.asks WHERE agent_id = ${id(name)} AND status = 'open' ORDER BY id DESC LIMIT 1`)
  await rig.tool('sky', 'orgtree_request_scope', { reason: 'proof: research and two folders', items: [
    { kind: 'tool', tool: 'web' }, { kind: 'dir', path: inner, mode: 'rw' }, { kind: 'dir', path: outside, mode: 'ro' }] })
  await rig.api('POST', `/api/orgs/${rig.org}/nodes/sky/batch`, { revs: { scope: row('sky').rev }, scope: ['approve', 'deny', 'skip'] })
  await rig.tool('kim', 'orgtree_request_credits', { new_limit: 10, reason: 'proof: more work' })
  await rig.api('POST', `/api/orgs/${rig.org}/nodes/kim/batch`, { revs: { credits: row('kim').rev }, credits: { granted: 7 } })
  await rig.tool('tia', 'orgtree_request_credits', { new_limit: 9, reason: 'proof: more work' })
  await rig.api('POST', `/api/orgs/${rig.org}/nodes/tia/batch`, { revs: { credits: row('tia').rev }, credits: { deny: true } })

  const ev = name => rig.sql(`SELECT ev FROM ot.mail WHERE recipient_agent_id = ${id(name)} AND sender = '@user' AND kind = 'decision' ORDER BY id`)
    .map(r => r.ev).at(-1)
  const sky = ev('sky'), kim = ev('kim'), tia = ev('tia')
  const sec = (e, kind) => (e?.sections ?? []).find(s => s.kind === kind)
  p.check('sky: the stored resolution has three scope decisions (approve, deny, skip)', sec(sky, 'scope')?.decisions?.length === 3
    && ['approve', 'deny', 'skip'].every((d, i) => String(sec(sky, 'scope').decisions[i].decision).startsWith(d)), sky)
  p.check('kim: counter-offer stored', sec(kim, 'credit')?.outcome === 'counter', kim)
  p.check('tia: denial stored', sec(tia, 'credit')?.outcome === 'denied', tia)

  if (process.env.ORGTREE_RIG_UI) {
    const evidence = path.join(rigHome(), 'evidence', 'resolution-cards-' + Date.now())
    fs.mkdirSync(evidence, { recursive: true })
    for (const name of ['sky', 'kim', 'tia']) {
      const r = await runDesktop(rig, path.join(here, '../desktop/resolution-cards.cjs'), { args: { agent: name }, out: path.join(evidence, name), timeout: 90000 })
      p.check(`${name}: the desk shows the resolved card (screenshot in ${evidence})`, r.ok !== false && JSON.stringify(r).includes('"rows"') && !JSON.stringify(r).includes('"raw":true'), JSON.stringify(r).slice(0, 600))
    }
  }
  p.keep(rig, { agents: ['sky', 'kim', 'tia'], grep: /scope|credit|request/i })
  return p.summary()
}
