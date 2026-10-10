// Measurement: how the engine stops its PostgreSQL on a busy disk under each
// caller's budget, and what the next start costs (docket
// the-engine-stops-postgresql-cleanly-on-a-busy-di).
//   A run with fsync on (rig clusters run without it otherwise). Before each
//   stop the cluster gets --mb MB of fresh dirty data, and while the stop runs
//   a writer fsyncs a file on the rig drive (a busy disk; --calm leaves it
//   out). The keeper plays the caller: it kills the engine tree that many
//   seconds after asking it to stop (run.json stopKillMs):
//     8 s   desktop Quit, an engine the desktop started (3 s request + 5 s)
//     12 s  desktop Quit, an attached engine (4 s request + 8 s release wait)
//     15 s  background host (5 s request + 10 s)
//     45 s  installer upgrade (it never kills: past 45 s it offers Retry/Cancel)
//     300 s no caller kill
//   Each stop records when the database was down (postgres.log "database
//   system is shut down"), whether the engine tree was killed first, the
//   checkpoint lines, and the next start's time and whether it had to recover.
// Run: node tools/rig/rig.mjs run tools/rig/proofs/pg-stop.mjs [--mb 64] [--budgets 8,12,15,45,300] [--calm]
//      ORGTREE_RIG_ENGINE=<exe> measures another engine (the one before the change)

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import { writeRun } from '../lib.mjs'
import { Proof } from '../proof.mjs'

export async function setup(flags = {}) {
  // --agents: the basic fixture, with carol mid-turn at every stop
  return { fsync: true, ...(flags.agents ? {} : { fixture: 'none' }) }
}

/** keeper.log lines with their time. */
const keeperLines = lines => lines.map(l => {
  const m = l.match(/^(\d{4}-\d{2}-\d{2}T[\d:.]+Z) (.*)$/)
  return m ? { at: Date.parse(m[1]), text: m[2] } : null
}).filter(Boolean)
const secs = (a, b) => (a != null && b != null ? Number(((a - b) / 1000).toFixed(1)) : null)

/** The lines a log gained after byte `from`. */
function linesAfter(file, from) {
  try {
    const fd = fs.openSync(file, 'r')
    try {
      const size = fs.fstatSync(fd).size
      const buf = Buffer.alloc(Math.max(0, size - from))
      fs.readSync(fd, buf, 0, buf.length, from)
      return buf.toString('utf8').split(/\r?\n/).filter(Boolean)
    } finally { fs.closeSync(fd) }
  } catch { return [] }
}
const sizeOf = f => { try { return fs.statSync(f).size } catch { return 0 } }

/** postgres.log lines with their time (local time, as PostgreSQL writes it). */
function pgLines(lines) {
  return lines.map(l => {
    const m = l.match(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}\.\d{3}) \S+ \[\d+\] (\w+):\s+(.*)$/)
    return m ? { at: new Date(`${m[1]}T${m[2]}`).getTime(), level: m[3], text: m[4] } : null
  }).filter(Boolean)
}

/** A writer that keeps the rig drive busy: 1 MB writes, each fsynced. */
function busyDisk(dir) {
  const file = path.join(dir, 'busy-disk.bin'), count = path.join(dir, 'busy-disk.count')
  const code = `const fs=require('fs');const b=Buffer.alloc(1<<20,7);const fd=fs.openSync(process.argv[1],'w');let n=0;`
    + `for(;;){fs.writeSync(fd,b);fs.fsyncSync(fd);n++;if(n%32===0){fs.ftruncateSync(fd,0);fs.writeFileSync(process.argv[2],String(n))}}`
  const child = spawn(process.execPath, ['-e', code, file, count], { stdio: 'ignore', windowsHide: true })
  const started = Date.now()
  return {
    stop() {
      try { child.kill() } catch { /* gone */ }
      const n = Number((() => { try { return fs.readFileSync(count, 'utf8') } catch { return '0' } })())
      const s = (Date.now() - started) / 1000
      return { mb: n, seconds: Number(s.toFixed(1)), mb_per_s: Number((n / Math.max(s, 0.1)).toFixed(1)) }
    },
  }
}

/** --mb MB of fresh dirty data in the run's cluster (a table in its own database). */
function dirty(rig, mb) {
  const total = Math.max(1, Math.round(mb))
  rig.exec('TRUNCATE dirty', { db: 'rig_dirty' })
  // 1000 rows of ~930 bytes (8 to a page) are ~1 MB; up to 16 MB a statement
  for (let left = total; left > 0; left -= 16) {
    rig.exec(`INSERT INTO dirty SELECT g, repeat(md5(g::text), 28) FROM generate_series(1, ${Math.min(16, left) * 1000}) g`, { db: 'rig_dirty' })
  }
  return total
}

