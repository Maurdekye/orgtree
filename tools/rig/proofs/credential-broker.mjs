// The sign-in credential broker (orgtree-credential-broker.exe, docket
// windows-sign-in-credential-helper-so-git-gh-work) against a rig engine that
// reports the boot task's isolation (--boot-isolated), so the agent's CLI
// gets the bridge adapters exactly as under the S4U boot task.
//
// The engine accepts only a broker running with an INTERACTIVE token, and an
// agent's own processes may carry the boot task's BATCH token, so the broker
// and the stand-in desktop start through ONE temporary per-user scheduled
// task (OrgtreeRigProof-<run>: interactive, on demand, no admin; coordinator
// 2026-10-10 08:33Z) via a hidden wscript launcher (no window). The task is
// deleted in a finally block and its absence checked.
//
// 1. The broker and hosted child use scratch-native Git/gh fixtures only.
//    No network, user Git include, gh config or Windows credential store.
// 2. Handover both ways with the stand-in desktop (credential-desktop-stub.mjs):
//    held while the broker lives, taken at once when it dies, the broker
//    stands by, and the desktop's release hands it back within one poll.
// 3. The broker's idle memory and CPU.
// 4. With no broker, what a broker served is answered from the engine's
//    memory (the user, 2026-10-22 07:38Z: a memory-only cache of the
//    credentials served while signed in, for Session 0 agents after sign-out),
//    logged once and never the credential; a request no broker served (the
//    failing host's) reports [no-desktop].
//
// The descriptor's folder must pass the trust check, and E:\ is writable by
// Authenticated Users, so run it with a rig home under your profile, and its
// synthetic home and evidence (RIG_BROKER_OUTPUT) outside that rig home: inside
// it, the rig's live-data guard refuses the run once the fixture has pointed
// APPDATA and the home folder there:
//   set ORGTREE_RIG_HOME=%LOCALAPPDATA%\orgtree-rig-broker
//   set RIG_BROKER_OUTPUT=<a folder outside it>
//   node tools/rig/rig.mjs run tools/rig/proofs/credential-broker.mjs
// The broker comes from your cargo target's debug build
// (ORGTREE_RIG_BROKER names another).
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

import { Proof } from '../proof.mjs'
import { prepareFixture, fixtureEnvironment, assertFixture, agentCommand } from '../broker-synthetic.mjs'

const sleep = ms => new Promise(r => setTimeout(r, ms))
const LEAD = 'lead'
const STUB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'credential-desktop-stub.mjs')

export async function setup() {
  return { 'boot-isolated': true, bootIsolated: true, prepare: prepareFixture, fixture: { org: { name: 'Broker Org' },
    agents: [{ name: LEAD, tier: 'opus', grant: 4 }],
    scenario: { default: { turns: [{ steps: [{ text: 'OK.' }] }] } } } }
}

export function brokerExe() {
  if (process.env.ORGTREE_RIG_BROKER) return process.env.ORGTREE_RIG_BROKER
  const target = process.env.CARGO_TARGET_DIR || path.resolve('engine/rs/target')
  return path.join(target, 'debug', 'orgtree-credential-broker.exe')
}

