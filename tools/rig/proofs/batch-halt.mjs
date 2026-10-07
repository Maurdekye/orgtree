// Proof: batch Halt / Unhalt from the menus, through the real renderer in
// offscreen Electron with CDP-dispatched (trusted) mouse input, checked in
// the database after each step.
//   1. boss card › Halt… › subtree (short viewport)  → boss, alice, bob, carol halted
//   2. eye card › Unhalt all agents… (tall viewport)  → all released
//   3. carol busy in a long turn; eye › Halt all agents… → all halted, carol's
//      running turn interrupted (the fake CLI sees the interrupt)
//   4. alice card › Unhalt… › subtree                 → alice, bob released; boss, carol stay halted
//   5. mail to halted carol waits; no turn starts
// Run: node tools/rig/rig.mjs run tools/rig/proofs/batch-halt.mjs

import path from 'node:path'

import { runDesktop } from '../desktop.mjs'
import { RIG_DIR } from '../lib.mjs'
import { Proof } from '../proof.mjs'

const menu = path.join(RIG_DIR, 'desktop', 'menu-action.cjs')

export default async function (rig) {
  const p = new Proof('batch-halt')
  rig.scenario({
    agents: { carol: { turns: [{ name: 'long', match: 'PROOF-LONG', once: true, steps: [{ text: 'Working a long time.' }, { sleep_ms: 120000 }, { text: 'done' }] }] } },
    default: { turns: [{ steps: [{ text: 'OK.' }] }] },
  })
  await rig.waitFor(() => rig.sql(`SELECT 1 FROM ot.turns WHERE ended_at IS NULL`).length === 0, { what: 'seed turns to settle', timeout: 60000 })
  const halted = () => Object.fromEntries(rig.sql(`SELECT a.name, a.halt->>'phase' AS phase FROM ot.agents a JOIN ot.orgs o ON o.id = a.org_id
                                                    WHERE o.slug = '${rig.org}' AND a.state = 'live' ORDER BY a.id`).map(r => [r.name, r.phase]))
  const act = async (args, preset = 'short') => {
    const r = await runDesktop(rig, menu, { args, preset, out: path.join(p.dir, `${args.shot}-${preset}`) })
    p.check(`${args.shot}: menu path ${args.card} › ${args.path.join(' › ')} confirmed with "${r.value?.button}" → toast "${r.value?.toast}"`, r.ok, r.ok ? r.value : r.error)
    return r
  }

  // 1. Halt subtree from boss's card
  await act({ card: 'boss', path: ['Halt…', 'subtree'], confirm: '^halt 4 agents$', toast: '^Halted 4 agents\\.$', shot: 'halt-subtree' })
  let h = halted()
  p.check('1: boss, alice, bob, carol are halted', Object.values(h).every(x => x === 'halted') && Object.keys(h).length === 4, h)

  // 2. Unhalt all from the eye card (tall viewport)
  await act({ card: 'eye', path: ['Unhalt all agents…'], confirm: '^unhalt 4 agents$', toast: '^Released 4 agents\\.$', shot: 'unhalt-all' }, 'tall')
  h = halted()
  p.check('2: every agent released', Object.values(h).every(x => x === null), h)

  // 3. Halt all while carol is mid-turn
  await rig.userMail('carol', 'PROOF-LONG: a long job.')
  await rig.waitFor(() => rig.fakeLog('carol').some(l => l.kind === 'turn' && l.script === 'long'), { what: 'carol to start her long turn', timeout: 30000 })
  await act({ card: 'eye', path: ['Halt all agents…'], confirm: '^halt 4 agents$', toast: '^Halted 4 agents\\.$', shot: 'halt-all' })
  h = halted()
  p.check('3: every agent halted', Object.values(h).every(x => x === 'halted'), h)
  // a halt ends the turn by killing the CLI's process tree (actor.rs halt → kill_proc), not by an interrupt
  const carolTurn = await rig.waitFor(() => { const t = rig.turns('carol').at(-1); return t?.ended_at ? t : null }, { what: 'carol\'s turn to end', timeout: 30000 })
  p.check('3: carol\'s running turn ended, marked killed', carolTurn.killed === true, carolTurn)
  const longTurn = rig.fakeLog('carol').filter(l => l.kind === 'turn' && l.script === 'long').at(-1)
  const after = rig.fakeLog('carol').filter(l => l.pid === longTurn?.pid && Date.parse(l.ts) > Date.parse(longTurn?.ts))
  p.check('3: carol\'s CLI was stopped mid-step (no turn_end, no result sent)',
    !after.some(l => l.kind === 'turn_end' || (l.kind === 'send' && l.line?.type === 'result')), after.map(l => l.kind))

  // 4. Unhalt alice's subtree
  await act({ card: 'alice', path: ['Unhalt…', 'subtree'], confirm: '^unhalt 2 agents$', toast: '^Released 2 agents\\.$', shot: 'unhalt-alice-subtree' })
  h = halted()
  p.check('4: alice and bob released; boss and carol still halted', h.alice === null && h.bob === null && h.boss === 'halted' && h.carol === 'halted', h)

  // 5. a halted agent's mail waits
  const before = rig.turns('carol').length
  const sent = await rig.userMail('carol', 'PROOF-WAIT: are you there?')
  p.check('5: mail to a halted agent is accepted and says it waits', sent.accepted && sent.halted === true, sent)
  await new Promise(r => setTimeout(r, 5000))
  const pending = rig.one(`SELECT m.state FROM ot.mail m WHERE m.body = 'PROOF-WAIT: are you there?'`)
  p.check('5: it stays pending and starts no turn', pending?.state === 'pending' && rig.turns('carol').length === before, { state: pending?.state, turns: rig.turns('carol').length, before })

  p.keep(rig, { agents: ['carol'], grep: /halt|interrupt/i })
  return p.summary()
}
