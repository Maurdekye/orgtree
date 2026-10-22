// Control for docket many-orgtree-retire-calls-at-once-hang-22-parall (2026-10-22).
//
// The live hang was not the engine's: Claude Code queued the coordinator's 22
// orgtree_retire calls behind a foreground subagent in the same reply, and none
// reached the engine (live log, read-only). Claude Code never sends such calls at
// once, so this control sends 22 truly concurrent orgtree_retire calls straight to
// the engine, as one parent, through the agent tool path the coordinator's MCP calls
// take (call_tool, by the test-only /api/rig/tool), and records what the engine does:
//
//   - every call answers, none fails, and the whole batch ends in seconds;
//   - the engine really ran them side by side (overlapping domain.ops.retire spans),
//     and each worker's retire committed;
//   - every worker is archived, and the parent's held credits drop by exactly what
//     the replies say they freed (no update lost between concurrent retires);
//   - each worker's warm (fake) CLI exits;
//   - concurrent topology writes conflict (they run SERIALIZABLE), and every conflict
//     is tried again: none runs out of tries.
//
// At 01a0fa5 (three tries at a fixed 20/40/60 ms) 7 of the 22 failed with
// "could not serialize access due to read/write dependencies among transactions".
//
// Fake CLIs only, warming on (`warming`: a safe start warms nothing). Run:
//   node tools/rig/rig.mjs run tools/rig/proofs/retire-concurrent.mjs
import { Proof } from '../proof.mjs'
import { alive } from '../lib.mjs'

const N = 22
const WORKERS = Array.from({ length: N }, (_, i) => `w${String(i + 1).padStart(2, '0')}`)
// the harness's own launch line, as warm-placement.mjs reads it
const LAUNCH = / runtime\.(?:claude|agy|codex|muse|opencode|acp): CLI started agent=\d+ pid=([1-9]\d*) /
const STAMP = /^\S+ +\[(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d{3})\d*\]/
// PostgreSQL's own wording, never a bare SQLSTATE: log text is full of digits
const CONFLICT = /deadlock detected|could not serialize access/
// a try the engine gave another go (its retry line, before and after the shared helper)
const RETRIED = /(?:op|write) conflicted with another(?: write)?; retrying/
const RAN_OUT = /write kept conflicting with others; refused/

export async function setup() {
  return {
    name: 'retire-concurrent', warming: true, fixture: {
      org: { name: 'Retire concurrent' },
      agents: [
        { name: 'boss', tier: 'opus', grant: 200, title: 'Rig lead', charter: 'You lead the rig org. You exist only in test runs.' },
        // Claude and Codex fakes alike, as the live team was
        ...WORKERS.map((name, i) => ({ name, parent: 'boss', tier: i % 2 ? 'sol' : 'haiku', grant: i % 3 === 0 ? 1 : 0 })),
      ],
      scenario: { default: { turns: [{ name: 'default', steps: [{ text: 'OK.' }] }] } },
    },
  }
}

const ms = stamp => Date.parse(stamp.replace(' ', 'T'))

