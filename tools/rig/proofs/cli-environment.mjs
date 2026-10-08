// Proof: the Claude CLI's environment as 3.x agents had it. They have the
//   PowerShell tool, as 3.x agents had it
//   (supervisor.py's allowed tools: "Bash, PowerShell"; the identity promises
//   both). The engine runs the CLI in essential-traffic mode
//   (CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, decision 53), which turns off
//   the CLI's server-side flags, and the CLI then offers PowerShell beside Git
//   Bash only when asked (CLAUDE_CODE_USE_POWERSHELL_TOOL) or when the cached
//   flag `tengu_cobalt_ridge` may be read (CLAUDE_CODE_GB_DISK_CACHE_WHEN_TELEMETRY_OFF).
//   The fake CLI models that gate (2.1.292's): the rig home's cached flags say
//   tengu_cobalt_ridge is on, as the user's account cache does.
//   boss (terminal on): his CLI starts in essential-traffic mode, asked for
//   PowerShell, reading cached flags, and its init lists Bash and PowerShell.
//   quiet (terminal off): neither shell, and PowerShell is not asked for.
//   Both carry ORGTREE_NODE (3.x's name for the agent), by which the mail
//   hub's SessionStart hook tells an orgtree agent and stands down.
// Run: node tools/rig/rig.mjs run tools/rig/proofs/cli-environment.mjs

import fs from 'node:fs'
import path from 'node:path'

import { Proof } from '../proof.mjs'

export default async function (rig) {
  const p = new Proof('cli-environment')
  // the account's cached flags, as the CLI keeps them in its global config
  const cfg = path.join(rig.data, 'rig-home', '.claude.json')
  const global = JSON.parse(fs.readFileSync(cfg, 'utf8'))
  global.cachedGrowthBookFeatures = { ...(global.cachedGrowthBookFeatures ?? {}), tengu_cobalt_ridge: true }
  fs.writeFileSync(cfg, JSON.stringify(global))
  await rig.waitFor(() => rig.sql('SELECT 1 FROM ot.turns WHERE ended_at IS NULL').length === 0, { what: 'seed turns to settle', timeout: 60000 })
  await rig.op({ op: 'hire', name: 'quiet', parent: 'boss', tier: 'haiku', title: 'No terminal', tools: { bash: false } })
  const starts = name => rig.fakeLog(name).filter(l => l.kind === 'start')
  const inits = name => rig.fakeLog(name).filter(l => l.kind === 'send' && l.line?.type === 'system' && l.line?.subtype === 'init')
  for (const name of ['boss', 'quiet']) {
    const turns = rig.turns(name).length
    await rig.userMail(name, `Hello ${name}.`)
    await rig.waitTurns(name, turns + 1)
  }

  const b = starts('boss').at(-1)
  p.check('boss: his CLI runs in essential-traffic mode (kept: no update check on the shared CLI)',
    b?.env?.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC === '1', b?.env)
  p.check('boss: his CLI is asked for PowerShell (terminal on)', b?.env?.CLAUDE_CODE_USE_POWERSHELL_TOOL === '1', b?.env)
  p.check('boss: his CLI reads the cached feature flags', b?.env?.CLAUDE_CODE_GB_DISK_CACHE_WHEN_TELEMETRY_OFF === '1', b?.env)
  const bt = inits('boss').at(-1)?.line?.tools ?? []
  p.check('boss: his turn\'s init lists Bash and PowerShell', bt.includes('Bash') && bt.includes('PowerShell'), bt.filter(t => !t.startsWith('mcp__')))

  const q = starts('quiet').at(-1)
  p.check('quiet (terminal off): her CLI is not asked for PowerShell', q && q.env?.CLAUDE_CODE_USE_POWERSHELL_TOOL == null, q?.env)
  const qt = inits('quiet').at(-1)?.line?.tools ?? []
  p.check('quiet: her turn\'s init lists neither Bash nor PowerShell', qt.length > 0 && !qt.includes('Bash') && !qt.includes('PowerShell'),
    qt.filter(t => !t.startsWith('mcp__')))

  p.check('both carry ORGTREE_NODE, their names (3.x)', b?.env?.ORGTREE_NODE === 'boss' && q?.env?.ORGTREE_NODE === 'quiet',
    { boss: b?.env?.ORGTREE_NODE, quiet: q?.env?.ORGTREE_NODE })

  p.keep(rig, { agents: ['boss', 'quiet'] })
  return p.summary()
}
