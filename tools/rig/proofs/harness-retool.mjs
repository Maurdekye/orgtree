// Proof: an agent changes a report's harness with orgtree_retool's `harness`
// (@item:orgtree/harness-everywhere-harness-row-in-the-hire-dialo, USER
// 2026-10-30 07:36:24Z "fix both yes"), through the real engine and the fake
// CLIs, by the same path as the Model tab's Harness row (harness-pin.mjs):
//   its superior's retool pins an OpenRouter seat to Codex: nothing moves
//     until its next turn boundary, which ends the Claude session ("harness
//     switch") and starts the turn on the fake Codex, told why;
//   "follow" moves it back to its key's harness the same way;
//   a retool naming a harness with other fields applies both;
//   a harness the lane does not offer, and a seat on another provider, are
//     refused, and nothing is written.
// The key and favorite come from a 3.x openrouter\state.json (harness-pin.mjs).
// Run: node tools/rig/rig.mjs run tools/rig/proofs/harness-retool.mjs

import { Proof } from '../proof.mjs'
import { setup as pinSetup } from './harness-pin.mjs'

const TIER = 'or-rig-fake-model'
const AGENT = 'pilot'
const OTHER = 'scribe'

export async function setup() {
  return { ...(await pinSetup()), name: 'harness-retool' }
}

export default async function (rig) {
  const p = new Proof('harness-retool')
  rig.scenario({ default: { turns: [{ name: 'default', steps: [{ text: 'OK.' }] }] } })
  const extra = (name = AGENT) => rig.agentRow(name)?.extra ?? {}
  const sessions = () => rig.sql(`SELECT s.id, s.ended_at, s.end_reason FROM ot.agent_sessions s JOIN ot.agents a ON a.id = s.agent_id
                                  WHERE a.name = '${AGENT}' ORDER BY s.id`)
  const switched = () => sessions().filter(s => s.end_reason === 'harness switch').length
  const starts = () => rig.fakeLog(AGENT).filter(l => l.kind === 'start')
  const cliOf = s => s && ('codex_home' in s ? 'codex' : 'claude')
  const done = () => rig.turns(AGENT).filter(t => t.ended_at).length
  const turn = async text => {
    const before = done(), logged = rig.fakeLog(AGENT).length
    await rig.userMail(AGENT, text)
    await rig.waitTurns(AGENT, before + 1, { timeout: 120000 })
    return rig.fakeLog(AGENT).slice(logged)
  }
  const retool = (node, args) => rig.tool('boss', 'orgtree_retool', { node, ...args }).then(r => r, e => ({ ok: false, text: e.message }))

  // ------------------------------------------------------------- following its key
  await rig.op({ op: 'hire', name: AGENT, parent: 'boss', tier: TIER, grant: 1, title: 'Harness retool' })
  await rig.op({ op: 'hire', name: OTHER, parent: 'boss', tier: 'opus', title: 'Another provider' })
  await rig.waitFor(() => rig.sql(`SELECT 1 FROM ot.turns WHERE ended_at IS NULL`).length === 0, { what: 'hire turns to settle', timeout: 60000 })
  await turn('PROOF-RETOOL-1: first turn.')
  p.check('hired on the key, its first turn ran on Claude Code with no pin',
    extra().harness === 'claude-code' && !extra().harness_pin && cliOf(starts().at(-1)) === 'claude',
    { extra: extra(), last: cliOf(starts().at(-1)) })

  // ------------------------------------------------------------- refusals write nothing
  const unknown = await retool(AGENT, { harness: 'antigravity' })
  p.check('a harness its lane does not offer is refused, naming the choices', !unknown.ok
    && /claude-code, codex-cli, opencode/.test(unknown.text ?? '') && !extra().harness_pin, { unknown, extra: extra() })
  const other = await retool(OTHER, { harness: 'codex-cli' })
  p.check('a seat on another provider is refused: it runs on its own CLI', !other.ok
    && /only for OpenRouter and language model server agents/.test(other.text ?? '') && !extra(OTHER).harness_pin, { other, extra: extra(OTHER) })

  // ------------------------------------------------------------- its superior pins it to Codex
  const pinned = await retool(AGENT, { harness: 'codex-cli' })
  p.check('the retool records the pin and moves nothing yet', pinned.ok && pinned.json?.harness?.pin === 'codex-cli'
    && pinned.json?.harness?.applies === 'next_turn' && extra().harness_pin === true && extra().harness_pin_to === 'codex-cli'
    && extra().harness === 'claude-code' && switched() === 0, { pinned: pinned.json ?? pinned.text, extra: extra() })
  const sent1 = await turn('PROOF-RETOOL-2: after the retool.')
  p.check('its next turn ended the Claude session at the boundary (harness switch)', switched() === 1, sessions())
  p.check('and ran on the fake Codex, its stamp now Codex', extra().harness === 'codex-cli' && cliOf(starts().at(-1)) === 'codex',
    { extra: extra(), last: starts().at(-1) })
  p.check('the fresh session was handed the cause',
    JSON.stringify(sent1).includes('its harness was set to Codex in its settings (it ran on Claude Code)'), sent1.map(l => l.kind))

  // ------------------------------------------------------------- follow its key again
  const follow = await retool(AGENT, { harness: 'follow' })
  p.check('"follow" clears the pin, nothing moves yet', follow.ok && follow.json?.harness?.pin === null
    && follow.json?.harness?.was === 'codex-cli' && !extra().harness_pin && !('harness_pin_to' in extra()) && extra().harness === 'codex-cli',
    { follow: follow.json ?? follow.text, extra: extra() })
  const sent2 = await turn('PROOF-RETOOL-3: following the key again.')
  p.check('the next boundary moved it back to its key\'s Claude Code, naming the key', switched() === 2 && extra().harness === 'claude-code'
    && cliOf(starts().at(-1)) === 'claude' && JSON.stringify(sent2).includes('its OpenRouter key now runs on Claude Code (it ran on Codex)'),
    { sessions: sessions(), extra: extra() })

  // ------------------------------------------------------------- with other fields
  const both = await retool(AGENT, { harness: 'codex-cli', charter: 'PROOF-RETOOL charter, set with its harness.' })
  p.check('a retool with a harness and a charter applies both', both.ok && both.json?.harness?.pin === 'codex-cli'
    && extra().harness_pin_to === 'codex-cli' && rig.agentRow(AGENT)?.charter === 'PROOF-RETOOL charter, set with its harness.',
    { both: both.json ?? both.text, extra: extra() })

  p.keep(rig, { agents: [AGENT, OTHER], grep: /harness|switch|pilot|retool|panic/i })
  return p.summary()
}
