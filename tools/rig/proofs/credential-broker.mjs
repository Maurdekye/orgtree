// The sign-in credential broker (orgtree-credential-broker.exe, docket
// windows-sign-in-credential-helper-so-git-gh-work) against a rig engine that
// reports the boot task's isolation (--boot-isolated), so the agent's CLI
// gets the bridge adapters exactly as under the S4U boot task.
//
// 1. The broker attaches through a descriptor (same trust + identity checks
//    as the desktop) and holds the bridge; an agent's `gh auth status`, a git
//    credential lookup through the engine's git helper and `git ls-remote`
//    run through it (the lookups use this Windows user's real gh/git sign-in;
//    nothing is printed but presence, and nothing is pushed).
// 2. Handover both ways with a stand-in desktop broker (the desktop's pipe
//    protocol in node): held while the broker lives, taken at once when it
//    dies, the broker stands by, and the desktop's release hands it back.
// 3. With no broker, the same commands report [no-desktop].
// 4. The broker's idle memory and CPU.
//
// The descriptor's folder must pass the trust check, and E:\ is writable by
// Authenticated Users, so run it with a rig home under your profile:
//   set ORGTREE_RIG_HOME=%LOCALAPPDATA%\orgtree-rig-broker
//   node tools/rig/rig.mjs run tools/rig/proofs/credential-broker.mjs
// The broker binary comes from your cargo target (ORGTREE_RIG_BROKER names
// another).
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn, execFileSync } from 'node:child_process'

import { Proof } from '../proof.mjs'

const sleep = ms => new Promise(r => setTimeout(r, ms))
const LEAD = 'lead'

export async function setup() {
  return { bootIsolated: true, fixture: { org: { name: 'Broker Org' },
    agents: [{ name: LEAD, tier: 'opus', grant: 4 }],
    scenario: { default: { turns: [{ steps: [{ text: 'OK.' }] }] } } } }
}

function brokerExe() {
  if (process.env.ORGTREE_RIG_BROKER) return process.env.ORGTREE_RIG_BROKER
  const target = process.env.CARGO_TARGET_DIR || path.resolve('engine/rs/target')
  return path.join(target, 'debug', 'orgtree-credential-broker.exe')
}

/** The desktop broker's pipe protocol, as apps/desktop/main/credential-bridge.ts serves it (ping only). */
async function fakeDesktop() {
  const secret = crypto.randomBytes(32).toString('hex')
  const pipe = `\\\\.\\pipe\\orgtree-credentials-${process.pid}-${crypto.randomBytes(16).toString('hex')}`
  const server = net.createServer(s => {
    let raw = ''
    s.on('error', () => {})
    s.on('data', c => {
      raw += c
      const end = raw.indexOf('\n'); if (end < 0) return
      let v = {}; try { v = JSON.parse(raw.slice(0, end)) } catch {}
      if (v.secret !== secret) return s.destroy()
      s.end(v.kind === 'ping' ? 'ready' : 'orgtree-credential-error invalid-request\n')
    })
  })
  await new Promise(r => server.listen(pipe, r))
  return { pipe, secret, close: () => server.close() }
}

