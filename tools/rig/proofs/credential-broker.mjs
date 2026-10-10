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
// 1. The broker attaches through a descriptor (the desktop's trust and
//    identity checks) and holds the bridge. An agent runs `gh auth status`,
//    git credential lookups through the engine's git helper, and
//    `git ls-remote`. A synthetic credential for rig-proof.example, visible
//    only to the broker's process (GIT_CONFIG_GLOBAL including the user's own
//    file), proves a git credential coming back; the gh and github.com
//    lookups reach this Windows user's real store and only their outcome is
//    kept. Nothing is pushed.
// 2. Handover both ways with the stand-in desktop (credential-desktop-stub.mjs):
//    held while the broker lives, taken at once when it dies, the broker
//    stands by, and the desktop's release hands it back within one poll.
// 3. The broker's idle memory and CPU.
// 4. With no broker, the same commands report [no-desktop].
//
// The descriptor's folder must pass the trust check, and E:\ is writable by
// Authenticated Users, so run it with a rig home under your profile:
//   set ORGTREE_RIG_HOME=%LOCALAPPDATA%\orgtree-rig-broker
//   node tools/rig/rig.mjs run tools/rig/proofs/credential-broker.mjs
// The broker comes from your cargo target's debug build
// (ORGTREE_RIG_BROKER names another).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

import { Proof } from '../proof.mjs'

const sleep = ms => new Promise(r => setTimeout(r, ms))
const LEAD = 'lead'
const STUB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'credential-desktop-stub.mjs')

