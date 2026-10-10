// Proof: orgtree_work / orgtree_ask calls that name a docket ticket show an inline ticket link beside the call;
//   a click opens that ticket in the docket; a list call has none; an unknown slug stays plain text.
// Run: node tools/rig/rig.mjs run tools/rig/proofs/tool-ticket-links.mjs --ui <bundle>

import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { runDesktop } from '../desktop.mjs'
import { Proof } from '../proof.mjs'

export default async function (rig) {
  const p = new Proof('tool-ticket-links')
  rig.scenario({ default: { turns: [
    { name: 'tickets', match: ['PROOF-TICKETS'], steps: [
      { tool: 'orgtree_work', args: { action: 'get', slug: 'rig-smoke-item' } },
      { tool: 'orgtree_work', args: { action: 'create', title: 'Proof ticket', objective: 'Made by the ticket-link proof.', kind: 'non-code', owner: 'alice' } },
      { tool: 'orgtree_work', args: { action: 'update', slug: 'proof-ticket', status: 'in_progress', done_so_far: ['x'], working_on_next: ['y'] } },
      { tool: 'orgtree_work', args: { action: 'list' } },
      { tool: 'orgtree_work', args: { action: 'get', slug: 'no-such-ticket-zz' } },
      { text: 'done.' },
    ] },
    { name: 'default', steps: [{ text: 'OK.' }] },
  ] } })
  await rig.waitFor(() => rig.sql('SELECT 1 FROM ot.turns WHERE ended_at IS NULL').length === 0, { what: 'seed turns', timeout: 60000 })
  await rig.userMail('alice', 'PROOF-TICKETS: run the tools.')
  const ui = await runDesktop(rig, fileURLToPath(new URL('../desktop/tool-ticket-links.cjs', import.meta.url)),
    { out: path.join(p.dir, 'desktop'), timeout: 300000 })
  p.check('desktop script ran', ui.ok, ui.error)
  if (ui.ok) for (const [k, v] of Object.entries(ui.value)) if (k !== 'detail') p.check(k, v === true, ui.value.detail)
  p.keep(rig, { agents: ['alice'] }); return p.summary()
}
