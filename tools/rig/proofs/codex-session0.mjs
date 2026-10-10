// Proof: Codex agents run without the OS sandbox while the engine is in
// Windows Session 0 (openai/codex#46412: the sandbox runner dies with
// 0xC0000142, "timed out connecting runner pipe-in"). The REAL installed
// Codex (`--real-cli`) on the Language Server lane against
// tools/rig/fakellm.mjs, whose script makes the agent run commands:
//   A. the engine's session as measured (a rig started by an agent under the
//      boot-task engine is in Session 0 itself; the proof records which):
//      1. a write-enabled seat: a shell write and an apply_patch both land,
//         Codex was told danger-full-access, and the engine logged one
//         "sandbox disabled" line for its launch;
//      2. a read-only seat (file editing off): danger-full-access with
//         approvalPolicy untrusted — a safe read command (Get-ChildItem) runs,
//         while a shell write and an apply_patch are declined and leave no
//         file; its prompt says the shell is not OS-sandboxed;
//   B. the interactive-session path (`ORGTREE_RIG_SESSION0=0`, after a
//      restart): a write-enabled seat gets workspace-write and on-request as
//      before, no "disabled" line; in a real Session 0 its sandboxed command
//      shows the old failure (recorded, whichever way it goes).
// Run: node tools/rig/rig.mjs run tools/rig/proofs/codex-session0.mjs

import fs from 'node:fs'
import path from 'node:path'

import { startFakeLlm } from '../fakellm.mjs'
import { writeRun } from '../lib.mjs'
import { seed } from '../fixture.mjs'
import { Proof } from '../proof.mjs'

const MODEL = 'fake-model:latest'
const patch = (file, line) => `apply_patch <<'EOF'\n*** Begin Patch\n*** Add File: ${file}\n+${line}\n*** End Patch\nEOF\n`
const exec = cmd => ({ tool: 'exec_command', input: { cmd } })
const done = summary => ({ tool: 'orgtree_status', input: { status: 'done', summary } })

export async function setup() {
  return { name: 'codex-s0', 'real-cli': true, fixture: 'none' }
}

