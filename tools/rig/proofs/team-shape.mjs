// Proof: teams are flat by default (decision 65; user 2026-10-09: "Keep a team
// flat by default. Subdivide it (put a manager between you and a group of
// reports) only when coordinating and collaborating with all your direct
// reports starts to take up too much bandwidth for one agent.").
//   wren (a new report) and boss (top level): their launch instructions carry
//   the rule.
//   the bundled coordinator charter preset agrees with it: its "Never hire
//   deeper" is gone, and it keeps the team flat by default, subdividing only
//   for bandwidth.
// Run: node tools/rig/rig.mjs run tools/rig/proofs/team-shape.mjs

import fs from 'node:fs'

import { Proof } from '../proof.mjs'

const RULE = 'KEEP A TEAM FLAT BY DEFAULT. Subdivide it (put a manager between you and a group of reports) only when '
  + 'coordinating and collaborating with all your direct reports starts to take up too much bandwidth for one agent.'

export default async function (rig) {
  const p = new Proof('team-shape')
  rig.scenario({ default: { turns: [{ name: 'default', steps: [{ text: 'OK.' }] }] } })
  await rig.waitFor(() => rig.sql('SELECT 1 FROM ot.turns WHERE ended_at IS NULL').length === 0, { what: 'seed turns to settle', timeout: 60000 })
  await rig.op({ op: 'hire', name: 'wren', parent: 'boss', tier: 'haiku', title: 'New report' })
  for (const name of ['wren', 'boss']) {
    const done = rig.turns(name).length
    await rig.userMail(name, `Hello ${name}.`)
    await rig.waitTurns(name, done + 1)
  }
  // the instructions file each CLI was launched with (--append-system-prompt-file)
  const identity = name => {
    const args = rig.fakeLog(name).filter(l => l.kind === 'start').at(-1)?.args ?? []
    const at = args.indexOf('--append-system-prompt-file')
    const file = at >= 0 ? args[at + 1] : null
    return file && fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
  }
  for (const name of ['wren', 'boss']) {
    const text = identity(name)
    p.check(`${name}: the instructions say to keep a team flat by default and to subdivide it only when coordinating all direct reports takes too much bandwidth`,
      text.includes(RULE), { bytes: text.length, at: text.indexOf('FLAT BY DEFAULT') })
  }
  const presets = await rig.api('GET', '/api/charters')
  const coordinator = (presets.charters ?? []).find(c => c.file === 'coordinator.md')
  const content = coordinator?.content ?? ''
  p.check('the bundled coordinator charter preset agrees: no "Never hire deeper"; flat by default, a manager only for bandwidth',
    coordinator?.source === 'bundled' && !/never hire deeper/i.test(content)
      && /Keep the team flat by default: put a manager between you and a\s+group of reports only when/.test(content)
      && /too much bandwidth for one agent/.test(content),
    { source: coordinator?.source, rule6: content.slice(content.indexOf('6. ONE AGENT'), content.indexOf('6. ONE AGENT') + 420) })
  p.keep(rig, { agents: ['wren'] })
  return p.summary()
}