export const ps = cmd => execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], { encoding: 'utf8' }).trim()
export const q = s => "'" + String(s).replace(/'/g, "''") + "'"

/** One temporary interactive task; each start runs what launch.txt names
 *  (NAME=value lines set the environment, `run <command line>` starts it hidden). */
export function sessionLauncher(dir, name, { isolated = false } = {}) {
  const vbs = path.join(dir, 'launch.vbs'), txt = path.join(dir, 'launch.txt')
  fs.writeFileSync(vbs, [
    'Set fso = CreateObject("Scripting.FileSystemObject")',
    `Set f = fso.OpenTextFile("${txt}", 1)`,
    'Set sh = CreateObject("WScript.Shell")',
    ...(isolated ? [
      'keys = ""',
      'For Each entry In sh.Environment("Process")',
      '  eq = InStr(entry, "=")',
      '  If eq > 1 Then keys = keys & Left(entry, eq - 1) & vbLf',
      'Next',
      'For Each key In Split(keys, vbLf)',
      '  If Len(key) > 0 Then sh.Environment("Process").Remove key',
      'Next',
    ] : []),
    'Do Until f.AtEndOfStream',
    '  line = f.ReadLine',
    '  eq = InStr(line, "=")',
    '  If Left(line, 4) = "run " Then',
    '    sh.Run Mid(line, 5), 0, False',
    '  ElseIf eq > 0 Then',
    '    sh.Environment("Process")(Left(line, eq - 1)) = Mid(line, eq + 1)',
    '  End If',
    'Loop',
  ].join('\r\n'))
  ps(`$a=New-ScheduledTaskAction -Execute 'wscript.exe' -Argument ${q('"' + vbs + '"')};` +
    `$p=New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited;` +
    `$s=New-ScheduledTaskSettingsSet -MultipleInstances Parallel -ExecutionTimeLimit (New-TimeSpan -Minutes 15);` +
    `Register-ScheduledTask -TaskName ${q(name)} -Action $a -Principal $p -Settings $s -Force | Out-Null`)
  return {
    async start(env, command) {
      fs.writeFileSync(txt, [...Object.entries(env).map(([k, v]) => `${k}=${v}`), `run ${command}`].join('\r\n'))
      ps(`Start-ScheduledTask -TaskName ${q(name)}`)
      await sleep(1500)
    },
    remove() {
      try { ps(`Unregister-ScheduledTask -TaskName ${q(name)} -Confirm:$false`) } catch {}
      try { execFileSync('schtasks.exe', ['/Query', '/TN', name], { stdio: 'ignore' }); return false } catch { return true }
    },
  }
}

export const brokerPid = exe => {
  const out = ps(`(Get-Process orgtree-credential-broker -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq ${q(exe)} }).Id`)
  return out ? Number(out.split(/\s+/)[0]) : 0
}
const kill = pid => { if (pid) try { process.kill(pid) } catch {} }

export default async function (rig) {
  const p = new Proof('credential-broker')
  if (process.env.RIG_BROKER_OUTPUT) {
    p.dir = path.join(process.env.RIG_BROKER_OUTPUT, 'evidence')
    fs.mkdirSync(p.dir, { recursive: true })
  }
  const exe = brokerExe()
  if (!fs.existsSync(exe)) throw Error(`no broker at ${exe}: cargo build -p orgtree-engine --bins`)
  const run = rig.refresh()
  const port = Number(new URL(rig.url).port)
  const out = path.join(rig.dir, 'agent-out')
  fs.mkdirSync(out, { recursive: true })
  const taskName = `OrgtreeRigProof-${path.basename(rig.dir)}`
  const session = sessionLauncher(rig.dir, taskName, { isolated: true })
  let broker = 0, desk = null
  try {
    // the boot host's descriptor, as host.rs writes it (owner-only by inheritance here)
    const identity = await rig.api('GET', '/api/desktop/identity')
    if (!p.check('the rig engine reports the boot isolation', identity.credentialContext?.general_vault_isolated === true && identity.credentialContext?.bridge_ready === false,
      { isolated: identity.credentialContext?.general_vault_isolated, ready: identity.credentialContext?.bridge_ready })) {
      throw Error('required rig boot isolation is unavailable')
    }
    fs.writeFileSync(path.join(rig.data, 'engine-attach.json'), JSON.stringify({ type: 'attach', protocol: 1, port, enginePid: identity.pid,
      hostPid: run.keeperPid, dataRootId: identity.dataRootId, token: rig.token, startedAt: new Date().toISOString() }))

    const bin = path.join(rig.dir, 'bin', 'orgtree-credential-broker.exe')
    fs.copyFileSync(exe, bin)
    const isolated = fixtureEnvironment(rig.dir)
    p.file('synthetic-preflight.json', assertFixture(isolated))
    const brokerLog = () => { try { return fs.readFileSync(path.join(rig.data, 'credential-broker.log'), 'utf8') } catch { return '' } }
    const startBroker = async () => {
      await session.start({ ...isolated, ORGTREE_V2_DATA: rig.data }, `"${bin}"`)
      await rig.waitFor(() => brokerPid(bin) > 0, { timeout: 15000, what: 'broker process' })
      return brokerPid(bin)
    }
    const startDesk = async () => {
      const file = path.join(rig.dir, 'desk.json')
      fs.rmSync(file, { force: true })
      await session.start(isolated, `"${process.execPath}" "${STUB}" "${file}"`)
      await rig.waitFor(() => fs.existsSync(file), { timeout: 15000, what: 'stand-in desktop' })
      return JSON.parse(fs.readFileSync(file, 'utf8'))
    }
    const context = async () => (await rig.api('GET', '/api/desktop/identity')).credentialContext
    const register = async (d, extra = {}) => (await fetch(rig.url + '/api/desktop/credential-bridge', { method: 'POST',
      headers: { 'X-Orgtree-Desktop-Token': rig.token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ pipe: d.pipe, secret: d.secret, pid: d.pid, ...extra }) })).status
    const holds = () => (brokerLog().match(/holding the bridge/g) || []).length

    // Audit this fixed command plan before starting the broker or hosted child.
    const script = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'broker-agent-check.mjs')
    const engineExe = path.join(rig.dir, 'bin', 'orgtree-engine.exe')
    p.file('command-plan.json', { node: process.execPath, script, engine: engineExe,
      gh: ['auth', 'status', '--hostname', 'rig-proof.example'],
      git: ['credential-helper', 'get'], hosts: ['rig-proof.example', 'rig-failure.example'],
      denied: 'synthetic-invalid-capability', noExternalNetwork: true })
    let completedTurns = 0
    const agentRun = async phase => {
      const command = agentCommand(rig.dir, [process.execPath, script, engineExe, out], phase)
      p.file(phase + '-agent-check.cmd', fs.readFileSync(path.join(rig.dir, 'agent-check.cmd')))
      rig.scenario({ default: { turns: [{ steps: [{ spawn: command }, { sleep_ms: 30000 }, { text: 'OK.' }] }] } })
      await rig.userMail(LEAD, `check ${phase}`)
      await rig.waitFor(() => fs.existsSync(path.join(out, `${phase}-done.txt`)), { timeout: 120000, what: `${phase} commands` })
      const result = JSON.parse(fs.readFileSync(path.join(out, phase + '.json'), 'utf8'))
      p.file(phase + '-commands.json', fs.readFileSync(path.join(out, phase + '-commands.json')))
      p.file(phase + '.json', result)
      await rig.waitTurns(LEAD, ++completedTurns)
      return result
    }
    // ---- 1. the broker serves an agent
    broker = await startBroker()
    await rig.waitFor(async () => (await context()).bridge_ready === true, { timeout: 30000, what: 'broker registration' })
    p.check('the broker (started by the interactive task) attaches and holds the bridge', /holding the bridge/.test(brokerLog()), brokerLog().split(/\r?\n/).filter(Boolean).slice(-3))
    const served = await agentRun('helper')
    p.check('the hosted child carries a credential capability', served.capability)
    p.check('synthetic Git credential returns through engine and broker', served.synthetic.present, served.synthetic)
    p.check('synthetic gh receives only the broker token', served.gh.status === 0 && served.gh.label === 'synthetic token received through bridge', served.gh)
    p.check('synthetic lookup failure reaches the child as a fixed code', !served.failure.present && /\[git-exit-42\]/.test(served.failure.stderr), served.failure)
    p.check('an invalid child capability is refused', !served.denied.present && /\[denied\]/.test(served.denied.stderr), served.denied)
    p.note('the engine\'s last lookup through the broker', (await context()).bridge_lookup)

    // ---- 2. handover, both ways
    desk = await startDesk()
    p.check('a second broker is refused while the holder lives (409 held)', await register(desk) === 409)
    kill(broker)
    await rig.waitFor(() => brokerPid(bin) === 0, { timeout: 10000, what: 'broker exit' })
    const t0 = Date.now()
    const took = await register(desk)
    p.check('once the holder is gone the desktop takes the bridge at once', took === 200 && (await context()).bridge_ready, { status: took, ms: Date.now() - t0 })
    broker = await startBroker()
    await rig.waitFor(() => /standing by/.test(brokerLog()), { timeout: 20000, what: 'broker standing by' })
    p.check('a broker started while the desktop holds it stands by', true, brokerLog().split(/\r?\n/).filter(Boolean).slice(-2))
    p.check('the desktop renews its own lease meanwhile', await register(desk) === 200)
    const before = holds()
    const t1 = Date.now()
    p.check('the desktop releases the bridge', await register(desk, { release: true }) === 200)
    kill(desk.pid)
    await rig.waitFor(() => holds() > before, { timeout: 15000, what: 'broker takes over' })
    p.check('after the release the broker takes over within one poll (5 s)', Date.now() - t1 < 7000, { ms: Date.now() - t1 })
    const again = await agentRun('handback')
    p.check('the agent is served again after the handover', again.synthetic.present, again.synthetic)

    // ---- 3. idle cost (no lookups since the last turn)
    const stat = () => JSON.parse(ps(`$p=Get-Process -Id ${broker}; @{ws=$p.WorkingSet64; priv=$p.PrivateMemorySize64; cpu=$p.TotalProcessorTime.TotalMilliseconds; threads=$p.Threads.Count} | ConvertTo-Json -Compress`))
    const a = stat()
    await sleep(60000)
    const b = stat()
    const idle = { workingSetMB: +(b.ws / 1048576).toFixed(1), privateMB: +(b.priv / 1048576).toFixed(1), cpuMsPer60s: Math.round(b.cpu - a.cpu), threads: b.threads,
      fileMB: +(fs.statSync(bin).size / 1048576).toFixed(1), build: 'debug' }
    p.check('idle broker: under 20 MB working set and under 1 s CPU a minute', idle.workingSetMB < 20 && idle.cpuMsPer60s < 1000, idle)

    // ---- 4. no broker: what one served comes from the engine's memory; nothing else does
    kill(broker); broker = 0
    await rig.waitFor(() => brokerPid(bin) === 0, { timeout: 10000, what: 'broker exit' })
    const memoryFrom = rig.engineLog().length
    const none = await agentRun('none')
    p.check('without a broker gh gets the token a broker served earlier, from memory', none.gh.status === 0 && none.gh.label === 'synthetic token received through bridge', none.gh)
    p.check('without a broker Git gets the credential a broker served earlier, from memory', none.synthetic.present, none.synthetic)
    p.check('without a broker a request no broker served (its lookup failed) returns no-desktop and no credential', /\[no-desktop\]/.test(none.failure.stderr) && !none.failure.present, none.failure)
    p.check('without a broker an invalid child capability is still refused', !none.denied.present && /\[denied\]/.test(none.denied.stderr), none.denied)
    p.check('the bridge is reported down', (await context()).bridge_ready === false)
    const memory = rig.engineLog().slice(memoryFrom).split(/\r?\n/).filter(l => l.includes('answered from the credentials a signed-in broker served earlier'))
    p.check('the engine logs answering from memory once, and no log holds the credential', memory.length === 1
      && !rig.engineLog().includes('rig-proof-synthetic-token') && !brokerLog().includes('rig-proof-synthetic-token'), memory.map(l => l.slice(0, 220)))
    p.file('credential-broker.log', brokerLog())
    p.file('synthetic-calls.tsv', fs.readFileSync(path.join(isolated.HOME, 'calls.tsv'), 'utf8'))
    p.keep(rig, { agents: [LEAD], grep: /[Cc]redential (broker|bridge)/ })
  } finally {
    kill(broker)
    if (desk) kill(desk.pid)
    p.check(`the temporary task ${taskName} is deleted`, session.remove())
  }
  return p.summary()
}
