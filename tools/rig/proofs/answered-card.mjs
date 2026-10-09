// Proof: answered questions are stored with what the card offered and draw as a mini question card.
//   sia: one question, one pick       -> answer.ask with options, multi false
//   mel: one multi-select question    -> answer.ask, two picks, multi true
//   bea: two questions, one answer    -> answer.ask with two questions
//   cy:  two questions via the batch  -> answer.batch with options per question
//   fay: a free-text question         -> answer.ask with the typed text, no options
//   dee: a question the user closes   -> dismissed, nothing highlighted
// The desktop part opens each desk offscreen and saves a screenshot of the card.
// Run: node tools/rig/rig.mjs run tools/rig/proofs/answered-card.mjs   (with ORGTREE_RIG_UI=<bundle> for the screenshots)

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Proof } from '../proof.mjs'
import { runDesktop } from '../desktop.mjs'
import { rigHome } from '../lib.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const COLOURS = [{ label: 'Red', description: 'warm' }, { label: 'Green', description: 'natural' }, { label: 'Blue', description: 'cool' }]

export default async function (rig) {
  const p = new Proof('answered-card')
  const ask = (args) => ({ turns: [{ name: 'ask', match: 'PROOF-ASK', once: true, steps: [
    { tool: 'orgtree_ask', args, expect: "user's desk" }, { text: 'Asked.' }] }] })
  rig.scenario({ agents: {
    sia: ask({ question: 'Which colour should the button be?', header: 'Colour', options: COLOURS }),
    mel: ask({ question: 'Which platforms do we ship?', header: 'Platforms', multi: true,
      options: [{ label: 'Windows', description: 'the main build' }, { label: 'macOS' }, { label: 'Linux', description: 'AppImage' }] }),
    bea: ask({ questions: [{ question: 'Ship it today?', header: 'Ship', options: ['Yes', 'No'] },
      { question: 'Which colour?', header: 'Colour', options: COLOURS }] }),
    cy: ask({ questions: [{ question: 'Proceed with plan B?', options: ['Yes', 'No'] },
      { question: 'Pick a size', header: 'Size', options: [{ label: 'Small', description: 'compact' }, { label: 'Large' }] }] }),
    fay: ask({ question: 'What should we call the release?' }),
    dee: ask({ question: 'Delete the old branch?', options: ['Yes', 'No'] }),
  }, default: { turns: [{ name: 'default', steps: [{ text: 'OK.' }] }] } })
  await rig.waitFor(() => rig.sql(`SELECT 1 FROM ot.turns WHERE ended_at IS NULL`).length === 0, { what: 'seed turns to settle', timeout: 60000 })
  const names = ['sia', 'mel', 'bea', 'cy', 'fay', 'dee']
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
  await answer('mel', { selected: ['Windows', 'Linux'] })
  await answer('bea', { selected: [['Yes'], ['Blue']] })
  await rig.api('POST', `/api/orgs/${rig.org}/nodes/cy/batch`, { revs: { ask: open('cy').rev }, answers: ['No', 'Large'] })
  await answer('fay', { text: 'Orgtree Aurora' })
  await answer('dee', { dismiss: true })
  await rig.waitFor(() => names.every(n => !open(n)), { what: 'all cards settled', timeout: 30000 })

  const ev = name => rig.sql(`SELECT ev FROM ot.mail WHERE recipient_agent_id = ${id(name)} AND sender = '@user' AND ev IS NOT NULL ORDER BY id`)
    .map(r => r.ev).filter(e => e && /^answer\./.test(e.variant)).at(-1)
  const sia = ev('sia'), mel = ev('mel'), bea = ev('bea'), cy = ev('cy'), fay = ev('fay'), dee = ev('dee')
  const labels = q => (q?.options ?? []).map(o => o.label).join(',')
  p.check('sia: the stored answer lists every offered option, with descriptions, and the pick', sia?.variant === 'answer.ask'
    && labels(sia.questions[0]) === 'Red,Green,Blue' && sia.questions[0].options[0].description === 'warm'
    && sia.questions[0].selected.join() === 'Green' && sia.questions[0].multi === false, sia)
  p.check('mel: a multi-select keeps both picks and the multi flag', mel?.questions?.[0]?.multi === true
    && mel.questions[0].selected.join() === 'Windows,Linux' && labels(mel.questions[0]) === 'Windows,macOS,Linux', mel)
  p.check("bea: a two-question answer keeps each question's options and pick", bea?.questions?.length === 2
    && labels(bea.questions[0]) === 'Yes,No' && bea.questions[0].selected.join() === 'Yes'
    && labels(bea.questions[1]) === 'Red,Green,Blue' && bea.questions[1].selected.join() === 'Blue', bea)
  const sec = cy?.sections?.find(s => s.kind === 'ask')
  p.check('cy: a resolved request keeps options and picks per question', cy?.variant === 'answer.batch' && sec?.questions?.length === 2
    && labels(sec.questions[1]) === 'Small,Large' && sec.questions[1].selected.join() === 'Large'
    && sec.questions[0].selected.join() === 'No', cy)
  p.check('fay: a free-text question stores the typed text and no options', fay?.text === 'Orgtree Aurora'
    && !fay.questions[0].options && fay.questions[0].selected.length === 0, fay)
  p.check('dee: a dismissed question is marked dismissed with nothing picked and its options kept', dee?.dismissed === true
    && dee.questions[0].selected.length === 0 && labels(dee.questions[0]) === 'Yes,No', dee)

  if (process.env.ORGTREE_RIG_UI) {
    const evidence = path.join(rigHome(), 'evidence', 'answered-card-' + Date.now())
    fs.mkdirSync(evidence, { recursive: true })
    for (const name of names) {
      const r = await runDesktop(rig, path.join(here, '../desktop/answered-card.cjs'), { args: { agent: name }, out: path.join(evidence, name), timeout: 90000 })
      p.check(`${name}: the desk shows the mini card (screenshot in ${evidence})`, r.ok !== false && JSON.stringify(r).includes('answered-') || JSON.stringify(r).includes('question'), JSON.stringify(r).slice(0, 500))
    }
  }
  return p.finish ? p.finish() : p
}
