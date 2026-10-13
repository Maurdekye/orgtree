// Proof: the Muse host's OS sandbox posture follows the engine's Windows
// session (user 2026-10-13 18:53Z: "Yes, do the fix"; kept at 20:16Z knowing
// what it costs, measured that day: without the sandbox Muse asks Orgtree
// about no command and its file tools write outside the folders), on the fake
// `muse serve`, the session forced by the rig (`ORGTREE_RIG_SESSION0`):
//   1. Session 0 (the boot task, where Muse's `windows_elevated` sandbox
//      cannot start a command): a write seat's host starts with
//      `--disable-sandbox` and keeps its shell; a read-only seat's host has no
//      shell (`--disable-shell`, as on every session) and no sandbox flag; a
//      bypassPermissions seat's host is unchanged (`:unrestricted`, no flag).
//      The engine logs each host's posture, and the Harnesses page's data
//      says Session 0 (`muse.session0`). As measured on real Muse, the write
//      seat's shell command and its write outside its folders both run with
//      no approval request (the fake models that for `--disable-sandbox`).
//   2. After a restart outside Session 0: the write seat's next host keeps
//      the sandbox (no flag), as before this change; the same outside write
//      is asked about and Orgtree refuses it (Muse's once-only `abort`); the
//      providers payload says not Session 0.
// Run: node tools/rig/rig.mjs run tools/rig/proofs/muse-session0.mjs

import { writeRun } from '../lib.mjs'
import { Proof } from '../proof.mjs'

export async function setup() {
  return { session0: '1' }
}

const OUTSIDE = 'C:\\outside-s0\\x.txt'
const SEATS = { wes: { tools: { edit: true, bash: true } }, rob: { tools: { edit: false } },
  byp: { tools: { edit: true, bash: true }, permission_mode: 'bypassPermissions', top: true } }

export default async function (rig) {
  const p = new Proof('muse-session0')
  rig.scenario({
    agents: {
      wes: { turns: [
        { name: 'shell and a write outside', match: 'PROOF-S0', once: true, steps: [
          { tool: 'powershell', args: { command: 'Write-Output S0' }, result: 'S0' },
          { tool: 'write_file', args: { path: OUTSIDE, content: 'x' }, native_write: true, result: 'written' },
          { text: 'Done.' }] },
        { name: 'after restart', match: 'PROOF-S1', steps: [
          { tool: 'write_file', args: { path: OUTSIDE, content: 'x' }, native_write: true, result: 'written' },
          { text: 'Back.' }] },
      ] },
    },
    default: { turns: [{ name: 'default', steps: [{ text: 'OK.' }] }] },
  })
  await rig.waitFor(() => rig.sql('SELECT 1 FROM ot.turns WHERE ended_at IS NULL').length === 0, { what: 'seed turns to settle', timeout: 60000 })
  await rig.waitFor(async () => (await rig.api('GET', '/api/providers'))?.providers?.find((x) => x.id === 'muse' && x.muse?.catalog),
    { what: 'Muse discovery', timeout: 60000 })
  // the bypass seat is top level: under boss its mode would be capped by his
  for (const [name, { top, ...extra }] of Object.entries(SEATS)) {
    await rig.op({ op: 'hire', name, ...(top ? {} : { parent: 'boss' }), tier: 'wonder', title: 'Muse Session 0 seat', ...extra })
  }
  const ids = Object.fromEntries(Object.keys(SEATS).map((a) => [a, rig.agentRow(a)?.id]))
  p.check('a write, a read-only and a bypassPermissions Muse seat hired', Object.values(ids).every(Boolean), ids)
  const log = (agent, kind) => rig.fakeLog(agent).filter((l) => !kind || l.kind === kind)
  const lastStart = (agent) => log(agent, 'start').at(-1)
  const args = (agent) => lastStart(agent)?.args ?? []
  const profile = (agent) => log(agent, 'session').at(-1)?.profile
  const settled = (agent, tool) => log(agent, 'send').map((l) => l.line)
    .filter((f) => f?.method === 'item/completed' && f.params?.item?.kind === 'toolCall' && f.params.item.tool === tool).map((f) => f.params.item)
  const session0 = async () => (await rig.api('GET', '/api/providers'))?.providers?.find((x) => x.id === 'muse')?.muse?.session0

  // ---------------------------------------------------------------- 1. Session 0
  await rig.userMail('wes', 'PROOF-S0: run it.')
  for (const name of ['rob', 'byp']) await rig.userMail(name, 'PROOF-HELLO: say hi.')
  for (const name of Object.keys(SEATS)) await rig.waitTurns(name, 1, { timeout: 60000 })
  p.check('Session 0: the write seat\'s host runs without the OS sandbox and keeps its shell',
    args('wes').includes('--disable-sandbox') && !args('wes').includes('--disable-shell') && profile('wes') === ':ask-me', { args: args('wes'), profile: profile('wes') })
  p.check('Session 0: the read-only seat\'s host has no shell (as on every session) and no sandbox flag',
    args('rob').includes('--disable-shell') && !args('rob').includes('--disable-sandbox') && profile('rob') === ':read-only', { args: args('rob'), profile: profile('rob') })
  p.check('Session 0: the bypassPermissions seat\'s host is unchanged (:unrestricted, no sandbox flag)',
    !args('byp').includes('--disable-sandbox') && profile('byp') === ':unrestricted', { args: args('byp'), profile: profile('byp') })
  const posture = rig.engineLog().split(/\r?\n/).filter((l) => /provider="?Muse"?/.test(l) && /CLI started/.test(l))
  p.check('the engine logs each host\'s posture (profile, shell, write, sandbox)',
    posture.length >= 3 && posture.some((l) => /sandbox=false/.test(l)) && posture.some((l) => /sandbox=true/.test(l)), posture.slice(-3))
  const writes0 = log('wes', 'native_write')
  p.check('Session 0, as measured on real Muse: the write seat\'s command and its write outside its folders ran with no approval request',
    !log('wes', 'approval').length && settled('wes', 'powershell')[0]?.status === 'completed'
      && writes0.length === 1 && writes0[0].in_root === false && writes0[0].sandbox === false && settled('wes', 'write_file')[0]?.status === 'completed',
    { approvals: log('wes', 'approval'), writes: writes0 })
  const s0 = await session0()
  p.check('the Harnesses page\'s data says the engine runs in Session 0 (muse.session0)', s0 === true, s0)

  // ---------------------------------------------------------------- 2. outside Session 0, after a restart
  const starts = log('wes', 'start').length
  rig.run = writeRun(rig.dir, { session0: '0' })
  await rig.restart()
  await rig.userMail('wes', 'PROOF-S1: again.')
  await rig.waitTurns('wes', 2, { timeout: 60000 })
  p.check('outside Session 0 the write seat\'s next host keeps the sandbox (no flag), as before',
    log('wes', 'start').length > starts && !args('wes').includes('--disable-sandbox') && !args('wes').includes('--disable-shell'), { args: args('wes') })
  const asked = log('wes', 'approval')
  p.check('outside Session 0 the same write outside the folders is asked about and refused (the once-only abort)',
    asked.length === 1 && asked[0].choice === 'abort' && settled('wes', 'write_file').at(-1)?.status === 'rejected', asked)
  const s1 = await session0()
  p.check('outside Session 0 the providers payload says so (muse.session0 false)', s1 === false, s1)
  p.keep(rig, { agents: Object.keys(SEATS), grep: /CLI started|session0|sandbox/i })
  return p.summary()
}
