// Proof: an agent's own harness, chosen in its settings (the Model tab's
// Harness row; @item:orgtree/harness-setting-in-an-agent-s-model-tab-change-a,
// USER 2026-10-29 14:26:39Z), through the real engine and the fake CLIs:
//   an OpenRouter seat follows its key's harness (Claude Code);
//   the row's read names that, and offers the installed harnesses;
//   the user's `harness` op pins it to Codex: nothing moves until its next
//     turn boundary, which ends the Claude session ("harness switch"), leaves
//     the handoff naming the cause and a summary row, and starts the turn on
//     the fake Codex with the handoff in what it is sent;
//   Follow (null) moves it back to its key's harness the same way;
//   an agent cannot set it.
// The key and favorite come from a 3.x openrouter\state.json, as in
// openrouter-lane.mjs.
// Run: node tools/rig/rig.mjs run tools/rig/proofs/harness-pin.mjs

import fs from 'node:fs'
import path from 'node:path'

import { Proof } from '../proof.mjs'

const TIER = 'or-rig-fake-model'
const AGENT = 'pilot'
const FULL = { label: 'rig key', limit: null, limit_remaining: null, limit_reset: null, usage: 1.5, usage_daily: 0.5, usage_weekly: 1,
               usage_monthly: 1.5, is_free_tier: false, total_credits: 10, total_usage: 1.5 }

export async function setup() {
  return {
    name: 'harness-pin',
    prepare: async ({ data }) => {
      fs.mkdirSync(path.join(data, 'openrouter'), { recursive: true })
      fs.writeFileSync(path.join(data, 'openrouter', 'state.json'), JSON.stringify({
        key: 'sk-or-rig-not-a-real-key',
        favorites: [{ id: 'rig/fake-model', tier: TIER, name: 'Rig fake model', vendor: 'rig', prompt: 1, completion: 2, context: 100000, tools: true }],
      }))
      const dir = path.join(data, 'rig-home', 'rig-usage')
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, 'openrouter-key.json'), JSON.stringify({ status: 200, data: FULL }))
    },
  }
}

export default async function (rig) {
  const p = new Proof('harness-pin')
  rig.scenario({ default: { turns: [{ name: 'default', steps: [{ text: 'OK.' }] }] } })
  const extra = () => rig.agentRow(AGENT)?.extra ?? {}
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
  const chatText = async () => JSON.stringify(await rig.api('GET', `/api/orgs/${rig.org}/nodes/${AGENT}/chat?last=80`))

  // ------------------------------------------------------------- following its key
  await rig.op({ op: 'hire', name: AGENT, parent: 'boss', tier: TIER, grant: 1, title: 'Harness pin' })
  await rig.waitFor(() => rig.sql(`SELECT 1 FROM ot.turns WHERE ended_at IS NULL`).length === 0, { what: 'hire turns to settle', timeout: 60000 })
  await turn('PROOF-HARNESS-1: first turn.')
  p.check('hired on the key, its first turn ran on Claude Code with no pin',
    extra().harness === 'claude-code' && !extra().harness_pin && cliOf(starts().at(-1)) === 'claude',
    { extra: extra(), last: cliOf(starts().at(-1)) })
  const row = await rig.api('GET', `/api/orgs/${rig.org}/nodes/${AGENT}/harness?tier=${TIER}`)
  const codexChoice = (row.options ?? []).find(o => o.id === 'codex-cli')
  p.check('the row reads: Follow key (Claude Code), no pin, Codex offered', row.lane === 'openrouter' && row.follow?.id === 'claude-code'
    && row.follow?.source === 'key' && row.pin === null && row.current === 'claude-code' && codexChoice?.available === true && row.moves === false, row)

  // ------------------------------------------------------------- an agent cannot set it
  const byAgent = await rig.tool('boss', 'orgtree_retool', { node: AGENT, harness: 'codex-cli' }).then(r => ({ ok: true, r }), e => ({ ok: false, e: e.message }))
  p.check('an agent has no way to set it (no tool field moves the pin)', !extra().harness_pin, { byAgent, extra: extra() })

  // ------------------------------------------------------------- the user pins it to Codex
  const pinned = await rig.op({ op: 'harness', node: AGENT, harness: 'codex-cli' })
  const results = pinned.results ?? [pinned]
  p.check('the harness op records the pin and moves nothing yet', results.at(-1)?.harness === 'codex-cli'
    && extra().harness_pin === true && extra().harness_pin_to === 'codex-cli' && extra().harness === 'claude-code' && switched() === 0,
    { pinned, extra: extra() })
  p.check('the op entered the undo history', !!pinned.history_entry, pinned.history_entry ?? null)
  const sent1 = await turn('PROOF-HARNESS-2: after the pin.')
  p.check('its next turn ended the Claude session at the boundary (harness switch)', switched() === 1, sessions())
  p.check('and ran on the fake Codex, its stamp now Codex', extra().harness === 'codex-cli' && cliOf(starts().at(-1)) === 'codex',
    { extra: extra(), last: starts().at(-1) })
  const why1 = 'its harness was set to Codex in its settings (it ran on Claude Code)'
  p.check('the fresh session was handed the cause', JSON.stringify(sent1).includes(why1), sent1.map(l => l.kind))
  p.check('the transcript shows the switch', (await chatText()).includes('Harness switch: ' + why1))
  const row2 = await rig.api('GET', `/api/orgs/${rig.org}/nodes/${AGENT}/harness?tier=${TIER}`)
  p.check('the row reads its own harness now', row2.pin === 'codex-cli' && row2.current === 'codex-cli', row2)

  // ------------------------------------------------------------- Follow key again
  await rig.op({ op: 'harness', node: AGENT, harness: null })
  p.check('Follow clears the pin, nothing moves yet', !extra().harness_pin && !('harness_pin_to' in extra()) && extra().harness === 'codex-cli', extra())
  const sent2 = await turn('PROOF-HARNESS-3: following the key again.')
  const why2 = 'its OpenRouter key now runs on Claude Code (it ran on Codex)'
  p.check('the next boundary moved it back to its key\'s Claude Code', switched() === 2 && extra().harness === 'claude-code'
    && cliOf(starts().at(-1)) === 'claude', { sessions: sessions(), extra: extra() })
  p.check('with the key named as the cause', JSON.stringify(sent2).includes(why2), sent2.map(l => l.kind))

  p.keep(rig, { agents: [AGENT], grep: /harness|switch|pilot|panic/i })
  return p.summary()
}