export default async function (rig) {
  const p = new Proof('codex-session0')
  const llm = await startFakeLlm({
    log: path.join(p.dir, 'fakellm.jsonl'),
    bodies: path.join(p.dir, 'bodies'),
    models: [{ name: MODEL, context: 131072, running: 65536 }],
    rules: [
      // the write-enabled seat: shell write → apply_patch → done
      { match: ['PROOF-S0-W'], ...exec('Set-Content -Path s0w-shell.txt -Value PROOF-S0-W-SHELL-OK; Get-Content s0w-shell.txt') },
      { afterCall: ['PROOF-S0-W-SHELL'], ...exec(patch('s0w-patch.txt', 'PROOF-S0-W-PATCH-OK')) },
      { afterCall: ['PROOF-S0-W-PATCH'], ...done('PROOF-S0-W-DONE') },
      // the read-only seat: a safe read → a shell write → apply_patch → done
      { match: ['PROOF-S0-R'], ...exec('Get-ChildItem -Name -Force') },
      { afterCall: ['Get-ChildItem -Name -Force'], ...exec('Set-Content -Path s0r-write.txt -Value PROOF-S0-R-WRITE') },
      { afterCall: ['PROOF-S0-R-WRITE'], ...exec(patch('s0r-patch.txt', 'PROOF-S0-R-PATCH')) },
      { afterCall: ['PROOF-S0-R-PATCH'], ...done('PROOF-S0-R-DONE') },
      // the interactive path: one sandboxed shell write → done
      { match: ['PROOF-I-W'], ...exec('Set-Content -Path iw-shell.txt -Value PROOF-I-W-SHELL-OK; Get-Content iw-shell.txt') },
      { afterCall: ['PROOF-I-W-SHELL'], ...done('PROOF-I-W-DONE') },
    ],
  })
  const status = n => rig.one(`SELECT last_status->>'status' AS status, last_status->>'summary' AS summary FROM ot.agents WHERE name = '${n}'`)
  const scratch = n => path.join(rig.data, 'scratch', rig.org, n)
  const read = (n, f) => { try { return fs.readFileSync(path.join(scratch(n), f), 'utf8') } catch { return null } }
  const calls = token => llm.requests.filter(r => r.tool_result && String(r.tool_call ?? '').includes(token))
  const output = token => calls(token).map(r => r.tool_output).join('\n')
  /** the permissions text Codex sent the model on this agent's turn */
  const told = token => {
    const r = llm.requests.find(x => x.path === '/v1/responses' && (x.last_user ?? '').includes(token))
    if (!r?.body_file) return ''
    const s = JSON.stringify(JSON.parse(fs.readFileSync(path.join(p.dir, 'bodies', r.body_file), 'utf8')))
    const i = s.indexOf('<permissions instructions>')
    return i < 0 ? '' : s.slice(i, i + 4000)
  }
  const disabledLines = () => rig.engineLog().split(/\r?\n/).filter(l => l.includes('Codex OS sandbox disabled'))
  async function turn(name, token, timeout = 240000) {
    await rig.userMail(name, `${token}: run the proof steps.`)
    const st = await rig.waitFor(() => (status(name)?.summary === `${token}-DONE` ? status(name) : null),
      { what: `${name}'s done report`, timeout }).catch(() => null)
    await rig.waitFor(() => rig.sql(`SELECT 1 FROM ot.turns t JOIN ot.agents a ON a.id = t.agent_id WHERE a.name = '${name}' AND t.ended_at IS NULL`).length === 0,
      { what: `${name}'s turn to end`, timeout: 120000 }).catch(() => null)
    return st
  }
  try {
    const s = await rig.api('POST', '/api/langservers', { preset: 'ollama', address: llm.url, harness: 'codex-cli',
      label: 'Fake (Codex)', models: [{ id: MODEL, context: 65536 }] })
    const tier = Object.values(s.server?.models ?? {})[0]?.tier
    await seed(rig, { org: { name: 'Session Zero Org' }, agents: [
      { name: 's0writer', tier, grant: 1, charter: 'You prove Codex commands run.', tools: { edit: true, bash: true } },
      { name: 's0reader', tier, grant: 1, charter: 'You prove a read-only Codex seat stays read-only.', tools: { edit: false, bash: true } },
    ] })
    const measured = rig.engineLog().match(/session0[^\n]*/i)?.[0] ?? null

    // ------------------------------------------------------------ A1. write-enabled seat
    const w = await turn('s0writer', 'PROOF-S0-W')
    p.check('A1 write seat: the scripted steps ran to its done report', w?.status === 'idle', { status: status('s0writer'), last_error: rig.agentRow('s0writer')?.last_error })
    p.check('A1 write seat: Codex was told danger-full-access (no OS sandbox)', /`sandbox_mode` is `danger-full-access`/.test(told('PROOF-S0-W')), told('PROOF-S0-W').slice(0, 600))
    p.check('A1 write seat: its shell write ran and printed the file', output('PROOF-S0-W-SHELL').includes('PROOF-S0-W-SHELL-OK')
      && (read('s0writer', 's0w-shell.txt') ?? '').includes('PROOF-S0-W-SHELL-OK'), { output: output('PROOF-S0-W-SHELL').slice(0, 800), file: read('s0writer', 's0w-shell.txt') })
    p.check('A1 write seat: its apply_patch wrote the file', (read('s0writer', 's0w-patch.txt') ?? '').includes('PROOF-S0-W-PATCH-OK'),
      { output: output('PROOF-S0-W-PATCH').slice(0, 800), file: read('s0writer', 's0w-patch.txt') })
    p.check('A1 no runner failure in any write-seat output', !/pipe-in|0xc0000142|sandbox/i.test(output('PROOF-S0-W')), output('PROOF-S0-W').slice(0, 800))

    // ------------------------------------------------------------ A2. read-only seat
    const r = await turn('s0reader', 'PROOF-S0-R')
    p.check('A2 read seat: the scripted steps ran to its done report', r?.status === 'idle', { status: status('s0reader'), last_error: rig.agentRow('s0reader')?.last_error })
    const rTold = told('PROOF-S0-R')
    p.check('A2 read seat: Codex was told danger-full-access with approval policy untrusted',
      /`sandbox_mode` is `danger-full-access`/.test(rTold) && /untrusted/i.test(rTold), rTold.slice(0, 1500))
    p.check('A2 read seat: the safe read command (Get-ChildItem) ran and listed its folder', /AGENTS\.md|CLAUDE\.md|\.codex|\w+\.\w+/.test(output('Get-ChildItem -Name -Force'))
      && !/rejected|declined|denied/i.test(output('Get-ChildItem -Name -Force')), output('Get-ChildItem -Name -Force').slice(0, 800))
    p.check('A2 read seat: its shell write was declined and left no file', read('s0reader', 's0r-write.txt') === null
      && /rejected|declined|denied|not approved/i.test(output('PROOF-S0-R-WRITE')), output('PROOF-S0-R-WRITE').slice(0, 800))
    p.check('A2 read seat: its apply_patch was declined and left no file', read('s0reader', 's0r-patch.txt') === null
      && /rejected|declined|denied|not approved/i.test(output('PROOF-S0-R-PATCH')), output('PROOF-S0-R-PATCH').slice(0, 800))
    p.check('A2 read seat: its system prompt says the shell is not OS-sandboxed', /NOT OS-sandboxed/.test(JSON.stringify(
      JSON.parse(fs.readFileSync(path.join(p.dir, 'bodies', llm.requests.find(x => (x.last_user ?? '').includes('PROOF-S0-R')).body_file), 'utf8')))), null)
    const lines = disabledLines()
    p.check('A one "sandbox disabled (Session 0, codex#46412)" log line per launch: on-request for the writer, untrusted for the reader',
      lines.length === 2 && lines.some(l => /on-request/.test(l)) && lines.some(l => /untrusted/.test(l)), { lines, measured })

    // ------------------------------------------------------------ B. interactive-session path
    rig.run = writeRun(rig.dir, { session0: '0' })
    await rig.restart()
    await rig.op({ op: 'hire', name: 'iwriter', tier, grant: 1, charter: 'You prove the sandbox stays on outside Session 0.', tools: { edit: true, bash: true } })
    const b = await turn('iwriter', 'PROOF-I-W', 300000)
    const iTold = told('PROOF-I-W')
    p.check('B interactive path: Codex was told workspace-write, approvals on-request, as before', /`sandbox_mode` is `workspace-write`/.test(iTold)
      && !/untrusted/i.test(iTold), iTold.slice(0, 1200))
    p.check('B interactive path: no "sandbox disabled" line for this launch', disabledLines().length === lines.length, disabledLines())
    const iOut = output('PROOF-I-W-SHELL')
    p.note('B the sandboxed command in this (real) Session 0', { done: b?.status ?? null, file: read('iwriter', 'iw-shell.txt'), output: iOut.slice(0, 1500),
      old_failure: /pipe-in|0xc0000142/i.test(iOut) })
  } finally {
    p.keep(rig, { grep: /Codex OS sandbox|CLI started|codex stderr|runner/i })
    await llm.close()
  }
  return p.summary()
}
