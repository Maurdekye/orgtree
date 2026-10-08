// Proof: compaction, as the engine sees it from each side.
//   cara (Claude): the CLI compacts on its own mid-turn (compact_boundary):
//         the desk shows "Context compacted" with the size before, she and her
//         superior get the compacted notice, and the turn completes.
//   cody (Claude): the user compacts him (the compact route sends /compact
//         as its own turn): the turn ends with the context marked estimated
//         and not yet run; his next ordinary turn measures it again.
//   cole (Codex): the app-server compacts the thread (thread/compacted): the
//         desk row and the notice, as for Claude.
//   carl (Claude): his superior cheap-compacts him: his next turn starts a
//         new session with the handoff note, his old conversation is saved in
//         his folder, and the old session is closed as "cheap compact".
// Run: node tools/rig/rig.mjs run tools/rig/proofs/compaction.mjs

import fs from 'node:fs'
import path from 'node:path'

import { Proof } from '../proof.mjs'

export default async function (rig) {
  const p = new Proof('compaction')
  rig.scenario({
    agents: {
      cara: { turns: [{ name: 'auto', match: 'PROOF-AUTO', once: true, steps: [
        { text: 'Reading a lot.' },
        { system: { subtype: 'compact_boundary', compact_metadata: { trigger: 'auto', pre_tokens: 180000 } } },
        { text: 'Continuing after the compaction.' },
      ] }] },
      cody: { turns: [{ name: 'compact', match: '/compact', steps: [
        { system: { subtype: 'compact_boundary', compact_metadata: { trigger: 'manual', pre_tokens: 90000 } } },
        { text: 'Compacted.' },
      ] }] },
      cole: { turns: [{ name: 'compacted', match: 'PROOF-CODEX', once: true, steps: [
        { text: 'Long thread.' },
        { raw: { jsonrpc: '2.0', method: 'thread/compacted', params: { threadId: '', turnId: '' } } },
        { text: 'Still here.' },
      ] }] },
    },
    default: { turns: [{ name: 'default', steps: [{ text: 'OK.' }] }] },
  })
  await rig.waitFor(() => rig.sql(`SELECT 1 FROM ot.turns WHERE ended_at IS NULL`).length === 0, { what: 'seed turns to settle', timeout: 60000 })
  for (const [name, tier] of [['cara', 'haiku'], ['cody', 'haiku'], ['cole', 'luna'], ['carl', 'haiku']]) {
    await rig.op({ op: 'hire', name, parent: 'boss', tier, title: 'Compaction agent' })
  }
  const id = name => rig.agentRow(name).id
  const convo = name => rig.sql(`SELECT body FROM ot.convo WHERE agent_id = ${id(name)} ORDER BY seq`).map(r => r.body)
  const notices = (to, about) => rig.sql(`SELECT body, ev FROM ot.mail WHERE recipient_agent_id = ${id(to)}
    AND ev->>'variant' = 'lifecycle.compacted' AND body LIKE '%${about}%' ORDER BY id`)
  const seat = name => rig.one(`SELECT session_id, occupancy, occupancy_est, compacted_unrun FROM ot.agents WHERE id = ${id(name)}`)
  const log = (agent, kind) => rig.fakeLog(agent).filter(l => !kind || l.kind === kind)

  // ---------------------------------------------------------------- cara: the CLI compacts mid-turn
  await rig.userMail('cara', 'PROOF-AUTO: read everything.')
  const [ct] = await rig.waitTurns('cara', 1)
  const row = convo('cara').find(b => b.kind === 'compact')
  p.check('cara: the desk shows "Context compacted" with the size before', row?.text === 'Context compacted' && row.pre_tokens === 180000, row)
  p.check('cara: the turn goes on after the compaction and completes', !ct.error
    && convo('cara').some(b => /Continuing after the compaction/.test(b.text ?? '')), ct.error)
  const caraNote = await rig.waitFor(() => notices('boss', 'cara')[0], { what: 'boss to be told', timeout: 15000 }).catch(() => null)
  p.check('cara: her superior gets the compacted notice (automatic)', caraNote?.ev?.auto === true, caraNote)

  // ---------------------------------------------------------------- cody: the user compacts him
  await rig.userMail('cody', 'Hello cody.')
  await rig.waitTurns('cody', 1)
  const started = await rig.api('POST', `/api/orgs/${rig.org}/nodes/cody/compact`)
  const cdt = await rig.waitTurns('cody', 2)
  const cs = seat('cody')
  p.check('cody: the compact route runs /compact as its own turn, and it completes', started.started && !cdt[1].error
    && /\/compact/.test(log('cody', 'turn').at(-1)?.prompt ?? ''), { started, error: cdt[1].error })
  p.check('cody: after it his context is estimated and marked not yet run', cs.occupancy_est === true && cs.compacted_unrun === true, cs)
  p.check('cody: the desk row and the notice say it was not automatic', convo('cody').some(b => b.kind === 'compact')
    && notices('boss', 'cody').some(n => n.ev?.auto === false), notices('boss', 'cody').map(n => n.ev?.auto))
  await rig.userMail('cody', 'And now?')
  await rig.waitTurns('cody', 3)
  const cs2 = seat('cody')
  p.check('cody: his next ordinary turn measures the context again', cs2.compacted_unrun === false && cs2.occupancy_est === false && cs2.occupancy > 0, cs2)

  // ---------------------------------------------------------------- cole: Codex compacts the thread
  await rig.userMail('cole', 'PROOF-CODEX: a long thread.')
  const [cot] = await rig.waitTurns('cole', 1)
  p.check('cole: thread/compacted shows "Context compacted" and the turn completes', !cot.error
    && convo('cole').some(b => b.kind === 'compact' && b.text === 'Context compacted'), cot.error)
  const coleNote = await rig.waitFor(() => notices('boss', 'cole')[0], { what: 'boss to be told about cole', timeout: 15000 }).catch(() => null)
  p.check('cole: his superior gets the compacted notice', !!coleNote, coleNote)

  // ---------------------------------------------------------------- carl: cheap compact
  await rig.userMail('carl', 'Hello carl, remember the word PELICAN.')
  await rig.waitTurns('carl', 1)
  const oldSession = seat('carl').session_id
  const cc = await rig.tool('boss', 'orgtree_cheap_compact', { node: 'carl' })
  p.check('carl: his superior cheap-compacts him', cc.ok, cc.text?.slice(0, 200))
  await rig.userMail('carl', 'Carry on, please.')
  await rig.waitTurns('carl', 2)
  const start = log('carl', 'start').at(-1)
  const prompt = log('carl', 'turn').at(-1)?.prompt ?? ''
  p.check('carl: his next turn runs on a new session, not the old one', !start?.resumed && start?.session !== oldSession
    && seat('carl').session_id === start?.session, { resumed: start?.resumed, session: start?.session, old: oldSession })
  p.check('carl: the new session starts with the handoff note', /cheap compact/.test(prompt), prompt.slice(0, 600))
  const scratch = path.join(rig.data, 'scratch', rig.org, 'carl')
  const saved = fs.existsSync(scratch) ? fs.readdirSync(scratch).filter(f => /^earlier-conversation-.*\.md$/.test(f)) : []
  p.check('carl: his earlier conversation is saved in his folder', saved.length === 1
    && /PELICAN/.test(fs.readFileSync(path.join(scratch, saved[0]), 'utf8')), saved)
  const ended = rig.one(`SELECT end_reason FROM ot.agent_sessions WHERE agent_id = ${id('carl')} AND session_id = '${oldSession}'`)
  p.check('carl: the old session is closed as "cheap compact"', ended?.end_reason === 'cheap compact', ended)

  p.keep(rig, { agents: ['cara', 'cody', 'cole', 'carl'], grep: /compact|handoff/ })
  return p.summary()
}