export default async function (rig) {
  const p = new Proof('credential-broker')
  const exe = brokerExe()
  if (!fs.existsSync(exe)) throw Error(`no broker at ${exe}: cargo build -p orgtree-engine --bins`)
  const run = rig.refresh()
  const port = Number(new URL(rig.url).port)
  const out = path.join(rig.dir, 'agent-out')
  fs.mkdirSync(out, { recursive: true })

  // the boot host's descriptor, as host.rs writes it (owner-only by inheritance here)
  const identity = await rig.api('GET', '/api/desktop/identity')
  p.check('the rig engine reports the boot isolation', identity.credentialContext?.general_vault_isolated === true && identity.credentialContext?.bridge_ready === false,
    { isolated: identity.credentialContext?.general_vault_isolated, ready: identity.credentialContext?.bridge_ready })
  fs.writeFileSync(path.join(rig.data, 'engine-attach.json'), JSON.stringify({ type: 'attach', protocol: 1, port, enginePid: identity.pid,
    hostPid: run.keeperPid, dataRootId: identity.dataRootId, token: rig.token, startedAt: new Date().toISOString() }))

  const bin = path.join(rig.dir, 'bin', 'orgtree-credential-broker.exe')
  fs.copyFileSync(exe, bin)
  const brokerLog = () => { try { return fs.readFileSync(path.join(rig.data, 'credential-broker.log'), 'utf8') } catch { return '' } }
  const startBroker = () => {
    const c = spawn(bin, [], { env: { ...process.env, ORGTREE_V2_DATA: rig.data }, stdio: 'ignore', detached: false })
    return c
  }
  const ready = async () => (await rig.api('GET', '/api/desktop/identity')).credentialContext
  const register = async (d, extra = {}) => {
    const r = await fetch(rig.url + '/api/desktop/credential-bridge', { method: 'POST',
      headers: { 'X-Orgtree-Desktop-Token': rig.token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ pipe: d.pipe, secret: d.secret, pid: process.pid, ...extra }) })
    return r.status
  }

  // the agent's commands: presence only, never a secret in a file
  const script = path.join(rig.dir, 'agent-check.cmd')
  const engineExe = path.join(rig.dir, 'bin', 'orgtree-engine.exe')
  fs.writeFileSync(script, [
    '@echo off',
    `set OUT=${out}\\%1`,
    'if defined ORGTREE_CREDENTIAL_AUTH (echo capability=yes> "%OUT%-env.txt") else (echo capability=no> "%OUT%-env.txt")',
    'gh auth status > "%OUT%-gh.txt" 2>&1',
    'echo exit=%ERRORLEVEL%>> "%OUT%-gh.txt"',
    `(echo protocol=https& echo host=github.com& echo.) | "${engineExe}" credential-helper get 2> "%OUT%-git-err.txt" | findstr /b /c:"password=" > nul && (echo git-credential=present> "%OUT%-git.txt") || (echo git-credential=absent> "%OUT%-git.txt")`,
    'git ls-remote https://github.com/Maurdekye/orgtree HEAD > "%OUT%-lsremote.txt" 2>&1',
    'echo exit=%ERRORLEVEL%>> "%OUT%-lsremote.txt"',
    'echo done> "%OUT%-done.txt"',
  ].join('\r\n') + '\r\n')
  const agentRun = async phase => {
    rig.scenario({ default: { turns: [{ steps: [{ spawn: `"${script}" ${phase}` }, { sleep_ms: 25000 }, { text: 'OK.' }] }] } })
    await rig.userMail(LEAD, `check ${phase}`)
    await rig.waitFor(() => fs.existsSync(path.join(out, `${phase}-done.txt`)), { timeout: 90000, what: `${phase} commands` })
    const read = f => { try { return fs.readFileSync(path.join(out, `${phase}-${f}.txt`), 'utf8') } catch { return '' } }
    return { env: read('env'), gh: read('gh'), git: read('git'), gitErr: read('git-err'), ls: read('lsremote') }
  }

  // ---- 1. the broker serves an agent
  let broker = startBroker()
  await rig.waitFor(async () => (await ready()).bridge_ready === true, { timeout: 30000, what: 'broker registration' })
  p.check('the broker attaches and holds the bridge', /holding the bridge/.test(brokerLog()), brokerLog().trim().split(/\r?\n/).slice(-3))
  const served = await agentRun('helper')
  p.file('helper.json', served)
  p.check('the agent CLI carries a credential capability', /capability=yes/.test(served.env), served.env.trim())
  p.check('gh auth status succeeds with the token the broker supplied (GH_TOKEN)', /GH_TOKEN/.test(served.gh) && /exit=0/.test(served.gh),
    served.gh.split(/\r?\n/).filter(l => /Logged in|GH_TOKEN|exit=/.test(l)).map(l => l.replace(/gh[opsu]_[A-Za-z0-9_*]+/g, 'gh*_…')))
  p.check('the git helper gets a github.com credential through the bridge', /git-credential=present/.test(served.git), { git: served.git.trim(), stderr: served.gitErr.trim() })
  p.check('git ls-remote over HTTPS succeeds', /^[0-9a-f]{40}\s+HEAD/m.test(served.ls) && /exit=0/.test(served.ls), served.ls.trim().slice(0, 120))
  const looked = (await ready()).bridge_lookup
  p.check('the engine records a successful lookup through the broker', looked?.status === 'succeeded', looked)

  // ---- 2. handover, both ways
  const desk = await fakeDesktop()
  p.check('a second broker is refused while the holder lives (409 held)', await register(desk) === 409)
  broker.kill()
  await sleep(500)
  const t0 = Date.now()
  const took = await register(desk)
  p.check('the moment the holder is gone, the desktop takes the bridge', took === 200 && (await ready()).bridge_ready, { status: took, ms: Date.now() - t0 })
  broker = startBroker()
  await rig.waitFor(() => /standing by/.test(brokerLog()), { timeout: 20000, what: 'broker standing by' })
  p.check('a broker started while the desktop holds it stands by', true, brokerLog().trim().split(/\r?\n/).slice(-2))
  const kept = await register(desk)
  p.check('the desktop renews its own lease meanwhile', kept === 200)
  const before = (brokerLog().match(/holding the bridge/g) || []).length
  const t1 = Date.now()
  p.check('the desktop releases the bridge', await register(desk, { release: true }) === 200)
  desk.close()
  await rig.waitFor(() => (brokerLog().match(/holding the bridge/g) || []).length > before, { timeout: 15000, what: 'broker takes over' })
  p.check('after the release the broker takes over within one poll', Date.now() - t1 < 7000, { ms: Date.now() - t1 })
  const again = await agentRun('handback')
  p.check('the agent is served again after the handover', /GH_TOKEN/.test(again.gh) && /git-credential=present/.test(again.git))

  // ---- 4. idle cost (the broker has been idle since the last lookup)
  const stat = () => JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-Command',
    `$p=Get-Process -Id ${broker.pid}; @{ws=$p.WorkingSet64; priv=$p.PrivateMemorySize64; cpu=$p.TotalProcessorTime.TotalMilliseconds; threads=$p.Threads.Count} | ConvertTo-Json -Compress`], { encoding: 'utf8' }))
  const a = stat()
  await sleep(60000)
  const b = stat()
  const idle = { workingSetMB: +(b.ws / 1048576).toFixed(1), privateMB: +(b.priv / 1048576).toFixed(1), cpuMsPer60s: +(b.cpu - a.cpu).toFixed(0), threads: b.threads,
    fileMB: +(fs.statSync(bin).size / 1048576).toFixed(1) }
  p.note('broker idle cost over 60 s (debug build)', idle)
  p.check('idle broker: under 20 MB working set and under 1 s CPU a minute', idle.workingSetMB < 20 && idle.cpuMsPer60s < 1000, idle)

  // ---- 3. no broker: no-desktop, as today
  broker.kill()
  await sleep(500)
  const none = await agentRun('none')
  p.file('none.json', none)
  p.check('without a broker gh reports [no-desktop]', /\[no-desktop\]/.test(none.gh), none.gh.split(/\r?\n/).filter(l => /no-desktop/.test(l)))
  p.check('without a broker the git helper reports [no-desktop]', /\[no-desktop\]/.test(none.gitErr), none.gitErr.trim())
  p.check('the bridge is reported down', (await ready()).bridge_ready === false)

  p.file('credential-broker.log', brokerLog())
  p.keep(rig, { agents: [LEAD], grep: /[Cc]redential (broker|bridge)/ })
  return p.summary()
}
