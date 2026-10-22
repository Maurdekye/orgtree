// Proof: a CLI started by hand (the desk's process mark, POST
// .../nodes/<agent>/process {action: 'start'}) starts where the agent's next
// turn would run it, as warming does (docket
// after-an-engine-restart-codex-clis-and-their-mcp, follow-up; strict Session 0
// invariants 3 and 5, the user 2026-10-22 07:27-07:35Z). Fake CLIs,
// `--session0 1`, one helper (orgtree-credential-broker.exe) attached to this
// run only, as in session-startup-grace.mjs; no warming, so only a start by
// hand starts a CLI ahead of a turn.
//   1. after a restart, with the user signed in and the helper on its way
//      back, a start by hand waits for the helper, and the helper starts the
//      CLI: nothing starts in Session 0 first;
//   2. a start by hand keeps the next turn's on-demand pick: an agent that
//      picked Session 0 for its next turn (orgtree_session `use` 0), its CLI
//      stopped, gets its CLI started in Session 0, and that next turn runs
//      there, on it.
// Run with a rig home the broker's descriptor check accepts:
//   set ORGTREE_RIG_HOME=%LOCALAPPDATA%\orgtree-rig-<you>
//   node tools/rig/rig.mjs run tools/rig/proofs/process-start-placement.mjs

import fs from 'node:fs'
import path from 'node:path'
import {spawn} from 'node:child_process'

import {seed} from '../fixture.mjs'
import {Proof} from '../proof.mjs'
import {brokerExe, ps} from './credential-broker.mjs'

