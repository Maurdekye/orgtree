// Proof: a debug engine runs a first Codex turn and a first Claude turn on
// the default 2 MiB worker stack. At rust-engine 9edbc13 it overflowed
// ("thread 'engine' has overflowed its stack", exit 0xC00000FD) as soon as a
// first Codex turn entered Actor.ensure_proc: the turn path's debug poll
// frames (run, handle_msg, on_slot, start_turn, ensure_proc) held about
// 1.6 MiB of inline-awaited futures. They are now awaited through `boxed`
// (runtime/actor.rs; docs/rust-engine/tool-cards.md#stack-safety).
// The tool path runs on it too: a project create (an agent wrapping itself,
// through the rig's tool route), a two-slot claim with its status and
// release, and an agent's own MCP call that creates a project. At 1cbaac2
// the project create overflowed: tools::dispatch and
// ops::run_in_tx_without_audience_notices awaited every handler inline, about
// 1 MiB of poll frame between them (project-mail-boundaries and
// project-multi-slots runs); their arms are now built through util::boxed.
// Run with RUST_MIN_STACK unset, against a debug engine:
//   ORGTREE_RIG_HOME=C:/orgtree-build/<you>/rig ORGTREE_RIG_ENGINE=<debug orgtree-engine.exe>
//   node tools/rig/rig.mjs run tools/rig/proofs/debug-stack-first-turn.mjs

import { SEED_SETTLE_TIMEOUT } from '../seed-settle.mjs'
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
    { what: 'seed turns to settle', timeout: SEED_SETTLE_TIMEOUT }).catch(() => {})
  for (const [name, harness] of [['boss', 'Codex'], ['cleo', 'Claude']]) {
    if (overflowed()) break
    const before = rig.turns(name).filter(t => t.ended_at).length
    await rig.userMail(name, 'Say OK.')
    const seen = await rig.waitFor(() => overflowed() ? 'overflow'
      : rig.turns(name).filter(t => t.ended_at && !t.error).length > before ? 'done' : null,
    { what: `${name}'s first turn`, timeout: 90000 }).catch(e => String(e))
    p.check(`a first ${harness} turn (${name}) runs to its end`, seen === 'done', seen)
  }

  // ------------------------------------------------------------ the tool path
  const said = r => String(r?.text ?? r).slice(0, 300)
  const call = (who, tool, args) => rig.tool(who, tool, args).catch(e => ({ ok: false, text: String(e) }))
  if (!overflowed()) {
    await rig.op({ op: 'hire', name: 'wrapme', parent: 'boss', tier: 'sol', grant: 5 })
    const wrap = await call('wrapme', 'orgtree_project', { action: 'create', name: 'wrapped', above: 'wrapme', index: 0 })
    p.check('a project created through the tool path (an agent wrapping itself) completes', wrap.ok && !overflowed(), said(wrap))
  }
  if (!overflowed()) {
    await rig.op({ op: 'create_project', name: 'build', parent: 'boss' })
    await rig.op({ op: 'set_slots', node: 'build', capacity: 3 })
    await rig.op({ op: 'hire', name: 'v', parent: 'build', tier: 'sol', grant: 0 })
    const claim = await call('v', 'orgtree_watchdog', { action: 'create', name: 'pair', kind: 'slot', target: 'build', slots: 2 })
    const status = overflowed() ? null : await call('boss', 'orgtree_project', { action: 'slots', name: 'build' })
    const lease = overflowed() ? null : rig.one("SELECT l.uid FROM ot.slot_leases l JOIN ot.agents a ON a.id = l.holder_agent_id WHERE a.name = 'v' AND l.ended_at IS NULL")?.uid
    const rel = lease ? await call('v', 'orgtree_project', { action: 'release_slot', lease, note: 'stack proof' }) : null
    p.check('a two-slot claim, its status and its release through the tool path complete',
      claim.ok && status?.ok && status.json?.held === 2 && rel?.ok && !overflowed(),
      { claim: said(claim), held: status?.json?.held ?? null, release: rel ? said(rel) : null })
  }
  if (!overflowed()) {
    rig.scenario({ default: { turns: [
      { match: ['make a project'], steps: [
        { tool: 'orgtree_project', id: 'toolu_stack_project', args: { action: 'create', name: 'squad', index: 0 } },
        { text: 'Made.' }] },
      { name: 'default', steps: [{ text: 'OK.' }] },
    ] } })
    const before = rig.turns('boss').filter(t => t.ended_at).length
    await rig.userMail('boss', 'make a project')
    const seen = await rig.waitFor(() => overflowed() ? 'overflow'
      : rig.turns('boss').filter(t => t.ended_at).length > before ? 'done' : null,
    { what: "boss's project turn", timeout: 90000 }).catch(e => String(e))
    const squad = overflowed() ? null : rig.one("SELECT id FROM ot.agents WHERE name = 'squad' AND state = 'live'")
    p.check("an agent's own MCP call creates a project (a Codex turn's orgtree_project)", seen === 'done' && !!squad, { seen, squad })
  }
  p.check('the engine never overflowed its stack', !overflowed(),
    stderr().split(/\r?\n/).filter(l => /overflowed|engine exited/.test(l)).slice(-3))
  p.keep(rig, { agents: ['boss', 'cleo', 'wrapme', 'v'], grep: /overflowed|ensure_proc\(|turn could not start|create_project|slot_release/ })
  return p.summary()
}