export default async function (rig) {
  const p = new Proof('retire-concurrent')
  await rig.waitFor(() => rig.sql('SELECT 1 FROM ot.turns WHERE ended_at IS NULL').length === 0,
    { what: 'seed turns settle', timeout: 60000 })
  // a restart warms the workers' CLIs, as the live team's were warm
  const fromRestart = rig.engineLog().length
  await rig.restart()
  const warmed = await rig.waitFor(() => {
    const m = /runtime: warming done warmed=(\d+) candidates=(\d+)/.exec(rig.engineLog().slice(fromRestart))
    return m ? { warmed: Number(m[1]), candidates: Number(m[2]) } : null
  }, { what: 'warming done after the restart', timeout: 180000 })
  const afterWarm = rig.engineLog().slice(fromRestart).split(/\r?\n/)
  const pids = Object.fromEntries(WORKERS.map(name => [name, afterWarm
    .filter(l => l.includes(`/${name} `) && LAUNCH.test(l)).map(l => Number(l.match(LAUNCH)[1])).filter(alive)]))
  const warmWorkers = WORKERS.filter(n => pids[n].length > 0)
  p.note('warming', { ...warmed, warm_workers: warmWorkers.length })
  p.check('at least 20 workers hold a warm CLI before the retires', warmWorkers.length >= 20, { warm: warmWorkers.length })

  const orgId = rig.one(`SELECT id FROM ot.orgs WHERE slug='${rig.org}'`).id
  const bossId = rig.one(`SELECT id FROM ot.agents WHERE org_id=${orgId} AND name='boss'`).id
  const held = () => Number(rig.one(`SELECT coalesce(sum(seat + grant_credits), 0) AS h FROM ot.agents
    WHERE parent_id=${bossId} AND state='live'`).h)
  const credits = async () => (await rig.tool('boss', 'orgtree_chart', {})).text.match(/Credits: [^\n]*/)?.[0] ?? null
  const heldBefore = held()
  const creditsBefore = await credits()
  p.check('all workers are live reports of boss', rig.sql(`SELECT 1 FROM ot.agents WHERE parent_id=${bossId} AND state='live'`).length === N)

  // ---- the control: 22 retires at once
  const fromFire = rig.engineLog().length
  const t0 = performance.now()
  const results = await Promise.all(WORKERS.map(async node => {
    const s = performance.now()
    const r = await rig.tool('boss', 'orgtree_retire', { node }).catch(e => ({ ok: false, text: e.message }))
    return { node, ok: !!r.ok, ms: Math.round(performance.now() - s), freed: r.json?.freed ?? null, text: (r.text ?? '').slice(0, 200) }
  }))
  const wall = Math.round(performance.now() - t0)
  const slow = [...results].sort((a, b) => b.ms - a.ms)
  p.note('batch', { wall_ms: wall, slowest_ms: slow[0].ms, fastest_ms: slow.at(-1).ms })
  p.check('every one of the 22 concurrent retires answered ok', results.every(r => r.ok), results.filter(r => !r.ok))
  p.check('the whole concurrent batch ended within 10 s', wall < 10000, { wall_ms: wall })

  const archived = rig.sql(`SELECT name FROM ot.agents WHERE org_id=${orgId} AND name LIKE 'w%' AND state='archived'`).length
  p.check('all 22 workers are archived', archived === N, { archived })
  const freed = results.reduce((sum, r) => sum + (Number(r.freed) || 0), 0)
  const heldAfter = held()
  const creditsAfter = await credits()
  p.note('credits', { held_before: heldBefore, held_after: heldAfter, freed_sum: freed, chart_before: creditsBefore, chart_after: creditsAfter })
  p.check('boss holds nothing for its retired reports, and the replies freed exactly what it held', heldAfter === 0 && freed === heldBefore,
    { heldBefore, heldAfter, freed })

  // the engine's own account: overlapping retires (every try: a conflicted one ends
  // in "!!", or later at its commit), their durations, and what came of the conflicts
  const lines = rig.engineLog().slice(fromFire).split(/\r?\n/)
  const events = []
  const committed = new Set()
  for (const l of lines) {
    const at = l.match(STAMP)?.[1]
    if (!at) continue
    if (/ domain\.ops\.retire\(actor=/.test(l)) events.push({ t: ms(at), d: +1 })
    const end = l.match(/ domain\.ops\.retire\(\.\.\.\) \[([\d.]+) ms\] (->|!!)/)
    if (end) events.push({ t: ms(at), d: -1, ms: Number(end[1]), ok: end[2] === '->' })
    const node = l.match(/ domain\.ops\.retire\(\.\.\.\) \[[\d.]+ ms\] -> Ok\(\{"node":"(w\d\d)"/)?.[1]
    if (node) committed.add(node)
  }
  events.sort((a, b) => a.t - b.t || b.d - a.d)
  let open = 0, overlap = 0
  for (const e of events) { open += e.d; overlap = Math.max(overlap, open) }
  const spans = events.filter(e => e.d < 0)
  const engineMs = spans.map(e => e.ms).sort((a, b) => a - b)
  const conflicts = lines.filter(l => CONFLICT.test(l) && / domain\.ops\.run_once\(\.\.\.\) /.test(l)).length
  const retried = lines.filter(l => RETRIED.test(l)).length
  const ranOut = lines.filter(l => RAN_OUT.test(l)).map(l => l.slice(0, 300))
  p.note('engine retires', { tries: spans.length, tries_ok: spans.filter(e => e.ok).length, max_overlap: overlap,
    conflicted_tries: conflicts, retried, engine_ms: { min: engineMs[0], median: engineMs[Math.floor(engineMs.length / 2)], max: engineMs.at(-1) } })
  p.check('every worker\'s retire ran to Ok in the engine', WORKERS.every(n => committed.has(n)), WORKERS.filter(n => !committed.has(n)))
  p.check('the engine ran retires side by side (overlapping spans)', overlap >= 2, { max_overlap: overlap })
  p.check('every conflicted try was tried again, and none ran out of tries', ranOut.length === 0 && retried >= conflicts,
    { conflicts, retried, ran_out: ranOut.slice(0, 5) })

  // each worker's warm CLI goes with its seat
  const lingering = await rig.waitFor(() => {
    const left = warmWorkers.flatMap(n => pids[n].filter(alive).map(pid => `${n}:${pid}`))
    return left.length === 0 ? [] : null
  }, { what: 'the workers\' CLIs to exit', timeout: 30000 }).catch(() => warmWorkers.flatMap(n => pids[n].filter(alive).map(pid => `${n}:${pid}`)))
  p.check('every warm worker CLI exited after its retire', lingering.length === 0, lingering)

  p.file('retire-concurrent.json', { wall_ms: wall, results, warmed, warm_workers: warmWorkers.length, pids, overlap, engine_ms: engineMs,
    held_before: heldBefore, held_after: heldAfter, freed_sum: freed, chart_before: creditsBefore, chart_after: creditsAfter,
    conflicted_tries: conflicts, retried, ran_out: ranOut })
  p.keep(rig, { agents: ['boss'], grep: / domain\.ops\.retire\(| domain\.ops\.run_once\(|conflicted|conflicting|warming done|deadlock|could not serialize/ })
  return p.summary()
}