export default async function (rig, { flags = {} } = {}) {
  const p = new Proof('pg-stop')
  const mb = Number(flags.mb) || 64
  const budgets = String(flags.budgets || '8,12,15,45,300').split(',').map(Number).filter(n => n > 0)
  const calm = !!flags.calm
  const pgLog = path.join(rig.dir, 'data', 'pg', 'cluster', 'log', 'postgres.log')
  const keeperLog = path.join(rig.dir, 'keeper.log')

  const agents = !!flags.agents
  p.note('setup', { engine: rig.run.engineSource, fsync: rig.one(`SELECT current_setting('fsync') AS v`)?.v,
    checkpoint_timeout: rig.one(`SELECT current_setting('checkpoint_timeout') AS v`)?.v, mb, budgets, busy_disk: !calm, agent_mid_turn: agents })
  rig.exec('CREATE DATABASE rig_dirty', { db: 'postgres' })
  rig.exec('CREATE TABLE dirty (id int, pad text)', { db: 'rig_dirty' })
  // --agents: carol is mid-turn (her CLI silent until interrupted) when the stop comes
  if (agents) rig.scenario({ default: { turns: [{ match: ['PGSTOP-HANG'], steps: [{ text: 'On it.' }, { hang: true }] }] } })

  const rows = []
  for (const budget of budgets) {
    if (agents) {
      await rig.userMail('carol', `PGSTOP-HANG before the ${budget} s stop`)
      await rig.waitFor(() => rig.sql(`SELECT 1 FROM ot.turns t JOIN ot.agents a ON a.id = t.agent_id
                                         WHERE a.name = 'carol' AND t.ended_at IS NULL`).length > 0, { what: 'carol mid-turn', timeout: 90000 })
    }
    const written = dirty(rig, mb)
    const pgFrom = sizeOf(pgLog), keeperFrom = sizeOf(keeperLog)
    writeRun(rig.dir, { stopKillMs: budget * 1000 })
    const load = calm ? null : busyDisk(rig.dir)
    await rig.down({ keep: true, timeout: budget * 1000 + 180000 })
    const exited = Date.now()
    const disk = load?.stop() ?? null
    const pgStop = pgLines(linesAfter(pgLog, pgFrom))
    const kept = keeperLines(linesAfter(keeperLog, keeperFrom))
    const at = re => kept.find(l => re.test(l.text))?.at ?? null
    // the caller's clock starts when the keeper asks the engine to stop
    const asked = at(/^stopping: /) ?? exited
    const down = pgStop.find(l => /database system is shut down/.test(l.text))
    const killedAt = at(/did not stop in \d+ ms; killing/)
    const engineLines = kept.filter(l => /checkpoint before the database stop|database stopped|database did not stop in time/.test(l.text))
      .map(l => `${secs(l.at, asked)}s ${l.text.replace(/^.*?engine stderr:\s*\w+\s+\[[^\]]*\]\s*/, '').slice(0, 200)}`)
    // the next start
    const startFrom = sizeOf(pgLog)
    const t0 = Date.now()
    let startError = null
    try { await rig.restart({ timeout: 900000 }) } catch (e) { startError = e.message.slice(0, 300) }
    const startS = (Date.now() - t0) / 1000
    const pgStart = pgLines(linesAfter(pgLog, startFrom))
    const clean = pgStart.some(l => /database system was shut down at/.test(l.text))
    const recovered = pgStart.some(l => /was interrupted|not properly shut down|automatic recovery|redo starts/.test(l.text))
    const syncing = pgStart.filter(l => /syncing data directory/.test(l.text)).map(l => l.text).at(-1) ?? null
    const row = {
      budget_s: budget,
      dirty_mb: written,
      // the engine's own stop work (HTTP drain, agents, hub), then the database's
      engine_work_s: secs(at(/engine stopping/), asked) == null ? null : secs(at(/progress engine-stop-database/), at(/engine stopping/)),
      db_stop_from_s: secs(at(/progress engine-stop-database/), asked),
      db_down_s: down ? secs(down.at, asked) : null,
      engine_exit_s: secs(exited, asked),
      killed_at_s: secs(killedAt, asked),
      killed_by_caller: killedAt != null,
      clean_shutdown: !!down && (killedAt == null || down.at <= killedAt),
      checkpoints: pgStop.filter(l => /checkpoint (starting|complete)/.test(l.text)).map(l => `${secs(l.at, asked)}s ${l.text.slice(0, 150)}`),
      engine: engineLines,
      busy_disk: disk,
      next_start_s: Number(startS.toFixed(1)),
      next_start_clean: clean && !recovered,
      next_start_recovered: recovered,
      next_start_sync: syncing,
      next_start_error: startError,
    }
    rows.push(row)
    p.note(`stop under a ${budget} s budget`, row)
    if (startError) break
  }
  p.file('stops.json', rows)
  // what the measurement is for: a stop that ends clean inside the caller's budget, and a fast next start
  for (const r of rows) {
    p.check(`under a ${r.budget_s} s budget the database shuts down clean (${r.dirty_mb} MB dirty${calm ? '' : ', busy disk'})`, r.clean_shutdown,
      { db_down_s: r.db_down_s, engine_exit_s: r.engine_exit_s, killed: r.killed_by_caller, next_start_s: r.next_start_s, next_start_clean: r.next_start_clean })
  }
  return p.summary()
}
