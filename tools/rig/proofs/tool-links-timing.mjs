// Proof: tool calls in the transcript show their execution time (and a live
//   timer past ten seconds while one runs), carry no "Input" label, and the
//   orgtree calls that concern an agent or a watchdog show a link/card beside
//   them (agent link with right-click menu; watchdog card opening the modal).
//   alice runs: message to bob, a watchdog create, a quick Bash, a 70 s Bash.
// Run: node tools/rig/rig.mjs run tools/rig/proofs/tool-links-timing.mjs --ui <bundle>

import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { runDesktop } from '../desktop.mjs'
import { Proof } from '../proof.mjs'

export default async function (rig) {
  const p = new Proof('tool-links-timing')
  rig.scenario({ default: { turns: [
    { name: 'links', match: ['PROOF-LINKS'], steps: [
      { tool: 'orgtree_message', args: { to: 'bob', body: 'hello bob' } },
      { tool: 'orgtree_watchdog', args: { action: 'create', name: 'proof-dog', kind: 'command', target: 'echo hi',
        pattern: 'ZZZ', interval_s: 3600, shell: 'bash' } },
      { tool: 'Bash', args: { command: 'echo quick' }, result: 'quick', run_ms: 0 },
      { tool: 'Bash', args: { command: 'sleep 70' }, result: 'slept', run_ms: 70000 },
      { text: 'done.' },
    ] },
    { name: 'default', steps: [{ text: 'OK.' }] },
  ] } })
  await rig.waitFor(() => rig.sql('SELECT 1 FROM ot.turns WHERE ended_at IS NULL').length === 0, { what: 'seed turns', timeout: 60000 })
  await rig.userMail('alice', 'PROOF-LINKS: run the tools.')
  const ui = await runDesktop(rig, fileURLToPath(new URL('../desktop/tool-links-timing.cjs', import.meta.url)),
    { out: path.join(p.dir, 'desktop'), timeout: 400000 })
  p.check('desktop script ran', ui.ok, ui.error)
  if (ui.ok) for (const [k, v] of Object.entries(ui.value)) if (k !== 'detail') p.check(k, v === true, ui.value.detail)
  p.keep(rig, { agents: ['alice'] }); return p.summary()
}