export async function setup() {
  return {name: 'process-start-placement', 'boot-isolated': true, session0: '1', fixture: 'none'}
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const parentOf = pid => Number(ps(`(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').ParentProcessId`) || 0)
// the harness's own launch line (`runtime.claude: CLI started agent=1 pid=22100 ...`); a bare
// /CLI started/ also matches logged prompt text ("as it was when your CLI started"), which has no pid
const LAUNCH = / runtime\.(?:claude|agy|codex|muse|opencode|acp): CLI started agent=\d+ pid=([1-9]\d*) /

export default async function (rig) {
  const p = new Proof('process-start-placement')
  const helpers = []
  const bin = path.join(rig.dir, 'bin', 'orgtree-credential-broker.exe')
  fs.copyFileSync(brokerExe(), bin)
  const placement = () => {
    try { return JSON.parse(fs.readFileSync(path.join(rig.data, 'session-placement.json'), 'utf8')).placement } catch { return null }
  }
  const logFrom = () => rig.engineLog().length
  const logSince = from => rig.engineLog().slice(from)
  // the CLIs an agent's actor started since `from`, oldest first: pid, and whether the helper started it
  const launches = (name, from) => logSince(from).split(/\r?\n/).filter(l => l.includes(`/${name} `) && LAUNCH.test(l))
    .map(l => ({pid: Number(l.match(LAUNCH)[1]), hosted: / hosted=true\b/.test(l)}))
  const turnPids = (name, token) => [...new Set(rig.fakeLog(name).filter(l => l.kind === 'turn' && (l.prompt ?? '').includes(token)).map(l => l.pid))]
  const quiet = () => rig.sql('SELECT 1 FROM ot.turns WHERE ended_at IS NULL').length === 0
  const settled = what => rig.waitFor(quiet, {what, timeout: 120000})
  const session = name => rig.agentRow(name)?.extra?.session ?? null
  const control = (name, action) => rig.api('POST', `/api/orgs/${rig.org}/nodes/${name}/process`, {action})
  async function turn(name, token, timeout = 90000) {
    const before = rig.turns(name).length
    await rig.userMail(name, `${token}: one turn, please.`)
    await rig.waitFor(() => { const t = rig.turns(name); return t.length > before && t.every(x => x.ended_at) ? t : null }, {what: `${name}'s ${token} turn`, timeout})
  }
  // the helper, attached to this run's engine (as session-startup-grace.mjs starts it)
  const start = async () => {
    const identity = await rig.api('GET', '/api/desktop/identity')
    fs.writeFileSync(path.join(rig.data, 'engine-attach.json'), JSON.stringify({
      type: 'attach', protocol: 1, port: Number(new URL(rig.url).port), enginePid: identity.pid,
      hostPid: rig.refresh().keeperPid, dataRootId: identity.dataRootId, token: rig.token, startedAt: new Date().toISOString(),
    }))
    const child = spawn(bin, [], {env: {...process.env, ORGTREE_V2_DATA: rig.data}, stdio: 'ignore', windowsHide: true})
    const exited = new Promise(resolve => { child.once('exit', resolve); child.once('error', resolve) })
    const entry = {child, exited, engine: identity.pid}
    helpers.push(entry)
    await rig.waitFor(() => rig.engineLog().split(/\r?\n/).some(l => l.includes('Sign-in helper took the Codex host slot') && l.includes(`pid=${child.pid} `)),
      {what: 'the helper to host', timeout: 30000})
    await rig.waitFor(() => placement() === 'signed-in', {what: 'signed-in placement', timeout: 20000})
    return entry
  }
  const stop = async entry => {
    if (!entry) return
    if (entry.child.exitCode === null) entry.child.kill()
    let timer
    try { await Promise.race([entry.exited, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('the helper did not exit')), 5000) })]) }
    finally { clearTimeout(timer) }
  }

  try {
    rig.scenario({
      agents: {
        mu: {turns: [
          {name: 'pick Session 0', match: 'PROOF-MU-PICK', once: true, steps: [{tool: 'orgtree_session', args: {use: 0}}, {text: 'OK.'}]}]},
      },
      default: {turns: [{steps: [{text: 'OK.'}]}]},
    })
    await seed(rig, {org: {name: 'Process Start'}, agents: [
      {name: 'ms', tier: 'haiku', charter: 'A seat whose CLI is started by hand.'},
      {name: 'mu', tier: 'haiku', charter: 'A seat that picks Session 0 for its next turn.'},
    ]})
    await settled('the hires to settle')
    let helper = await start()
    await turn('ms', 'PROOF-MS-0')
    p.check('fixture: ms\'s turn ran signed in', session('ms') === 'signed-in', {session: session('ms')})

    // ---- 1. after a restart a start by hand waits for the helper
    await stop(helper)
    await settled('the turns before the restart to end')
    const restart = logFrom()
    await rig.restart()
    const asked = Date.now()
    const reply = control('ms', 'start').catch(e => ({error: String(e?.message ?? e)}))
    await sleep(6000)
    const early = launches('ms', restart)
    helper = await start()
    const r = await reply
    const after = launches('ms', restart)
    p.check('1 nothing started for ms in Session 0 before the helper came back', early.length === 0, early)
    p.check('1 the start by hand answered once the helper hosted, and the helper started the CLI',
      r?.ok === true && r?.proc_live === true && after.length === 1 && after[0].hosted && parentOf(after[0].pid) === helper.child.pid,
      {reply: r, after, helper: helper.child.pid, ms: Date.now() - asked})

    // ---- 2. a start by hand keeps the next turn's pick
    await turn('mu', 'PROOF-MU-PICK')
    const stopped = await control('mu', 'stop')
    const picked = logFrom()
    const started = await control('mu', 'start')
    const byHand = launches('mu', picked)
    p.check('2 the start by hand put mu\'s CLI where its pick says: Session 0, started by the engine',
      stopped?.ok === true && started?.ok === true && byHand.length === 1 && !byHand[0].hosted && parentOf(byHand[0].pid) === helper.engine,
      {stopped, started, byHand, engine: helper.engine})
    await turn('mu', 'PROOF-MU-NEXT')
    const nextPids = turnPids('mu', 'PROOF-MU-NEXT')
    p.check('2 mu\'s next turn took the pick: it ran in Session 0, on the CLI started by hand',
      nextPids.length === 1 && nextPids[0] === byHand[0]?.pid && launches('mu', picked).length === 1 && session('mu') === 'session0',
      {nextPids, launches: launches('mu', picked), session: session('mu')})
  } finally {
    for (const h of helpers) await stop(h).catch(() => {})
    p.keep(rig, {agents: ['ms', 'mu'], grep: /session|helper|CLI started|by hand|Session 0/})
  }
  return p.summary()
}
