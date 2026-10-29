// Proof: a finished tool call is never drawn twice on the desk, as its saved chip and as its live "writing"
// row (4.5.1: the live row stayed under the saved one for 0.2-3 s; docs/rust-engine/tool-writing-and-link-menus.md).
//   the real engine plays a scripted Claude turn through the fake CLI: calls written with and without a block
//   stop, then two calls written side by side; desktop/tool-writing-desk.cjs opens boss's desk in offscreen
//   Electron and samples the transcript DOM on every mutation and every 25 ms.
// Run: node tools/rig/rig.mjs run tools/rig/proofs/tool-writing-desk.mjs   (ORGTREE_RIG_UI=<renderer bundle> picks the
// renderer; ORGTREE_RIG_ENGINE / ORGTREE_RIG_FAKECLI the binaries). Silent and isolated: see the page script.

import { SEED_SETTLE_TIMEOUT } from '../seed-settle.mjs'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Proof } from '../proof.mjs'
import { runDesktop } from '../desktop.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))

export default async function (rig, { flags = {} } = {}) {
  const p = new Proof('tool-writing-desk')
  await rig.waitFor(() => rig.sql('SELECT 1 FROM ot.turns WHERE ended_at IS NULL').length === 0,
    { what: 'seed turns idle', timeout: SEED_SETTLE_TIMEOUT })
  const stream = event => ({ raw: { type: 'stream_event', event, parent_tool_use_id: null } })
  const start = (n, index) => stream({ type: 'content_block_start', index, content_block: { type: 'tool_use', id: `toolu-call-${n}`, name: 'Bash', input: {} } })
  const delta = (index, text) => stream({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: text } })
  const stop = index => stream({ type: 'content_block_stop', index })
  const admit = n => ({ raw: { type: 'assistant', parent_tool_use_id: null, message: { id: `msg-call-${n}`, role: 'assistant',
    content: [{ type: 'tool_use', id: `toolu-call-${n}`, name: 'Bash', input: { command: `echo call-${n}` } }] } } })
  const results = ns => ({ raw: { type: 'user', parent_tool_use_id: null,
    message: { content: ns.map(n => ({ type: 'tool_result', tool_use_id: `toolu-call-${n}`, content: `call-${n}-result` })) } } })
  const steps = []
  // calls 1-3: written with a block stop, then admitted; calls 4-6: the stop omitted (the engine's admission is
  // then the generation boundary); one tool result and a short gap each, as a CLI running them one by one
  for (const n of [1, 2, 3, 4, 5, 6]) {
    steps.push(start(n, 0), delta(0, `{"command":"echo `), { sleep_ms: 350 }, delta(0, `call-${n}"}`), { sleep_ms: 250 })
    if (n <= 3) steps.push(stop(0))
    steps.push({ sleep_ms: 40 }, admit(n), { sleep_ms: 180 }, results([n]), { sleep_ms: 200 })
  }
  // calls 7 and 8 written side by side (blocks 0 and 1), the first admitted while the second is still being written
  steps.push(start(7, 0), delta(0, `{"command":"echo call-7"}`), start(8, 1), delta(1, `{"command":"echo `), { sleep_ms: 300 },
    stop(0), admit(7), { sleep_ms: 300 }, delta(1, `call-8"}`), { sleep_ms: 200 }, stop(1), admit(8), { sleep_ms: 200 },
    results([7, 8]), { sleep_ms: 200 }, { text: 'DESK-WRITING-DONE' })
  rig.scenario({ agents: { boss: { turns: [{ match: 'DESK-WRITING-PROOF', steps }] } }, default: { turns: [{ steps: [{ text: 'OK.' }] }] } })

  const evidence = path.join(p.dir, 'desktop')
  fs.mkdirSync(evidence, { recursive: true })
  const r = await runDesktop(rig, path.join(here, '../desktop/tool-writing-desk.cjs'), { preset: 'tall', out: evidence, timeout: 150000,
    args: { agent: 'boss', mail: 'DESK-WRITING-PROOF', done: 'DESK-WRITING-DONE' } })
  const v = r.value ?? {}
  p.file('sampler.json', v)
  p.check('the desktop page script ran to the end', r.ok === true, r.error ?? r.electronOutput)
  const named = n => `call-${n}`
  p.check('the sampler saw every call as a live writing row (it can see the state it hunts)',
    [1, 2, 3, 4, 5, 6, 7, 8].every(n => v.callsSeenWriting?.includes(named(n))), v.callsSeenWriting)
  p.check('...and as a saved chip', [1, 2, 3, 4, 5, 6, 7, 8].every(n => v.callsSeenSaved?.includes(named(n))), v.callsSeenSaved)
  p.check('no state of the transcript draws one call as both a saved chip and a live writing row', v.both?.length === 0,
    { states: v.both?.length, longestMs: v.bothMaxMs, first: v.both?.slice(0, 5) })
  p.check('the window was silent and isolated: audio muted, clipboard refused, session recorded',
    v.isolation?.audioMuted === true && v.isolation?.clipboard === 'NotAllowedError' && Number.isInteger(v.isolation?.sessionId), v.isolation)
  p.keep(rig, { agents: ['boss'] })
  p.note('Real scratch engine, scripted fake Claude CLI and offscreen Electron on the rig renderer bundle only; no model turn or live data.')
  return p.summary()
}
