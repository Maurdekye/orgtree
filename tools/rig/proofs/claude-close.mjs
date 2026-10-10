// Proof: closing an idle Claude CLI closes its stdin, so it exits by itself
// instead of being terminated after 5 s (the stdout reader kept the writer
// channel open; docket urgent-orgtree-s-hard-killing-of-codex-processes).
// A retool replaces the idle agent's process through the close path.
//   node tools/rig/rig.mjs run tools/rig/proofs/claude-close.mjs

import { Proof } from '../proof.mjs'

export default async function (rig) {
  const p = new Proof('claude-close')
  rig.scenario({ default: { turns: [{ name: 'default', steps: [{ text: 'OK.' }] }] } })
  await rig.waitFor(() => rig.sql(`SELECT 1 FROM ot.turns WHERE ended_at IS NULL`).length === 0, { what: 'seed turns to settle', timeout: 60000 })
  await rig.op({ op: 'hire', name: 'cleo', parent: 'boss', tier: 'haiku', title: 'Close subject' })
  await rig.userMail('cleo', 'Say OK.')
  await rig.waitTurns('cleo', 1)
  const lines = re => rig.engineLog().split(/\r?\n/).filter(l => re.test(l) && l.includes('/cleo '))
  const started = lines(/CLI started/).at(-1)
  const pid = Number((started?.match(/ pid=(\d+)/) ?? [])[1] ?? 0)
  p.check('cleo has a running Claude CLI', pid > 0, started)
  const t0 = Date.now()
  await rig.op({ op: 'retool', node: 'cleo', tools: { bash: false } })
  const seen = await rig.waitFor(() => lines(/reason=close (requested|required termination)/).find(l => l.includes(`pid=${pid} `)) || null,
    { what: 'its close observation', timeout: 20000 }).catch(() => null)
  p.check('closing it ended it by itself, within the 5 s grace (no "close required termination")',
    !!seen && /reason=close requested/.test(seen) && !/exit status unavailable/.test(seen)
      && !lines(/close required termination/).some(l => l.includes(`pid=${pid} `)),
    { ms: Date.now() - t0, line: seen })
  p.keep(rig, { grep: /CLI started|CLI exit observation/ })
  return p.summary()
}
