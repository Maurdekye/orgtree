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
  // An ended seed turn does not prove this sample mail has run. Follow its
  // accepted UID through delivery to its own successful completed turn.
  let sampleMail, sampleTurn
  try {
    sampleMail = await rig.userMail('rhea', 'FIRST-QUESTION: write the scroll layout sample.')
    if (sampleMail?.accepted !== true || typeof sampleMail.id !== 'string' || !sampleMail.id)
      throw new Error('sample mail has no accepted receipt UID')
    const sampleUid = sampleMail.id.replace(/'/g, "''")
    const sampleOrg = rig.org.replace(/'/g, "''")
    await rig.waitFor(() => {
      sampleTurn = rig.one(`SELECT m.uid, m.state, m.turn_id, t.ended_at, t.killed, t.error
        FROM ot.mail m JOIN ot.agents a ON a.id = m.recipient_agent_id
        JOIN ot.orgs o ON o.id = a.org_id AND m.org_id = o.id
        LEFT JOIN ot.turns t ON t.id = m.turn_id AND t.agent_id = a.id
        WHERE o.slug = '${sampleOrg}' AND a.name = 'rhea' AND m.uid = '${sampleUid}'`)
      return sampleTurn?.state === 'delivered' && Number.isInteger(sampleTurn.turn_id)
        && !!sampleTurn.ended_at && sampleTurn.killed === false && sampleTurn.error === null
    }, { what: 'sample transcript completes in its own delivered turn', timeout: 120000 })
    p.file('sample-turn.json', { receipt: sampleMail, turn: sampleTurn })
  } catch (e) {
    p.check('sample mail reaches its own completed turn before the desktop opens', false,
      { receipt: sampleMail ?? null, turn: sampleTurn ?? null, error: e.message })
    throw e
  }
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
