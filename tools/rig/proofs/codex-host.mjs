// Proof: the sign-in helper starts sandboxed Codex seats in the user's
// session (docket windows-sign-in-credential-helper-so-git-gh-work, phase 2),
// where Codex's Windows sandbox works (openai/codex#46412 breaks it in
// Session 0). The REAL installed Codex (`--real-cli`) on the Language Server
// lane against tools/rig/fakellm.mjs; the engine reports the boot task's
// Session 0 (`--session0 1`; a rig started by an agent under the boot-task
// engine is really in Session 0, and the proof records the sessions it sees).
// The helper (orgtree-credential-broker.exe) starts through the same
// temporary interactive task as credential-broker.mjs, deleted afterwards.
//   1. a write-enabled seat is hosted: its Codex runs in a non-zero session,
//      is told workspace-write, and its sandboxed shell write and apply_patch
//      land; no "sandbox disabled" line for it;
//   2. a read-only seat is hosted: told read-only (approvals on-request);
//      its write leaves no file;
//   3. a bypassPermissions seat stays in Session 0, started by the engine
//      itself (ruling Q1);
//   4. halting a hosted seat ends its Codex;
//   0. a seat that ran before the helper came up (Session 0 mode) is
//      relaunched hosted at its next turn: its prompt changed with the
//      placement, chosen once per launch (review fix 2);
//   5. the helper dies (as at sign-out): the hosted Codex ends with it, and
//      the seat's next turn starts cleanly in Session 0 without the OS
//      sandbox (ruling Q3).
// Run with a rig home under your profile (the descriptor's trust check):
//   set ORGTREE_RIG_HOME=%LOCALAPPDATA%\orgtree-rig-broker
//   node tools/rig/rig.mjs run tools/rig/proofs/codex-host.mjs

import fs from 'node:fs'
import path from 'node:path'
import {fileURLToPath} from 'node:url'

import { startFakeLlm } from '../fakellm.mjs'
import { seed } from '../fixture.mjs'
import { Proof } from '../proof.mjs'
import { brokerExe, brokerPid, ps, sessionLauncher } from './credential-broker.mjs'

const MODEL = 'fake-model:latest'
const patch = (file, line) => `apply_patch <<'EOF'\n*** Begin Patch\n*** Add File: ${file}\n+${line}\n*** End Patch\nEOF\n`
const exec = cmd => ({ tool: 'exec_command', input: { cmd } })
const done = summary => ({ tool: 'orgtree_status', input: { status: 'done', summary } })
const write = (file, token) => exec(`Set-Content -Path ${file} -Value ${token}-OK; Get-Content ${file}`)

export async function setup() {
  return { name: 'codex-host', 'real-cli': true, 'boot-isolated': true, session0: '1', fixture: 'none' }
}

const sessionOf = pid => { const o = ps(`(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).SessionId`); return o === '' ? null : Number(o) }
const parentOf = pid => Number(ps(`(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').ParentProcessId`) || 0)
const alive = pid => sessionOf(pid) !== null
const kill = pid => { if (pid) try { process.kill(pid) } catch {} }

