// Proof: another agent's cleanup never takes a live rig run, and rig
// databases restart quickly (docket the-test-rig-stops-deleting-live-runs-and-its-da).
//   Every `rig up` / `rig run` first cleans up runs that look dead. This proof
//   asks cleanup only as a dry run, so it never stops anyone's run:
//   a restarting run, a run still being created (asked from its prepare hook)
//   and a run crashed on purpose before its restart are never candidates; once
//   ready again its busy mark is gone and it is live by its keeper
//   controls, in a temporary rig home of fake run folders no other agent sees:
//   a stopped run and a run whose busy mark is older than 15 minutes ARE
//   candidates and a fresh mark is not; a command without --run picks the
//   caller's own newest run over a newer one of another agent, and refuses
//   when only other agents' runs are up; `down --run` removes a half-made run
//   folder (no run.json)
//   the rig cluster runs with fsync off (on with fsync: true), and a restart
//   is timed
// Run: node tools/rig/rig.mjs run tools/rig/proofs/rig-cleanup.mjs

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { RIG_DIR, cleanup, pickRun, readRun, rigHome, startRun } from '../lib.mjs'
import { Proof } from '../proof.mjs'

const SELF = fileURLToPath(import.meta.url)
const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()
const me = () => process.env.ORGTREE_AGENT || os.userInfo().username
// lib.mjs BUSY_MS (not imported: the same proof runs against the rig before the fix)
const BUSY_MS = 15 * 60 * 1000

export async function setup() {
  return { fixture: 'none' }
}

/** Whether another agent's cleanup would take the run now (a dry run stops nothing). */
async function candidate(dir) {
  const { runs } = await cleanup({ dryRun: true })
  return runs.some(r => same(r.dir, dir) && r.wouldStop)
}

/** `fsync` as the run's cluster has it. */
const fsyncOf = r => r.one(`SELECT current_setting('fsync') AS v`)?.v

/** A restart, timed; its error instead of a throw. */
async function timedRestart(rig) {
  const t0 = Date.now()
  try { await rig.restart(); return { s: (Date.now() - t0) / 1000 } } catch (e) { return { s: (Date.now() - t0) / 1000, error: e.message.slice(0, 300) } }
}

export default async function (rig) {
  const p = new Proof('rig-cleanup')

  // ------------------------------------------------------------ a restart
  const polls = []
  let restarting = true
  // each poll notes the status the run had: only polls while it was down count
  const watch = (async () => {
    while (restarting) {
      const status = readRun(rig.dir)?.status
      polls.push({ status, candidate: await candidate(rig.dir) })
      // a dry-run cleanup never awaits anything: let the restart's timers run between polls
      await new Promise(resolve => setTimeout(resolve, 250))
    }
  })()
  const restart = await timedRestart(rig)
  restarting = false
  await watch
  const down = polls.filter(x => x.status !== 'ready')
  p.check('a restarting run is never a cleanup candidate', !restart.error && down.length > 0 && !polls.some(x => x.candidate),
    { polls: polls.length, while_down: down.length, statuses: [...new Set(down.map(x => x.status))], candidate_polls: polls.filter(x => x.candidate).length, restart })

  // ------------------------------------------------------------ the rig cluster's fsync, and a timed restart
  p.check('the rig cluster runs with fsync off', fsyncOf(rig) === 'off', { fsync: fsyncOf(rig) })
  p.check('a restart is back within 120 s (the rig waits 240 s)', !restart.error && restart.s < 120, restart)

  // ------------------------------------------------------------ a run being created
  let made = null
  const r2 = await startRun({ name: 'rigclean-new', fsync: true, prepare: async ctx => { made = { dir: ctx.dir, candidate: await candidate(ctx.dir) } } })
  try {
    p.check('a run still being created (asked from its prepare hook) is never a cleanup candidate', made?.candidate === false, made)
    p.check('fsync: true keeps fsync on in that run\'s cluster', fsyncOf(r2) === 'on', { fsync: fsyncOf(r2) })
  } finally { await r2.down() }

  // ------------------------------------------------------------ a crash on purpose, then a restart
  await rig.crash()
  const crashed = await candidate(rig.dir)
  const back = await timedRestart(rig)
  const after = rig.refresh()
  const liveAgain = back.error ? null : await candidate(rig.dir)
  p.check('a run crashed on purpose is not a candidate before its restart; once ready its busy mark is gone and its keeper keeps it live',
    crashed === false && !back.error && !after.busy && liveAgain === false, { crashed, restart: back, busy: after.busy ?? null, candidate_after: liveAgain })

  // ------------------------------------------------------------ controls in a temporary rig home
  const home = path.join(rigHome(), `proof-home-${process.pid}`)
  try {
    const r = spawnSync(process.execPath, [SELF, '--temp-home'], { encoding: 'utf8', windowsHide: true, timeout: 180000,
      env: { ...process.env, ORGTREE_RIG_HOME: home } })
    let got = null
    try { got = JSON.parse(r.stdout.trim().split(/\r?\n/).pop()) } catch { /* below */ }
    if (!got) p.check('the temporary rig home checks ran', false, { status: r.status, stdout: r.stdout?.slice(-500), stderr: r.stderr?.slice(-1500) })
    else {
      p.check('a stopped run is a cleanup candidate', got.stopped === true, got)
      p.check('a run whose busy mark is older than 15 minutes is a candidate', got.expired === true, got)
      p.check('a run whose busy mark is fresh is not', got.fresh === false, got)
      p.check('without --run a command picks the caller\'s own newest run over a newer one of another agent', got.picked === 'mine', got)
      p.check('without --run it refuses when only other agents\' runs are up, and names them', /another-agent/.test(got.othersOnly ?? '') && !got.othersOnlyPicked, got)
      p.check('`down --run` removes a half-made run folder', got.halfGone === true, got)
    }
  } finally { fs.rmSync(home, { recursive: true, force: true }) }

  return p.summary()
}

