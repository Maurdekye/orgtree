// Proof: answered questions in the user's inbox draw the answered-question card WITH the answer.
//   sia: option question, answered through the question route
//   bat: one question answered through the batch route (the answer lives on the tab, not the card)
//   fay: a free-text question
//   cy:  two questions answered through the question route
// Run: ORGTREE_RIG_UI=<bundle> node tools/rig/rig.mjs run tools/rig/proofs/inbox-answered.mjs --ui <bundle>

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Proof } from '../proof.mjs'
import { runDesktop } from '../desktop.mjs'
import { rigHome } from '../lib.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const COLOURS = [{ label: 'Red', description: 'warm' }, { label: 'Green', description: 'natural' }]

export default async function (rig) {
  const p = new Proof('inbox-answered')
  const ask = (args) => ({ turns: [{ name: 'ask', match: 'PROOF-ASK', once: true, steps: [
    { tool: 'orgtree_ask', args, expect: "user's desk" }, { text: 'Asked.' }] }] })
  rig.scenario({ agents: {
    sia: ask({ question: 'Which colour should the button be?', header: 'Colour', options: COLOURS }),
    bat: ask({ question: 'Use the bar?', options: [{ label: 'Yes, use the bar' }, { label: 'No' }] }),
    fay: ask({ question: 'What should we call the release?' }),
    cy: ask({ questions: [{ question: 'Proceed with plan B?', options: ['Yes', 'No'] }, { question: 'Pick a size', header: 'Size', options: ['Small', 'Large'] }] }),
  }, default: { turns: [{ name: 'default', steps: [{ text: 'OK.' }] }] } })
  await rig.waitFor(() => rig.sql(`SELECT 1 FROM ot.turns WHERE ended_at IS NULL`).length === 0, { what: 'seed turns to settle', timeout: 60000 })
  const names = ['sia', 'bat', 'fay', 'cy']
  for (const name of names) {
    await rig.op({ op: 'hire', name, parent: 'boss', tier: 'haiku', title: 'Question agent' })
    await rig.api('POST', `/api/orgs/${rig.org}/audiences`, { action: 'grant', node: name, reason: 'proof: may ask the user' })
  }
  const id = name => rig.agentRow(name).id
  const open = name => rig.one(`SELECT uid, rev FROM ot.asks WHERE agent_id = ${id(name)} AND status = 'open' ORDER BY id DESC LIMIT 1`)
  for (const name of names) {
    await rig.userMail(name, 'PROOF-ASK: ask the user.')
    await rig.waitFor(() => open(name), { what: `${name}'s card`, timeout: 60000 })
  }
  const answer = (name, body) => rig.api('POST', `/api/orgs/${rig.org}/asks/${open(name).uid}/answer`, { ...body, rev: open(name).rev })
  await answer('sia', { selected: ['Green'] })
  await rig.api('POST', `/api/orgs/${rig.org}/nodes/bat/batch`, { revs: { ask: open('bat').rev }, answers: ['Yes, use the bar'] })
  await answer('fay', { text: 'Orgtree Aurora' })
  await answer('cy', { selected: [['Yes'], ['Large']] })
  await rig.waitFor(() => names.every(n => !open(n)), { what: 'all cards settled', timeout: 30000 })
  const rows = rig.sql(`SELECT a.agent_id, a.status, a.body FROM ot.asks a ORDER BY a.id`).slice(-8)
  p.note('ask rows', rows)

  if (process.env.ORGTREE_RIG_UI) {
    const evidence = path.join(rigHome(), 'evidence', 'inbox-answered-' + Date.now())
    fs.mkdirSync(evidence, { recursive: true })
    const r = await runDesktop(rig, path.join(here, '../desktop/inbox-answered.cjs'), { out: evidence, timeout: 120000 })
    const text = JSON.stringify(r.value ?? {})
    p.check('the inbox draws answered-question cards (screenshots in ' + evidence + ')', r.ok !== false && text.includes('answered-card'), text.slice(0, 1500))
    const marks = (r.value?.seen ?? []).flatMap(x => x.cards.flatMap(c => [...(c.chosen ?? []), ...(c.typed ?? [])]))
    for (const answerText of ['Green', 'Yes, use the bar', 'Orgtree Aurora', 'Yes', 'Large'])
      p.check(`the inbox marks the answer "${answerText}" as chosen or typed`, marks.includes(answerText), marks)
  }
  p.keep(rig, { agents: names, grep: /ask|question/i })
  return p.summary()
}
