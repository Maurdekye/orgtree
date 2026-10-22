// Proof: where warm CLIs run around the sign-in helper's arrival (docket
// after-an-engine-restart-codex-clis-and-their-mcp; strict Session 0
// invariants 3 and 5, the user 2026-10-22 07:27-07:35Z; "Move them at
// sign-in", the user 2026-10-22 14:21Z). Fake CLIs, `--session0 1`, warming
// on (`warming`: a safe start warms nothing), one helper
// (orgtree-credential-broker.exe) attached to this run only, as in
// session-startup-grace.mjs; signed out is the core monitor's debug-rig
// stand-in (<data>\core-rig-signed-out).
//   1. the helper's arrival moves idle CLIs: signed out, five agents' turns
//      leave their CLIs parked in Session 0; the helper comes up: cl (Claude),
//      cx (Codex, full access) and sb (Codex, sandboxed) are closed (each
//      Codex by its graceful exit) and warmed again by the helper; kb, whose
//      background command still runs, and pz, who prefers Session 0, keep
//      theirs;
//   2. a Codex parked in Session 0 is not reused once the helper hosts:
//      signed out again, cx's turn runs in Session 0 and the helper comes up
//      during it; that turn keeps its CLI; cx's next turn runs on a new Codex
//      the helper started, signed in, and the old one exits gracefully;
//   3. warming waits for the helper after a restart: with the helper down and
//      the user signed in, the engine restarts and the helper comes back 8 s
//      later: nothing is warmed for cl, cx or sb before it, and every CLI
//      warmed for them after it is the helper's; pz's, by its own preference,
//      starts in Session 0 at once and stays; cl's next turn runs on its warm
//      CLI.
// Run with a rig home the broker's descriptor check accepts:
//   set ORGTREE_RIG_HOME=%LOCALAPPDATA%\orgtree-rig-<you>
//   node tools/rig/rig.mjs run tools/rig/proofs/warm-placement.mjs

import fs from 'node:fs'
import path from 'node:path'
import {spawn} from 'node:child_process'

import {seed} from '../fixture.mjs'
import {Proof} from '../proof.mjs'
import {brokerExe, ps} from './credential-broker.mjs'