export default async function (rig) {
  const stateHome = process.env.ORGTREE_RIG_HOME
  if (process.env.ORGTREE_RIG_EVIDENCE_HOME) process.env.ORGTREE_RIG_HOME = process.env.ORGTREE_RIG_EVIDENCE_HOME
  const p = new Proof('codex-host')
  if (stateHome === undefined) delete process.env.ORGTREE_RIG_HOME
  else process.env.ORGTREE_RIG_HOME = stateHome
  const exe = brokerExe()
  if (!fs.existsSync(exe)) throw Error(`no broker at ${exe}: cargo build -p orgtree-engine --bins`)
  const llm = await startFakeLlm({
    log: path.join(p.dir, 'fakellm.jsonl'),
    bodies: path.join(p.dir, 'bodies'),
    models: [{ name: MODEL, context: 131072, running: 65536 }],
    rules: [
      { match: ['PROOF-H-W'], ...write('hw-shell.txt', 'PROOF-H-W-SHELL') },
      { afterCall: ['PROOF-H-W-SHELL'], ...exec(patch('hw-patch.txt', 'PROOF-H-W-PATCH-OK')) },
      { afterCall: ['PROOF-H-W-PATCH'], ...exec(`$env:GIT_CONFIG_GLOBAL='NUL'; $env:GIT_CONFIG_SYSTEM='NUL'; $g = "protocol=https\nhost=rig-proof.example\n\n" | git credential fill; $t = gh auth token --hostname rig-proof.example; if (($g -join "\n") -match 'password=rig-proof-desktop' -and $t -eq 'rig-proof-desktop') { 'PROOF-H-W-CREDENTIALS-OK' } else { 'PROOF-H-W-CREDENTIALS-FAILED' }`) },
      { afterCall: ['PROOF-H-W-CREDENTIALS'], ...done('PROOF-H-W-DONE') },
      { match: ['PROOF-H-R'], ...exec('Get-ChildItem -Name') },
      { afterCall: ['Get-ChildItem -Name'], ...write('hr-write.txt', 'PROOF-H-R-WRITE') },
      { afterCall: ['PROOF-H-R-WRITE'], ...done('PROOF-H-R-DONE') },
      { match: ['PROOF-B-W'], ...write('bw-shell.txt', 'PROOF-B-W-SHELL') },
      { afterCall: ['PROOF-B-W-SHELL'], ...done('PROOF-B-W-DONE') },
      { match: ['PROOF-F-W'], ...write('fw-shell.txt', 'PROOF-F-W-SHELL') },
      { afterCall: ['PROOF-F-W-SHELL'], ...done('PROOF-F-W-DONE') },
      { match: ['PROOF-L-0'], ...write('l0-shell.txt', 'PROOF-L-0-SHELL') },
      { afterCall: ['PROOF-L-0-SHELL'], ...done('PROOF-L-0-DONE') },
      { match: ['PROOF-L-1'], ...write('l1-shell.txt', 'PROOF-L-1-SHELL') },
      { afterCall: ['PROOF-L-1-SHELL'], ...done('PROOF-L-1-DONE') },
    ],
  })
  const status = n => rig.one(`SELECT last_status->>'status' AS status, last_status->>'summary' AS summary FROM ot.agents WHERE name = '${n}'`)
  const scratch = n => path.join(rig.data, 'scratch', rig.org, n)
  const read = (n, f) => { try { return fs.readFileSync(path.join(scratch(n), f), 'utf8') } catch { return null } }
  const calls = token => llm.requests.filter(r => r.tool_result && String(r.tool_call ?? '').includes(token))
  const output = token => calls(token).map(r => r.tool_output).join('\n')
  const told = token => {
    const r = llm.requests.filter(x => x.path === '/v1/responses' && (x.last_user ?? '').includes(token)).at(-1)
    if (!r?.body_file) return ''
    const s = JSON.stringify(JSON.parse(fs.readFileSync(path.join(p.dir, 'bodies', r.body_file), 'utf8')))
    // a resumed thread carries every earlier permissions block: the latest counts
    const i = s.lastIndexOf('<permissions instructions>')
    return i < 0 ? '' : s.slice(i, i + 4000)
  }
  const lines = re => rig.engineLog().split(/\r?\n/).filter(l => re.test(l))
  const of = (name, re) => lines(re).filter(l => l.includes(`/${name} `))
  const pidIn = l => Number((l?.match(/ pid=(\d+)/) ?? [])[1] ?? 0)
  const lastPid = name => pidIn(of(name, /CLI started/).at(-1))
  const HOSTED = /Codex started by the sign-in helper/
  const DISABLED = /Codex OS sandbox disabled/
  async function turn(name, token, timeout = 240000) {
    await rig.userMail(name, `${token}: run the proof steps.`)
    const st = await rig.waitFor(() => (status(name)?.summary === `${token}-DONE` ? status(name) : null),
      { what: `${name}'s done report`, timeout }).catch(() => null)
    await rig.waitFor(() => rig.sql(`SELECT 1 FROM ot.turns t JOIN ot.agents a ON a.id = t.agent_id WHERE a.name = '${name}' AND t.ended_at IS NULL`).length === 0,
      { what: `${name}'s turn to end`, timeout: 120000 }).catch(() => null)
    return st
  }

  const run = rig.refresh()
  const port = Number(new URL(rig.url).port)
  const taskName = `OrgtreeRigProof-${path.basename(rig.dir)}`
  const session = sessionLauncher(rig.dir, taskName)
  const bin = path.join(rig.dir, 'bin', 'orgtree-credential-broker.exe')
  let broker = 0, desk = null, renewal = null
  const deskCalls = path.join(rig.dir, 'desk-lookups.jsonl')
  const registerDesk = async (extra = {}) => (await fetch(rig.url + '/api/desktop/credential-bridge', {
    method: 'POST', headers: {'X-Orgtree-Desktop-Token':rig.token, 'Content-Type':'application/json'},
    body:JSON.stringify({...desk, ...extra}) })).status
  let renewalFailures = 0
  try {
    p.note('sessions: this proof script, the rig engine', { proof: sessionOf(process.pid), engine: sessionOf((await rig.api('GET', '/api/desktop/identity')).pid) })
    const home = path.join(rig.data, 'profiles', 'langserver-codex')
    fs.mkdirSync(home, { recursive: true })
    fs.writeFileSync(path.join(home, 'config.toml'), '[windows]\nsandbox = "unelevated"\n')
    const s = await rig.api('POST', '/api/langservers', { preset: 'ollama', address: llm.url, harness: 'codex-cli',
      label: 'Fake (Codex)', models: [{ id: MODEL, context: 65536 }] })
    const tier = Object.values(s.server?.models ?? {})[0]?.tier
    await seed(rig, { org: { name: 'Codex Host Org' }, agents: [
      { name: 'lwriter', tier, grant: 1, charter: 'You prove a seat moves into the helper when it comes up.', tools: { edit: true, bash: true } },
      { name: 'hwriter', tier, grant: 1, charter: 'You prove hosted Codex commands run sandboxed.', tools: { edit: true, bash: true } },
      { name: 'hreader', tier, grant: 1, charter: 'You prove a hosted read-only seat stays read-only.', tools: { edit: false, bash: true } },
      { name: 'bwriter', tier, grant: 1, charter: 'You prove a bypass seat stays in Session 0.', tools: { edit: true, bash: true }, permission_mode: 'bypassPermissions' },
    ] })

    // ---- 0a. before the helper: Session 0 mode, started by the engine
    const engineId = (await rig.api('GET', '/api/desktop/identity')).pid
    const l0 = await turn('lwriter', 'PROOF-L-0')
    const l0Pid = lastPid('lwriter')
    p.check('0 before the helper: the seat ran, started by the engine, without the OS sandbox', l0?.status === 'idle' && parentOf(l0Pid) === engineId
      && of('lwriter', DISABLED).length === 1 && /`sandbox_mode` is `danger-full-access`/.test(told('PROOF-L-0')),
      { pid: l0Pid, parent: parentOf(l0Pid), engine: engineId, disabled: of('lwriter', DISABLED).length })

    // the helper attaches as in credential-broker.mjs
    const identity = await rig.api('GET', '/api/desktop/identity')
    fs.writeFileSync(path.join(rig.data, 'engine-attach.json'), JSON.stringify({ type: 'attach', protocol: 1, port, enginePid: identity.pid,
      hostPid: run.keeperPid, dataRootId: identity.dataRootId, token: rig.token, startedAt: new Date().toISOString() }))
    // Desktop keeps credentials throughout: only the standby helper hosts.
    const deskFile = path.join(rig.dir, 'desk.json')
    const stub = fileURLToPath(new URL('../credential-desktop-stub.mjs', import.meta.url))
    await session.start({}, `"${process.execPath}" "${stub}" "${deskFile}" "${deskCalls}"`)
    await rig.waitFor(() => fs.existsSync(deskFile), {timeout:15000,what:'desktop-like pipe'})
    desk = JSON.parse(fs.readFileSync(deskFile,'utf8'))
    p.check('desktop acquires credential slot first', await registerDesk() === 200)
    p.check('host role requires explicit spawn capability', await registerDesk({role:'host'}) === 503)
    p.check('unknown registration role fails closed', await registerDesk({role:'unknown',caps:['spawn']}) === 503)
    renewal = setInterval(() => { registerDesk().then(s=>{if(s!==200)renewalFailures++}).catch(()=>renewalFailures++) },5000)
    fs.copyFileSync(exe, bin)
    await session.start({ ORGTREE_V2_DATA: rig.data }, `"${bin}"`)
    await rig.waitFor(() => brokerPid(bin) > 0, { timeout: 15000, what: 'helper process' })
    broker = brokerPid(bin)
    const helperLog = () => {try {return fs.readFileSync(path.join(rig.data,'credential-broker.log'),'utf8')}catch{return ''}}
    await rig.waitFor(() => /holding the Codex host slot/.test(helperLog()) && /standing by: another broker holds the bridge/.test(helperLog()),
      { timeout: 30000, what: 'standby helper host registration' })
    p.check('helper runs in an interactive session and hosts while desktop keeps credentials', sessionOf(broker) > 0 && await registerDesk() === 200,
      {pid:broker, session:sessionOf(broker), desktop:desk.pid})
    p.check('a competing live host cannot replace the helper', await registerDesk({role:'host',caps:['spawn']}) === 409)
    p.check('a non-holder host release is harmless', await registerDesk({role:'host',caps:['spawn'],release:true}) === 200)
    p.check('the host lease still belongs to helper after wrong release', await registerDesk({role:'host',caps:['spawn']}) === 409)

    // ---- 0b. the helper came up: that seat's next turn relaunches it hosted
    p.check('0 its Codex is still running when the helper comes up', alive(l0Pid), { pid: l0Pid })
    const l1 = await turn('lwriter', 'PROOF-L-1')
    const l1Pid = lastPid('lwriter')
    p.check('0 after the helper came up: the next turn ran in a new Codex, a child of the helper, with the sandbox on', l1?.status === 'idle'
      && l1Pid !== l0Pid && parentOf(l1Pid) === broker && of('lwriter', HOSTED).length === 1 && !alive(l0Pid)
      && /`sandbox_mode` is `workspace-write`/.test(told('PROOF-L-1')) && (read('lwriter', 'l1-shell.txt') ?? '').includes('PROOF-L-1-SHELL-OK'),
      { old: l0Pid, oldAlive: alive(l0Pid), pid: l1Pid, parent: parentOf(l1Pid), helper: broker, told: told('PROOF-L-1').slice(0, 300) })

    // ---- 1. write-enabled seat, hosted
    const w = await turn('hwriter', 'PROOF-H-W')
    const wPid = lastPid('hwriter')
    p.check('1 write seat: the scripted steps ran to its done report', w?.status === 'idle', { status: status('hwriter'), last_error: rig.agentRow('hwriter')?.last_error })
    p.check('1 write seat: its Codex was started by the helper, in a non-zero session', of('hwriter', HOSTED).length === 1 && sessionOf(wPid) > 0,
      { pid: wPid, session: sessionOf(wPid), lines: of('hwriter', HOSTED) })
    p.check('1 write seat: its Codex\'s parent is the helper, not the engine', parentOf(wPid) === broker, { parent: parentOf(wPid), helper: broker })
    p.check('1 write seat: Codex was told workspace-write (the OS sandbox is on)', /`sandbox_mode` is `workspace-write`/.test(told('PROOF-H-W')), told('PROOF-H-W').slice(0, 600))
    p.check('1 write seat: no "sandbox disabled" line', of('hwriter', DISABLED).length === 0, of('hwriter', DISABLED))
    p.check('1 write seat: its sandboxed shell write ran and printed the file', output('PROOF-H-W-SHELL').includes('PROOF-H-W-SHELL-OK')
      && (read('hwriter', 'hw-shell.txt') ?? '').includes('PROOF-H-W-SHELL-OK'), { output: output('PROOF-H-W-SHELL').slice(0, 800), file: read('hwriter', 'hw-shell.txt') })
    p.check('1 write seat: its apply_patch wrote the file', (read('hwriter', 'hw-patch.txt') ?? '').includes('PROOF-H-W-PATCH-OK'),
      { output: output('PROOF-H-W-PATCH').slice(0, 800) })
    p.check('1 no runner failure in the write seat\'s output', !/pipe-in|0xc0000142|-1073741502/i.test(output('PROOF-H-W')), output('PROOF-H-W').slice(0, 800))

    p.check('hosted git and gh commands receive credentials through the desktop slot', output('PROOF-H-W-CREDENTIALS').includes('PROOF-H-W-CREDENTIALS-OK'), output('PROOF-H-W-CREDENTIALS').slice(0,400))
    const lookups = () => {try {return fs.readFileSync(deskCalls,'utf8').trim().split('\n').map(JSON.parse)}catch{return []}}
    p.check('desktop served both credential kinds while helper only hosted', ['git','gh'].every(k=>lookups().some(r=>r.kind===k)), lookups())

    // ---- 2. read-only seat, hosted
    const r = await turn('hreader', 'PROOF-H-R')
    const rPid = lastPid('hreader')
    p.check('2 read seat: the scripted steps ran to its done report', r?.status === 'idle', { status: status('hreader'), last_error: rig.agentRow('hreader')?.last_error })
    p.check('2 read seat: hosted, in a non-zero session', of('hreader', HOSTED).length === 1 && sessionOf(rPid) > 0, { pid: rPid, session: sessionOf(rPid) })
    const rTold = told('PROOF-H-R')
    p.check('2 read seat: Codex was told read-only, approvals on-request', /`sandbox_mode` is `read-only`/.test(rTold) && !/unless-trusted/.test(rTold), rTold.slice(0, 1200))
    p.note('2 read seat: its read command', output('Get-ChildItem -Name').slice(0, 600))
    p.check('2 read seat: its write was denied by the sandbox and left no file', read('hreader', 'hr-write.txt') === null
      && /Access to the path [\s\S]* is denied/.test(output('PROOF-H-R-WRITE')), output('PROOF-H-R-WRITE').slice(0, 800))

    // ---- 3. bypassPermissions seat: Session 0, started by the engine
    const b = await turn('bwriter', 'PROOF-B-W')
    const bPid = lastPid('bwriter')
    p.check('3 bypass seat: the scripted steps ran to its done report', b?.status === 'idle', { status: status('bwriter'), last_error: rig.agentRow('bwriter')?.last_error })
    p.check('3 bypass seat: not hosted; the engine started its Codex, in the engine\'s session', of('bwriter', HOSTED).length === 0 && bPid > 0
      && parentOf(bPid) === identity.pid && sessionOf(bPid) === sessionOf(identity.pid),
      { pid: bPid, parent: parentOf(bPid), engine: identity.pid, session: sessionOf(bPid) })
    p.check('3 bypass seat: told danger-full-access, and its write landed', /`sandbox_mode` is `danger-full-access`/.test(told('PROOF-B-W'))
      && (read('bwriter', 'bw-shell.txt') ?? '').includes('PROOF-B-W-SHELL-OK'), told('PROOF-B-W').slice(0, 400))

    // ---- 4. halting a hosted seat ends its Codex
    p.check('4 the read seat\'s hosted Codex is still running before the halt', alive(rPid), { pid: rPid })
    await rig.op({ op: 'halt', nodes: ['hreader'] })
    const ended = await rig.waitFor(() => !alive(rPid), { timeout: 20000, what: 'hosted Codex to end' }).then(() => true, () => false)
    p.check('4 halting the hosted seat ends its Codex', ended, { pid: rPid })
    const kills = () => { try { return fs.readFileSync(path.join(rig.data, 'diagnostics', 'logs', 'codex-kills.log'), 'utf8').split(/\r?\n/).filter(l => l.includes(` pid=${rPid} `)) } catch { return [] } }
    await rig.waitFor(() => kills().length > 0 || null, { timeout: 10000, what: 'its kill record' }).catch(() => null)
    p.check('4 by a natural exit after its input closed (codex-graceful-exit, no codex-force-kill)',
      kills().some(l => l.includes('codex-graceful-exit')) && !kills().some(l => l.includes('codex-force-kill')), kills())

    // ---- 5. the helper dies: hosted Codex ends; the next turn runs in Session 0
    p.check('5 the write seat\'s hosted Codex runs before the helper dies', alive(wPid), { pid: wPid })
    kill(broker)
    await rig.waitFor(() => brokerPid(bin) === 0, { timeout: 10000, what: 'helper exit' })
    broker = 0
    const gone = await rig.waitFor(() => !alive(wPid), { timeout: 15000, what: 'hosted Codex to end with the helper' }).then(() => true, () => false)
    p.check('5 the hosted Codex ends with the helper', gone, { pid: wPid })
    const f = await turn('hwriter', 'PROOF-F-W', 300000)
    const fPid = lastPid('hwriter')
    p.check('5 the seat\'s next turn completes', f?.status === 'idle', { status: status('hwriter'), last_error: rig.agentRow('hwriter')?.last_error })
    p.check('5 the engine started it itself, without the OS sandbox, logged once', fPid !== wPid && of('hwriter', HOSTED).length === 1
      && of('hwriter', DISABLED).length === 1 && parentOf(fPid) === identity.pid, { pid: fPid, parent: parentOf(fPid), disabled: of('hwriter', DISABLED) })
    p.check('5 told danger-full-access, and its write landed', /`sandbox_mode` is `danger-full-access`/.test(told('PROOF-F-W'))
      && (read('hwriter', 'fw-shell.txt') ?? '').includes('PROOF-F-W-SHELL-OK'), told('PROOF-F-W').slice(0, 400))
    p.check('desktop credential lease remains renewable after helper death', await registerDesk() === 200 && renewalFailures === 0, {renewalFailures})
    p.check('dead host can be replaced before its lease expires', await registerDesk({role:'host',caps:['spawn']}) === 200)
    p.check('host release does not release desktop credentials', await registerDesk({role:'host',caps:['spawn'],release:true}) === 200 && await registerDesk() === 200)
    p.note('helper log', (() => { try { return fs.readFileSync(path.join(rig.data, 'credential-broker.log'), 'utf8').split(/\r?\n/).filter(Boolean).slice(-12) } catch { return null } })())
  } finally {
    clearInterval(renewal)
    if (desk) { await registerDesk({release:true}).catch(()=>{}); kill(desk.pid) }
    kill(broker)
    p.check(`the temporary task ${taskName} is deleted`, session.remove())
    p.keep(rig, { grep: /Codex OS sandbox|Codex started by the sign-in helper|sign-in helper could not|CLI started|CLI exit|codex stderr|[Cc]redential broker/ })
    await llm.close()
  }
  return p.summary()
}
