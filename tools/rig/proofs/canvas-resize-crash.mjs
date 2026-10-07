// Proof for finding F1: the org canvas must survive a viewport resize right
// after it mounts (it crashed with "Maximum update depth exceeded").
// Each attempt is a fresh Electron profile that loads the canvas `loads`
// times and switches the viewport right after each load.
// Run: node tools/rig/rig.mjs run tools/rig/proofs/canvas-resize-crash.mjs --ui <renderer dir> [--attempts 3]

import path from 'node:path'

import { runDesktop } from '../desktop.mjs'
import { RIG_DIR } from '../lib.mjs'
import { Proof } from '../proof.mjs'

export default async function (rig, { flags }) {
  const p = new Proof('canvas-resize-crash')
  p.note(`renderer bundle: ${rig.run.ui}`)
  rig.scenario({ agents: { carol: { turns: [{ match: 'LONG', steps: [{ text: 'Working a long time.' }, { sleep_ms: 600000 }] }] } },
                 default: { turns: [{ steps: [{ text: 'OK.' }] }] } })
  await rig.waitFor(() => rig.sql(`SELECT 1 FROM ot.turns WHERE ended_at IS NULL`).length === 0, { what: 'seed turns to settle', timeout: 60000 })
  await rig.userMail('carol', 'LONG job please')   // a busy agent while the canvas loads, as in the first sighting
  const attempts = Number(flags.attempts ?? 3)
  let crashes = 0, loads = 0
  for (let i = 0; i < attempts; i++) {
    const r = await runDesktop(rig, path.join(RIG_DIR, 'desktop', 'watch-crash.cjs'), {
      preset: 'tall', args: { loads: 6, ms: 3000, sizes: ['short', 'tall', 'wide'] }, out: path.join(p.dir, `attempt-${i + 1}`) })
    if (!r.ok) { p.check(`attempt ${i + 1} ran`, false, r.error); continue }
    crashes += r.value.crashes
    loads += r.value.loads.length
    p.note(`attempt ${i + 1}: ${r.value.loads.map(l => (l.crashed ? 'X' : '.') + l.size.join('x')).join(' ')}`,
      r.value.consoleErrors.filter(e => /Maximum update depth|React error #185/.test(e)).slice(0, 1))
  }
  const reports = await rig.api('GET', '/api/crash-reports')
  p.file('crash-reports.json', reports)
  p.check(`no crash screen in ${loads} loads over ${attempts} fresh profiles`, crashes === 0, { crashes, loads })
  p.check('no crash report stored by the engine', (reports.reports ?? []).length === 0, (reports.reports ?? []).map(r => r.message?.slice(0, 120)))
  return { ...p.summary(), crashes, loads }
}
