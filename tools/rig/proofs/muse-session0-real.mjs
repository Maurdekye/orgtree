// Proof on the REAL Muse Code in Windows Session 0 (user 2026-10-13 18:53Z:
// the shell works when the engine runs in the background session; a small
// synthetic subscription turn, scratch only). A rig started by an agent under
// the boot-task engine runs in Session 0 itself; the proof records the
// engine's own measurement. One write seat (Spark, the lowest effort its
// catalog names) runs one turn:
//   - its host starts without the OS sandbox (`--disable-sandbox` on its
//     command line, the engine's posture line `sandbox=false`);
//   - its powershell call runs and returns (in Session 0 the sandboxed call
//     fails: measured "failed to send runner spawn_request ... os error 109");
//   - a file write outside its folders goes through with no approval
//     request: without the sandbox Muse asks Orgtree about nothing (measured
//     2026-10-13; the user kept this posture knowing it, 20:16Z, and the
//     Harnesses page says so); the proof writes only inside its own run;
//   - the turn ends well.
// Run: node tools/rig/rig.mjs run tools/rig/proofs/muse-session0-real.mjs --real-muse <muse-bin-*.exe>

import fs from 'node:fs'
import path from 'node:path'
import { Proof } from '../proof.mjs'
import { processes } from '../lib.mjs'

export default async function (rig) {
  const p = new Proof('muse-session0-real')
  if (!rig.run.realMuse) throw new Error('run this proof with --real-muse <muse-bin-*.exe>')
  const binDir = path.dirname(rig.run.realMuse)
  const outside = path.join(rig.dir, 'outside-s0', `unasked-${Date.now()}.txt`)
  fs.mkdirSync(path.dirname(outside), { recursive: true })
  await rig.waitFor(() => rig.sql('SELECT 1 FROM ot.turns WHERE ended_at IS NULL').length === 0, { what: 'seed turns to settle', timeout: 60000 })
  const muse = await rig.waitFor(async () => (await rig.api('GET', '/api/providers'))?.providers?.find((x) => x.id === 'muse' && x.muse?.catalog),
    { what: 'Muse discovery', timeout: 120000 })
  const spark = (muse.tiers ?? []).find((t) => t.tier === 'spark')
  p.check('discovery: the real Muse Code, signed in, offering Spark', !!spark && muse.status?.connected === true, { tiers: (muse.tiers ?? []).map((t) => t.tier) })
  const effort = spark?.efforts?.[0] ?? ''
  await rig.op({ op: 'hire', parent: 'boss', name: 's0w', tier: 'spark', title: 'Session 0 shell test', effort, account_fallback: false,
    tools: { edit: true, bash: true } })
  const id = rig.agentRow('s0w')?.id
  p.check('a write seat (shell and file editing) hired on Spark at its lowest effort', !!id, { effort })
  await rig.userMail('s0w', [
    'PROOF-S0-REAL: an automated test of your tools. Do exactly these two steps, nothing else:',
    '1. Call your powershell tool once with this command: Write-Output S0-SHELL-OK',
    `2. Call your write_file tool once to create the file ${outside} containing the text x. It is outside your folders, so it may be refused; do not retry it any other way.`,
    'Then reply with one line saying what step 1 printed and whether step 2 was refused.'].join('\n'))
  const turns = await rig.waitTurns('s0w', 1, { timeout: 300000 })
  const turn = rig.one(`SELECT error, killed, model, denials FROM ot.turns WHERE id = ${turns.at(-1).id}`)
  const rows = rig.sql(`SELECT body FROM ot.convo WHERE agent_id = ${id} ORDER BY seq`).map((r) => r.body)
  const chips = rows.flatMap((b) => b?.tools ?? [])
  const shell = chips.find((c) => c.name === 'powershell')
  const write = chips.find((c) => c.name === 'write_file')
  const engineSession = rig.engineLog().split(/\r?\n/).filter((l) => /provider="?Muse"?/.test(l) && /CLI started/.test(l))
  const live = processes(`$_.Name -like 'muse-bin*' -and $_.ExecutablePath -like '${binDir.replace(/'/g, "''")}*'`)
    .map((x) => ({ pid: x.ProcessId, flags: [...(x.CommandLine ?? '').matchAll(/\s(--[a-z][a-z-]*)/g)].map((m) => m[1]) }))
  const engineS0 = rig.engineLog().match(/[^\n]*session0[^\n]*/i)?.[0] ?? null
  p.file('observed.json', { turn, shell, write, engineSession, live, engineS0, reply: rows.filter((b) => b?.role === 'assistant').map((b) => b.text) })
  p.check('the host started without the OS sandbox (posture line sandbox=false; --disable-sandbox on its command line)',
    engineSession.some((l) => /sandbox=false/.test(l)) && live.some((h) => h.flags.includes('--disable-sandbox')), { engineSession, live })
  p.check('the powershell call ran and returned its output in Session 0',
    !!shell && !shell.error && /S0-SHELL-OK/.test(String(shell.result ?? '')), shell && { result: String(shell.result ?? '').slice(0, 300), error: shell.error })
  p.check('as documented: the write outside the seat\'s folders went through with no approval request (the file exists, no denial)',
    fs.existsSync(outside) && !!write && !write.error && turn?.denials === 0,
    write ? { error: write.error, result: String(write.result ?? '').slice(0, 200), denials: turn?.denials } : 'the model made no write_file call')
  p.check('the turn ended well', turn && !turn.error && !turn.killed, turn)
  p.keep(rig, { agents: [], grep: /CLI started|session0|sandbox|denied|approval/i })
  return p.summary()
}
