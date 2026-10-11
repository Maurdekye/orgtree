// Proof: the "run on startup" switch in the real renderer (docket
// start-at-login-off-means-nothing-of-orgtree-star; user 2026-10-10 17:46Z:
// "Start at login" is "Run on startup" everywhere the user sees it). App
// settings › Runtime › Desktop with a planted bridge (desktop/run-on-startup.cjs):
// the switch reads "run on startup", with a hint that says what off means; a
// change main reports as declined (a Windows permission prompt the user said
// No to) shows main's message and leaves the switch on; an accepted change
// turns it off. What main does with the change is tests/disruptive/run-on-startup.test.mjs
// (the tasks) and tests/unix-boot-engine.test.mjs (macOS/Linux).
// Run: node tools/rig/build-ui.mjs, then
//      node tools/rig/rig.mjs run tools/rig/proofs/run-on-startup.mjs --ui <bundle>

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Proof } from '../proof.mjs'
import { runDesktop } from '../desktop.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))

export default async function (rig) {
  const p = new Proof('run-on-startup')
  const r = await runDesktop(rig, path.join(here, '../desktop/run-on-startup.cjs'), { args: { org: rig.org }, out: path.join(p.dir, 'desk'), timeout: 120000 })
  const v = r.value ?? {}
  p.check('the desk script ran', r.ok !== false, { error: r.error, out: r.out })
  p.check('the switch reads "run on startup", and nothing still says "start at login"',
    v.before?.label === 'run on startup' && v.before?.oldLabel === false, v.before?.label)
  p.check('its hint says what off means', /Off: nothing of Orgtree runs until you open it/.test(v.before?.hint ?? '')
    && /Windows asks for permission/.test(v.before?.hint ?? ''), v.before?.hint)
  p.check('a declined permission prompt shows main\'s message and leaves the switch on',
    v.declined?.checked === true && /Windows did not give permission, so Orgtree still runs on startup\./.test(v.declined?.alert ?? ''), v.declined)
  p.check('an accepted change turns the switch off and clears the message', v.off?.checked === false && !v.off?.alert, v.off)
  p.check('each click asked main for exactly that change', JSON.stringify(v.writes) === JSON.stringify([{ startAtLogin: false }, { startAtLogin: false }]), v.writes)
  return p.summary()
}
