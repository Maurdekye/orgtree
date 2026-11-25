// The chats panel shows "typing…" while an agent writes a message call to the user, and drops it when the
// call is written (4.7.0-alpha.5, USER 2026-11-25 15:10:27Z m558cf68fe9c1: "i dont see a typing indicator
// from you like i would in hubchat"). agent-typing-user.mjs proves the engine's flag over HTTP; this one
// proves it reaches the renderer's DmPanel over the record feed's agent_runtime frames (the overlay
// allowlist dropped it). The fake CLI streams the call like Claude Code: metadata whole, the body
// "written" for 5 s, the block ends, then the call. Needs a renderer bundle (--ui).
// Run: node tools/rig/rig.mjs run tools/rig/proofs/dm-typing-ui.mjs --ui <dir>
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runDesktop } from '../desktop.mjs'
import { Proof } from '../proof.mjs'

const sleep = ms => new Promise(r => setTimeout(r, ms))
const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'desktop', 'dm-typing.cjs')

export function setup() {
  return { session0: '0', fixture: { org: { name: 'Typing in the chats' }, agents: [{ name: 'rhea', tier: 'haiku', grant: 4 }],
    scenario: { default: { turns: [{ steps: [{ text: 'OK.' }] }] } } } }
}

export default async function (rig) {
  const p = new Proof('dm-typing-ui')
  const ev = event => ({ raw: { type: 'stream_event', parent_tool_use_id: null, event } })
  rig.scenario({ default: { turns: [
    { match: ['typing ui proof'], steps: [
      ev({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_dm_1', name: 'mcp__orgtree__orgtree_message', input: {} } }),
      ev({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"metadata": {"to": "user"}' } }),
      { sleep_ms: 5000 },
      ev({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: ', "body": "typed in the chats"}' } }),
      ev({ type: 'content_block_stop', index: 0 }),
      { sleep_ms: 3000 },
      { tool: 'orgtree_message', id: 'toolu_dm_1', args: { metadata: { to: 'user' }, body: 'typed in the chats' } },
      { text: 'Sent.' }] },
    { steps: [{ text: 'OK.' }] },
  ] } })
  // a chat with rhea exists before the proof: the user's first mail and its answer
  const ended = () => rig.turns('rhea').filter(t => t.ended_at).length
  let before = ended()
  await rig.userMail('rhea', 'hello')
  await rig.waitFor(() => ended() > before || null, { what: 'the first turn to end', timeout: 60000 })

  const out = path.join(rig.dir, 'dm-typing'); fs.rmSync(out, { recursive: true, force: true }); fs.mkdirSync(out, { recursive: true })
  const desk = runDesktop(rig, SCRIPT, { out, timeout: 240000 })
  await rig.waitFor(() => fs.existsSync(path.join(out, 'ready')) || null, { what: 'the chats panel', timeout: 120000, every: 250 })
  await sleep(1500)
  before = ended()
  const sent = Date.now()
  await rig.userMail('rhea', 'typing ui proof')
  await rig.waitFor(() => ended() > before || null, { what: 'the proof turn to end', timeout: 90000 })
  const turnEnd = Date.now()
  await sleep(2500)
  fs.writeFileSync(path.join(out, 'done'), String(Date.now()))
  const r = await desk
  // DM_TYPING_KEEP=<folder>: keep the screenshots (the rig removes its run folder)
  if (process.env.DM_TYPING_KEEP) for (const f of fs.readdirSync(out).filter(f => f.endsWith('.png')))
    fs.copyFileSync(path.join(out, f), path.join(process.env.DM_TYPING_KEEP, f))
  p.check('the desktop page ran', r.ok === true, { error: r.error ?? null, session: r.session, guards: r.guards })
  const samples = r.value?.samples ?? []
  const on = samples.filter(s => s.typing.includes('rhea'))
  const span = on.length ? on[on.length - 1].at - on[0].at : 0
  p.check('the chats show rhea typing while the call to the user is written (about 5 s)', span >= 3500 && span <= 8000,
    { ms: span, on: on.length, samples: samples.length, firstOn: on[0] ? on[0].at - sent : null })
  p.check('only rhea, nobody else', on.every(s => s.typing.length === 1))
  const lastOn = on.at(-1)?.at ?? Infinity
  const offAfter = samples.filter(s => s.at > lastOn)
  p.check('the dots are gone once the call is written, before the turn ends, and stay gone', offAfter.length >= 20
    && offAfter.every(s => s.typing.length === 0) && lastOn < turnEnd, { offAfter: offAfter.length, msBeforeTurnEnd: turnEnd - lastOn })
  p.check('and the message reached the user', rig.sql(`SELECT count(*)::int AS n FROM ot.mail WHERE sender='rhea' AND recipient_kind='user' AND body='typed in the chats'`)[0].n === 1)
  return p.summary()
}