// ---------------------------------------------------------------- the temporary rig home (a child process)
// ORGTREE_RIG_HOME points at a fresh folder: only this process sees its fake runs.

if (process.argv[1] && same(process.argv[1], SELF) && process.argv.includes('--temp-home')) {
  const runs = path.join(rigHome(), 'runs')
  const ago = ms => new Date(Date.now() - ms).toISOString()
  const fake = (id, run) => {
    fs.mkdirSync(path.join(runs, id, 'data'), { recursive: true })
    fs.writeFileSync(path.join(runs, id, 'run.json'), JSON.stringify({ id, dir: path.join(runs, id), ...run }, null, 2))
    return path.join(runs, id)
  }
  const stopped = fake('proofstopped-20261010-000000-0001', { status: 'stopped', by: me(), created: ago(3600000) })
  const expired = fake('proofexpired-20261010-000000-0002', { status: 'stopped', by: me(), created: ago(3600000), busy: ago(BUSY_MS + 5 * 60000) })
  const fresh = fake('prooffresh-20261010-000000-0003', { status: 'stopped', by: me(), created: ago(3600000), busy: ago(10000) })
  const { runs: seen } = await cleanup({ dryRun: true })
  const wouldStop = dir => seen.some(r => same(r.dir, dir) && r.wouldStop)
  const mine = fake('proofmine-20261010-000000-0004', { status: 'ready', by: me(), created: ago(120000) })
  fake('prooftheirs-20261010-000000-0005', { status: 'ready', by: 'another-agent', created: ago(60000) })
  const pickedDir = (() => { try { return pickRun() } catch (e) { return 'error: ' + e.message } })()
  fs.rmSync(mine, { recursive: true, force: true })
  let othersOnly = null, othersOnlyPicked = null
  try { othersOnlyPicked = pickRun() } catch (e) { othersOnly = e.message }
  const half = path.join(runs, 'proofhalf-20261010-000000-0006')
  fs.mkdirSync(path.join(half, 'data'), { recursive: true })
  fs.writeFileSync(path.join(half, 'data', '.orgtree-rig-root'), '{}')
  const down = spawnSync(process.execPath, [path.join(RIG_DIR, 'rig.mjs'), 'down', '--run', path.basename(half)], { encoding: 'utf8', windowsHide: true, timeout: 120000 })
  console.log(JSON.stringify({
    home: rigHome(), stopped: wouldStop(stopped), expired: wouldStop(expired), fresh: wouldStop(fresh),
    picked: same(pickedDir, mine) ? 'mine' : pickedDir.startsWith('error') ? pickedDir : path.basename(pickedDir),
    othersOnly, othersOnlyPicked: othersOnlyPicked && path.basename(othersOnlyPicked),
    halfGone: !fs.existsSync(half), down: (down.stderr || down.stdout || '').trim().slice(-300),
  }))
}
