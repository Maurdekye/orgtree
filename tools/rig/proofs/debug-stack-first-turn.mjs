// Proof: a debug engine runs a first Codex turn and a first Claude turn on
// the default 2 MiB worker stack. At rust-engine 9edbc13 it overflowed
// ("thread 'engine' has overflowed its stack", exit 0xC00000FD) as soon as a
// first Codex turn entered Actor.ensure_proc: the turn path's debug poll
// frames (run, handle_msg, on_slot, start_turn, ensure_proc) held about
// 1.6 MiB of inline-awaited futures. They are now awaited through `boxed`
// (runtime/actor.rs; docs/rust-engine/tool-cards.md#stack-safety).
// Run with RUST_MIN_STACK unset, against a debug engine:
//   ORGTREE_RIG_HOME=C:/orgtree-build/<you>/rig ORGTREE_RIG_ENGINE=<debug orgtree-engine.exe>
//   node tools/rig/rig.mjs run tools/rig/proofs/debug-stack-first-turn.mjs

import fs from 'node:fs'
import path from 'node:path'
import { Proof } from '../proof.mjs'

export async function setup() {
  return { fixture: { org: { name: 'First turn stack' }, agents: [
    { name: 'boss', tier: 'sol', grant: 100 },
    { name: 'cleo', tier: 'haiku', grant: 0 },
  ] } }
}

export default async function (rig) {
  const p = new Proof('debug-stack-first-turn')
  // the engine's stderr, where a stack overflow is reported, goes to keeper.log
  const stderr = () => { try { return fs.readFileSync(path.join(rig.dir, 'keeper.log'), 'utf8') } catch { return '' } }
  const overflowed = () => /overflowed its stack/.test(stderr())
  p.check('the engine has the default stack: RUST_MIN_STACK is not set', !process.env.RUST_MIN_STACK, process.env.RUST_MIN_STACK ?? null)
  rig.scenario({ default: { turns: [{ name: 'default', steps: [{ text: 'OK.' }] }] } })
  await rig.waitFor(() => overflowed() || rig.sql(`SELECT 1 FROM ot.turns WHERE ended_at IS NULL`).length === 0,
    { what: 'seed turns to settle', timeout: 60000 }).catch(() => {})
  for (const [name, harness] of [['boss', 'Codex'], ['cleo', 'Claude']]) {
    if (overflowed()) break
    const before = rig.turns(name).filter(t => t.ended_at).length
    await rig.userMail(name, 'Say OK.')
    const seen = await rig.waitFor(() => overflowed() ? 'overflow'
      : rig.turns(name).filter(t => t.ended_at && !t.error).length > before ? 'done' : null,
    { what: `${name}'s first turn`, timeout: 90000 }).catch(e => String(e))
    p.check(`a first ${harness} turn (${name}) runs to its end`, seen === 'done', seen)
  }
  p.check('the engine never overflowed its stack', !overflowed(),
    stderr().split(/\r?\n/).filter(l => /overflowed|engine exited/.test(l)).slice(-3))
  p.keep(rig, { agents: ['boss', 'cleo'], grep: /overflowed|ensure_proc\(|turn could not start/ })
  return p.summary()
}