export async function setup() {
  return {name: 'warm-placement', 'boot-isolated': true, session0: '1', fixture: 'none', warming: true}
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const parentOf = pid => Number(ps(`(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').ParentProcessId`) || 0)
const alive = pid => !!pid && ps(`(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).Id`) !== ''
const AGENTS = ['cl', 'cx', 'sb', 'kb', 'pz']
const MOVED = ['cl', 'cx', 'sb']
const FINISHED = 'Your background command has finished'
// the harness's own launch line (`runtime.claude: CLI started agent=1 pid=22100 ...`); a bare
// /CLI started/ also matches logged prompt text ("as it was when your CLI started"), which has no pid
const LAUNCH = / runtime\.(?:claude|agy|codex|muse|opencode|acp): CLI started agent=\d+ pid=([1-9]\d*) /

export default async function (rig) {
  const p = new Proof('warm-placement')
  const helpers = []
  const bin = path.join(rig.dir, 'bin', 'orgtree-credential-broker.exe')
  fs.copyFileSync(brokerExe(), bin)
  const signedOut = path.join(rig.data, 'core-rig-signed-out')
  const signOut = () => fs.writeFileSync(signedOut, 'debug rig WTS input only')
  const signIn = () => fs.rmSync(signedOut, {force: true})
  const placement = () => {
    try { return JSON.parse(fs.readFileSync(path.join(rig.data, 'session-placement.json'), 'utf8')).placement } catch { return null }
  }
  const logFrom = () => rig.engineLog().length
  const logSince = from => rig.engineLog().slice(from)
  // the CLIs an agent's actor started since `from`, oldest first: pid, and whether the helper started it
  const launches = (name, from) => {
    const text = logSince(from)
    return text.split(/\r?\n/).filter(l => l.includes(`/${name} `) && LAUNCH.test(l)).map(l => {
      const pid = Number(l.match(LAUNCH)[1])
      const hosted = / hosted=true\b/.test(l)
        || new RegExp(`Codex started by the sign-in helper in the user's session agent=\\d+ pid=${pid}\\b`).test(text)
      return {pid, hosted}
    })
  }
  const kills = pid => {
    try { return fs.readFileSync(path.join(rig.data, 'diagnostics', 'logs', 'codex-kills.log'), 'utf8').split(/\r?\n/).filter(l => l.includes(` pid=${pid} `)) } catch { return [] }
  }
  const graceful = pid => kills(pid).some(l => l.includes('codex-graceful-exit')) && !kills(pid).some(l => l.includes('codex-force-kill'))
  const prompts = name => rig.fakeLog(name).filter(l => l.kind === 'turn').map(l => l.prompt ?? '')
  const turnPids = (name, token) => [...new Set(rig.fakeLog(name).filter(l => l.kind === 'turn' && (l.prompt ?? '').includes(token)).map(l => l.pid))]
  const quiet = () => rig.sql('SELECT 1 FROM ot.turns WHERE ended_at IS NULL').length === 0
  const settled = what => rig.waitFor(quiet, {what, timeout: 120000})
  const session = name => rig.agentRow(name)?.extra?.session ?? null
  async function turn(name, token, timeout = 90000) {
    const before = rig.turns(name).length
    await rig.userMail(name, `${token}: one turn, please.`)
    await rig.waitFor(() => { const t = rig.turns(name); return t.length > before && t.every(x => x.ended_at) ? t : null }, {what: `${name}'s ${token} turn`, timeout})
  }
  const waitOrNull = (fn, what, timeout) => rig.waitFor(fn, {what, timeout}).catch(() => null)
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
        kb: {turns: [
          {name: 'background job', match: 'PROOF-KB', once: true, steps: [
            {bg: {task: 'bkb', id: 'toolu_bkb', command: 'npm run soak', finish_ms: 75000, output: 'KB-SOAK-OK\n'}},
            {text: 'The soak runs in the background.'}]},
          {name: 'woken', match: FINISHED, once: true, steps: [{text: 'KB-WOKEN'}]}]},
        cx: {turns: [
          {name: 'long', match: 'PROOF-CX-LONG', once: true, steps: [{text: 'Working on it.'}, {sleep_ms: 15000}, {text: 'CX-LONG-DONE'}]}]},
      },
      default: {turns: [{steps: [{text: 'OK.'}]}]},
    })
    // signed out before the hires: each hire's warm CLI starts in Session 0 at once
    signOut()
    await sleep(5000)
    await seed(rig, {org: {name: 'Warm Placement'}, agents: [
      {name: 'cl', tier: 'haiku', charter: 'A Claude seat.'},
      {name: 'cx', tier: 'sol', charter: 'A full-access Codex seat.', permission_mode: 'bypassPermissions'},
      {name: 'sb', tier: 'sol', charter: 'A sandboxed Codex seat.'},
      {name: 'pz', tier: 'haiku', charter: 'A seat that prefers Session 0.'},
      {name: 'kb', tier: 'haiku', charter: 'A Claude seat with background work.'},
    ]})
    await rig.api('POST', `/api/orgs/${rig.org}/nodes/pz/scope`, {session: 'session0'})
    await settled('the hires to settle')

    // ---- 1. the helper's arrival moves idle CLIs out of Session 0
    for (const name of ['cl', 'cx', 'sb', 'pz']) await turn(name, `PROOF-S0-${name}`)
    // last, so its background command (75 s) still runs when the helper comes
    await turn('kb', 'PROOF-KB')
    const engine = (await rig.api('GET', '/api/desktop/identity')).pid
    const parked = Object.fromEntries(AGENTS.map(n => [n, turnPids(n, n === 'kb' ? 'PROOF-KB' : `PROOF-S0-${n}`)[0] ?? 0]))
    p.check('1 fixture: signed out, all five turns ran in Session 0 on CLIs the engine started, still parked',
      AGENTS.every(n => session(n) === 'session0' && alive(parked[n]) && parentOf(parked[n]) === engine), {parked, engine,
        sessions: Object.fromEntries(AGENTS.map(n => [n, session(n)]))})
    const arrival = logFrom()
    signIn()
    let helper = await start()
    const moves = await waitOrNull(() => /idle CLIs in Session 0 moved to the signed-in session/.test(logSince(arrival)) || null,
      'the move of the idle CLIs', 30000)
    await waitOrNull(() => MOVED.every(n => launches(n, arrival).some(l => l.hosted)) || null, 'cl, cx and sb warmed by the helper', 15000)
    const moved = Object.fromEntries(MOVED.map(n => [n, launches(n, arrival)]))
    p.check('1 the helper\'s arrival closed cl\'s, cx\'s and sb\'s idle Session 0 CLIs and the helper warmed them again',
      !!moves && MOVED.every(n => moved[n].length === 1 && moved[n][0].hosted && parentOf(moved[n][0].pid) === helper.child.pid && !alive(parked[n])),
      {moved, parked, helper: helper.child.pid})
    p.check('1 cx\'s and sb\'s Codex in Session 0 ended by a graceful exit (codex-graceful-exit, no codex-force-kill)',
      graceful(parked.cx) && graceful(parked.sb), {cx: kills(parked.cx), sb: kills(parked.sb)})
    p.check('1 kb keeps its Session 0 CLI while its background command runs',
      launches('kb', arrival).length === 0 && alive(parked.kb) && parentOf(parked.kb) === engine && !prompts('kb').some(s => s.includes(FINISHED)),
      {launches: launches('kb', arrival), pid: parked.kb})
    p.check('1 pz, who prefers Session 0, keeps its Session 0 CLI',
      launches('pz', arrival).length === 0 && alive(parked.pz) && parentOf(parked.pz) === engine, {launches: launches('pz', arrival), pid: parked.pz})
    await waitOrNull(() => prompts('kb').some(s => s.includes(FINISHED)) && quiet() || null, 'kb\'s woken turn', 150000)

    // ---- 2. a Codex parked in Session 0 is not reused once the helper hosts
    await stop(helper)
    signOut()
    await waitOrNull(() => placement() === 'session0' || null, 'the sign-out to land', 30000)
    await settled('the turns before the sign-out to end')
    const long = logFrom()
    await rig.userMail('cx', 'PROOF-CX-LONG: one long turn, please.')
    await rig.waitFor(() => prompts('cx').some(s => s.includes('PROOF-CX-LONG')) || null, {what: 'cx\'s long turn to start', timeout: 60000})
    const during = logFrom()
    signIn()
    helper = await start()
    await rig.waitFor(() => rig.turns('cx').every(t => t.ended_at) || null, {what: 'cx\'s long turn to end', timeout: 90000})
    const longPids = turnPids('cx', 'PROOF-CX-LONG')
    const s0 = longPids[0] ?? 0
    // its Codex is new where step 1 moved cx's CLI to the helper, whose stop ended it, and
    // step 1's own Session 0 one where nothing moved it
    p.check('2 cx\'s long turn ran in Session 0, signed out, on a Codex the engine started',
      longPids.length === 1 && alive(s0) && parentOf(s0) === engine && session('cx') === 'session0',
      {longPids, launches: launches('cx', long), parent: parentOf(s0), engine, session: session('cx')})
    p.check('2 the helper came up during that turn, which kept its CLI to the end; it stays parked',
      launches('cx', during).length === 0 && alive(s0), {launches: launches('cx', during), pid: s0})
    const next = logFrom()
    await turn('cx', 'PROOF-CX-NEXT')
    const nextPids = turnPids('cx', 'PROOF-CX-NEXT')
    const fresh = launches('cx', next)
    p.check('2 cx\'s next turn ran on a new Codex the helper started, signed in',
      nextPids.length === 1 && nextPids[0] !== s0 && fresh.length === 1 && fresh[0].hosted && fresh[0].pid === nextPids[0]
        && parentOf(nextPids[0]) === helper.child.pid && session('cx') === 'signed-in',
      {nextPids, fresh, session: session('cx'), s0})
    await waitOrNull(() => kills(s0).length > 0 || null, 'the Session 0 Codex\'s exit record', 15000)
    p.check('2 the Session 0 Codex it replaced ended by a graceful exit', graceful(s0) && !alive(s0), kills(s0))

    // ---- 3. warming waits for the helper after a restart
    await stop(helper)
    signIn()
    await settled('the turns before the restart to end')
    const restart = logFrom()
    await rig.restart()
    await sleep(8000)
    const early = Object.fromEntries(AGENTS.map(n => [n, launches(n, restart)]))
    helper = await start()
    await waitOrNull(() => MOVED.every(n => launches(n, restart).length > 0) || null, 'cl, cx and sb to be warmed', 60000)
    await sleep(4000)
    const warmed = Object.fromEntries(AGENTS.map(n => [n, launches(n, restart)]))
    p.check('3 nothing was warmed for cl, cx or sb before the helper came back', MOVED.every(n => early[n].length === 0), early)
    p.check('3 every CLI warmed for cl, cx and sb after the restart is the helper\'s',
      MOVED.every(n => warmed[n].length === 1 && warmed[n][0].hosted && parentOf(warmed[n][0].pid) === helper.child.pid), warmed)
    const pzWarm = early.pz[0]?.pid ?? 0
    p.check('3 pz\'s warm CLI started in Session 0 at once, by its own preference, and stays after the helper came',
      early.pz.length === 1 && !early.pz[0].hosted && warmed.pz.length === 1 && alive(pzWarm) && parentOf(pzWarm) === helper.engine,
      {early: early.pz, warmed: warmed.pz, engine: helper.engine})
    await turn('cl', 'PROOF-CL-WARM')
    p.check('3 cl\'s next turn ran on its warm CLI, signed in',
      turnPids('cl', 'PROOF-CL-WARM')[0] === warmed.cl[0]?.pid && launches('cl', restart).length === 1 && session('cl') === 'signed-in',
      {pids: turnPids('cl', 'PROOF-CL-WARM'), warmed: warmed.cl, session: session('cl')})
  } finally {
    signIn()
    for (const h of helpers) await stop(h).catch(() => {})
    p.keep(rig, {agents: AGENTS, grep: /session|helper|CLI started|warm|idle CLIs|Session 0|moved/})
  }
  return p.summary()
}