export async function setup() {
  return { bootIsolated: true, fixture: { org: { name: 'Broker Org' },
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
export function sessionLauncher(dir, name) {
  const vbs = path.join(dir, 'launch.vbs'), txt = path.join(dir, 'launch.txt')
  fs.writeFileSync(vbs, [
    'Set fso = CreateObject("Scripting.FileSystemObject")',
    `Set f = fso.OpenTextFile("${txt}", 1)`,
    'Set sh = CreateObject("WScript.Shell")',
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
  const exe = brokerExe()
  if (!fs.existsSync(exe)) throw Error(`no broker at ${exe}: cargo build -p orgtree-engine --bins`)
  const run = rig.refresh()
  const port = Number(new URL(rig.url).port)
  const out = path.join(rig.dir, 'agent-out')
  fs.mkdirSync(out, { recursive: true })
  const taskName = `OrgtreeRigProof-${path.basename(rig.dir)}`
  const session = sessionLauncher(rig.dir, taskName)
  let broker = 0, desk = null
  try {
    // the boot host's descriptor, as host.rs writes it (owner-only by inheritance here)
    const identity = await rig.api('GET', '/api/desktop/identity')
    p.check('the rig engine reports the boot isolation', identity.credentialContext?.general_vault_isolated === true && identity.credentialContext?.bridge_ready === false,
      { isolated: identity.credentialContext?.general_vault_isolated, ready: identity.credentialContext?.bridge_ready })
    fs.writeFileSync(path.join(rig.data, 'engine-attach.json'), JSON.stringify({ type: 'attach', protocol: 1, port, enginePid: identity.pid,
      hostPid: run.keeperPid, dataRootId: identity.dataRootId, token: rig.token, startedAt: new Date().toISOString() }))

    const bin = path.join(rig.dir, 'bin', 'orgtree-credential-broker.exe')
    fs.copyFileSync(exe, bin)
    // a credential only the broker's process can see; the user's own global file stays included
    const gitGlobal = path.join(rig.dir, 'broker-gitconfig')
    fs.writeFileSync(gitGlobal, `[include]\n\tpath = ${path.join(os.homedir(), '.gitconfig').replace(/\\/g, '/')}\n` +
      '[credential "https://rig-proof.example"]\n\thelper = "!f() { test \\"$1\\" = get && echo username=rig-proof && echo password=rig-proof-synthetic; }; f"\n')
    const brokerLog = () => { try { return fs.readFileSync(path.join(rig.data, 'credential-broker.log'), 'utf8') } catch { return '' } }
    const startBroker = async () => {
      await session.start({ ORGTREE_V2_DATA: rig.data, GIT_CONFIG_GLOBAL: gitGlobal }, `"${bin}"`)
      await rig.waitFor(() => brokerPid(bin) > 0, { timeout: 15000, what: 'broker process' })
      return brokerPid(bin)
    }
    const startDesk = async () => {
      const file = path.join(rig.dir, 'desk.json')
      fs.rmSync(file, { force: true })
      await session.start({}, `"${process.execPath}" "${STUB}" "${file}"`)
      await rig.waitFor(() => fs.existsSync(file), { timeout: 15000, what: 'stand-in desktop' })
      return JSON.parse(fs.readFileSync(file, 'utf8'))
    }
    const context = async () => (await rig.api('GET', '/api/desktop/identity')).credentialContext
    const register = async (d, extra = {}) => (await fetch(rig.url + '/api/desktop/credential-bridge', { method: 'POST',
      headers: { 'X-Orgtree-Desktop-Token': rig.token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ pipe: d.pipe, secret: d.secret, pid: d.pid, ...extra }) })).status
    const holds = () => (brokerLog().match(/holding the bridge/g) || []).length

    // the agent's commands: outcomes and presence only, never a secret in a file
    const script = path.join(rig.dir, 'agent-check.cmd')
    const engineExe = path.join(rig.dir, 'bin', 'orgtree-engine.exe')
    // git's request on stdin from a file: a parenthesised echo block in a cmd
    // pipe is re-parsed with a trailing space on every value
    const gitLookup = (host, tag) => {
      const input = path.join(rig.dir, `${tag}.in`)
      fs.writeFileSync(input, `protocol=https\nhost=${host}\n\n`)
      return `"${engineExe}" credential-helper get < "${input}" 2> "%OUT%-${tag}-err.txt" | findstr /b /c:"password=" > nul && (echo present> "%OUT%-${tag}.txt") || (echo absent> "%OUT%-${tag}.txt")`
    }
    fs.writeFileSync(script, [
      '@echo off',
      `set OUT=${out}\\%1`,
      'if defined ORGTREE_CREDENTIAL_AUTH (echo capability=yes> "%OUT%-env.txt") else (echo capability=no> "%OUT%-env.txt")',
      'gh auth status > "%OUT%-gh.txt" 2>&1',
      gitLookup('rig-proof.example', 'synthetic'),
      gitLookup('github.com', 'github'),
      'git ls-remote https://github.com/Maurdekye/orgtree HEAD > "%OUT%-lsremote.txt" 2>&1',
      'echo done> "%OUT%-done.txt"',
    ].join('\r\n') + '\r\n')
    const agentRun = async phase => {
      rig.scenario({ default: { turns: [{ steps: [{ spawn: `${script} ${phase}` }, { sleep_ms: 30000 }, { text: 'OK.' }] }] } })
      await rig.userMail(LEAD, `check ${phase}`)
      await rig.waitFor(() => fs.existsSync(path.join(out, `${phase}-done.txt`)), { timeout: 120000, what: `${phase} commands` })
      const read = f => { try { return fs.readFileSync(path.join(out, `${phase}-${f}.txt`), 'utf8').trim() } catch { return '' } }
      const r = { env: read('env'), gh: read('gh').replace(/gh[opsu]_[A-Za-z0-9_*]+/g, 'gh*_…'), synthetic: read('synthetic'), syntheticErr: read('synthetic-err'),
        github: read('github'), githubErr: read('github-err'), ls: read('lsremote') }
      p.file(`${phase}.json`, r)
      return r
    }
    const brokerCode = text => (text.match(/\[([a-z0-9-]+)\]/) || [])[1]

    // ---- 1. the broker serves an agent
    broker = await startBroker()
    await rig.waitFor(async () => (await context()).bridge_ready === true, { timeout: 30000, what: 'broker registration' })
    p.check('the broker (started by the interactive task) attaches and holds the bridge', /holding the bridge/.test(brokerLog()), brokerLog().split(/\r?\n/).filter(Boolean).slice(-3))
    const served = await agentRun('helper')
    p.check('the agent CLI carries a credential capability', served.env === 'capability=yes', served.env)
    p.check('a git credential comes back through engine → broker (synthetic rig-proof.example)', served.synthetic === 'present', { result: served.synthetic, stderr: served.syntheticErr })
    const ghCode = brokerCode(served.gh)
    p.check('gh reaches the broker: a GH_TOKEN login, or the broker\'s own lookup error', /GH_TOKEN/.test(served.gh) || (ghCode && !['no-desktop', 'no-engine', 'denied', 'busy'].includes(ghCode)),
      served.gh.split(/\r?\n/).filter(l => /Logged in|GH_TOKEN|\[|exit=|not logged/i.test(l)))
    p.check('the github.com git lookup reaches the user\'s store through the broker', served.github === 'present' || !/no-desktop|no-engine|denied/.test(served.githubErr),
      { result: served.github, stderr: served.githubErr })
    p.check('git ls-remote over HTTPS succeeds', /^[0-9a-f]{40}\s+HEAD/m.test(served.ls), served.ls.slice(0, 120))
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
    p.check('the agent is served again after the handover', again.synthetic === 'present', again.synthetic)

    // ---- 3. idle cost (no lookups since the last turn)
    const stat = () => JSON.parse(ps(`$p=Get-Process -Id ${broker}; @{ws=$p.WorkingSet64; priv=$p.PrivateMemorySize64; cpu=$p.TotalProcessorTime.TotalMilliseconds; threads=$p.Threads.Count} | ConvertTo-Json -Compress`))
    const a = stat()
    await sleep(60000)
    const b = stat()
    const idle = { workingSetMB: +(b.ws / 1048576).toFixed(1), privateMB: +(b.priv / 1048576).toFixed(1), cpuMsPer60s: Math.round(b.cpu - a.cpu), threads: b.threads,
      fileMB: +(fs.statSync(bin).size / 1048576).toFixed(1), build: 'debug' }
    p.check('idle broker: under 20 MB working set and under 1 s CPU a minute', idle.workingSetMB < 20 && idle.cpuMsPer60s < 1000, idle)

    // ---- 4. no broker: no-desktop, as today
    kill(broker); broker = 0
    await rig.waitFor(() => brokerPid(bin) === 0, { timeout: 10000, what: 'broker exit' })
    const none = await agentRun('none')
    p.check('without a broker gh reports [no-desktop]', /\[no-desktop\]/.test(none.gh), none.gh.split(/\r?\n/).filter(l => /no-desktop/.test(l)))
    p.check('without a broker the git helper reports [no-desktop]', /\[no-desktop\]/.test(none.syntheticErr) && none.synthetic === 'absent', none.syntheticErr)
    p.check('the bridge is reported down', (await context()).bridge_ready === false)
    p.file('credential-broker.log', brokerLog())
    p.keep(rig, { agents: [LEAD], grep: /[Cc]redential (broker|bridge)/ })
  } finally {
    kill(broker)
    if (desk) kill(desk.pid)
    p.check(`the temporary task ${taskName} is deleted`, session.remove())
  }
  return p.summary()
}
