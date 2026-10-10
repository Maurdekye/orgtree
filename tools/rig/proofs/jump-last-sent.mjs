// Proof: "jump to your message" from the bottom of a long transcript lands on the user's message and stays there
// while new entries arrive (it used to snap back to the bottom: the jump's own scroll event ran the bottom pin).
// Run: node tools/rig/rig.mjs run tools/rig/proofs/jump-last-sent.mjs --ui <bundle>

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Proof } from '../proof.mjs'
import { runDesktop } from '../desktop.mjs'
import { rigHome } from '../lib.mjs'

export async function setup() {
  return { fixture: { org: { name: 'Jump last sent' }, agents: [{ name: 'rhea', tier: 'luna', grant: 4 }],
    scenario: { default: { turns: [{ steps: [{ text: 'OK.' }] }] } } } }
}

export default async function (rig) {
  const p = new Proof('jump-last-sent')
  const transcript = Array.from({ length: 35 }, (_, i) => `Paragraph ${i + 1}. A transcript row for checking scroll layout.`).join('\n\n')
  rig.scenario({ default: { turns: [{ steps: [{ text: transcript }] }] } })
  await rig.userMail('rhea', 'FIRST-QUESTION: write the scroll layout sample.')
  await rig.waitFor(() => rig.sql('SELECT 1 FROM ot.turns WHERE ended_at IS NULL').length === 0 && rig.turns('rhea').length > 0,
    { what: 'sample transcript completes', timeout: 60000 })
  const evidence = path.join(rigHome(), 'evidence', 'jump-last-sent-' + Date.now())
  const r = await runDesktop(rig, path.join(path.dirname(fileURLToPath(import.meta.url)), '../desktop/jump-last-sent.cjs'),
    { out: evidence, args: { org: rig.org, agent: 'rhea', token: 'FIRST-QUESTION' }, timeout: 90000 })
  const v = r.value ?? {}
  const s = v.samples ?? []
  p.check('the desk started at the bottom of the long transcript (screenshots in ' + evidence + ')', r.ok !== false && v.before === true, JSON.stringify(r).slice(0, 400))
  p.check('after the jump the user message is in view for the whole second while a new entry arrives', s.length > 0 && s.every(x => x.found && x.inView), s)
  p.check('the view did not return to the bottom', s.length > 0 && s.at(-1).bottomGap > 40, s.at(-1))
  p.keep(rig, { agents: ['rhea'], grep: /scroll|jump/i })
  return p.summary()
}
