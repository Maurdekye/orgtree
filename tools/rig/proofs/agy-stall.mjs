// Proof: Antigravity hung tool calls & false REPORT STALLED fixes
// (docket antigravity-agents-hung-tool-calls-stall-turns-f).
//   hang1:  hangs inside native read_file -> stopped gracefully-first after the
//           shortened rig ceiling (4 s) with a durable forced-kill record,
//           auto-resumed once with a prompt naming read_file, and recovers.
//   hang2:  hangs inside write_file on turn 1 AND again on the auto-resumed
//           turn 2 -> stops after 2 turns, no third attempt, boss receives
//           runtime.report_stalled with door "stuck in tool write_file since …".
//   cmdok:  runs run_command for 6.5 s (> 4 s file-tool ceiling) -> NOT cut off
//           (run_command keeps the normal turn idle limit).
//   soft1:  orgtree_status(done) + final text + trailing wsasend transport error
//           -> soft end-of-turn (no error, no REPORT STALLED, no P34 retry,
//           errored agy process closed so next turn starts fresh).
//   soft2:  orgtree_status(done) + final text + trailing INVALID_ARGUMENT (400)
//           -> soft end-of-turn (no error, no REPORT STALLED).
//   midnet: mid-work Go DNS error ("dial tcp: ... no such host") without done
//           -> P34 connection freeze & retry (not terminal REPORT STALLED).
//   mid400: mid-work INVALID_ARGUMENT (code 400) after status=working
//           -> terminal REPORT STALLED with door naming "last status: working at …".
//   notext: orgtree_status(done) followed by another tool with NO final text,
//           then INVALID_ARGUMENT (code 400) -> NOT soft-ended; terminal
//           REPORT STALLED with door naming "last status: done at …".
//   parwork: parallel orgtree_work update + evidence on the same item completes
//           cleanly without deadlocking.
// Run: node tools/rig/rig.mjs run tools/rig/proofs/agy-stall.mjs

import fs from 'node:fs'
import path from 'node:path'

import { SEED_SETTLE_TIMEOUT } from '../seed-settle.mjs'
import { Proof } from '../proof.mjs'

const AGENTS = ['hang1', 'hang2', 'hangmcp', 'cmdok', 'soft1', 'soft2', 'midnet', 'mid400', 'notext']

export async function setup() {
  return { agyToolCeilingS: 4 }
}

export default async function (rig) {
  const p = new Proof('agy-stall')
  rig.scenario({
    agents: {
      hang1: {
        turns: [
          {
            name: 'resume-recover',
            match: 'read_file',
            once: true,
            steps: [
              { tool: 'orgtree_status', args: { status: 'done', summary: 'Recovered after hung read_file.' } },
              { text: 'Recovered cleanly after read_file hang.' },
            ],
          },
          {
            name: 'hang-once',
            match: 'PROOF-HANG-RECOVER',
            once: true,
            steps: [
              { text: 'Reading breadcrumbs.' },
              { tool: 'read_file', args: { Path: 'breadcrumbs.md' }, hang: true },
            ],
          },
        ],
      },
      hang2: {
        turns: [
          {
            name: 'hang-again',
            match: 'write_file',
            once: true,
            steps: [
              { text: 'Retrying write_file.' },
              { tool: 'write_file', args: { Path: 'breadcrumbs.md', Content: 'retry' }, hang: true },
            ],
          },
          {
            name: 'hang-first',
            match: 'PROOF-HANG-REPEAT',
            once: true,
            steps: [
              { text: 'Writing breadcrumbs.' },
              { tool: 'write_file', args: { Path: 'breadcrumbs.md', Content: 'first' }, hang: true },
            ],
          },
        ],
      },
      hangmcp: {
        turns: [
          {
            name: 'resume-mcp',
            match: 'orgtree_work',
            once: true,
            steps: [
              { tool: 'orgtree_status', args: { status: 'done', summary: 'Recovered after hung orgtree_work.' } },
              { text: 'Recovered cleanly after solo orgtree_work evidence hang.' },
            ],
          },
          {
            name: 'hang-solo-evidence',
            match: 'PROOF-HANG-MCP',
            once: true,
            steps: [
              { text: 'Recording solo evidence.' },
              { tool: 'orgtree_work', args: { action: 'evidence', slug: 'demo', kind: 'note', note: 'solo' }, hang: true },
            ],
          },
        ],
      },
      cmdok: {
        turns: [
          {
            name: 'long-cmd',
            match: 'PROOF-RUN-CMD',
            once: true,
            steps: [
              { tool: 'run_command', args: { CommandLine: 'cargo build' }, run_ms: 6500, result: 'compiled ok' },
              { text: 'Build finished.' },
            ],
          },
        ],
      },
      soft1: {
        turns: [
          {
            name: 'soft-followup',
            match: 'PROOF-SOFT-FOLLOWUP',
            once: true,
            steps: [{ text: 'Fresh CLI resumed cleanly.' }],
          },
          {
            name: 'soft-net',
            match: 'PROOF-SOFT-NET',
            once: true,
            steps: [
              { tool: 'orgtree_status', args: { status: 'done', summary: 'Finished before wsasend.' } },
              { text: 'Work finished cleanly.' },
              { error: 'wsasend: An existing connection was forcibly closed by the remote host.' },
            ],
          },
        ],
      },
      soft2: {
        turns: [
          {
            name: 'soft-400',
            match: 'PROOF-SOFT-400',
            once: true,
            steps: [
              { tool: 'orgtree_status', args: { status: 'done', summary: 'Finished before trailing 400.' } },
              { text: 'All work delivered.' },
              { error: 'API error: INVALID_ARGUMENT (code 400): trailing call rejected' },
            ],
          },
        ],
      },
      midnet: {
        turns: [
          {
            name: 'mid-net-retry',
            match: 'being retried',
            once: true,
            steps: [{ text: 'Recovered after P34 retry.' }],
          },
          {
            name: 'mid-net-fail',
            match: 'PROOF-MID-NET',
            once: true,
            steps: [
              { text: 'Checking remote endpoint.' },
              { error: 'Post "https://daily-cloudcode-pa.googleapis.com": dial tcp: lookup daily-cloudcode-pa.googleapis.com: no such host' },
            ],
          },
        ],
      },
      mid400: {
        turns: [
          {
            name: 'mid-400',
            match: 'PROOF-MID-400',
            once: true,
            steps: [
              { tool: 'orgtree_status', args: { status: 'working', summary: 'Working on task.' } },
              { text: 'Halfway through.' },
              { error: 'API error: INVALID_ARGUMENT (code 400): invalid tool schema' },
            ],
          },
        ],
      },
      notext: {
        turns: [
          {
            name: 'no-final-text',
            match: 'PROOF-NO-TEXT',
            once: true,
            steps: [
              { tool: 'orgtree_status', args: { status: 'done', summary: 'Marked done before extra tool.' } },
              { tool: 'orgtree_chart', args: {} },
              { error: 'API error: INVALID_ARGUMENT (code 400): failed after extra tool' },
            ],
          },
        ],
      },
    },
    default: { turns: [{ name: 'default', steps: [{ text: 'OK.' }] }] },
  })

  await rig.waitFor(() => rig.sql(`SELECT 1 FROM ot.turns WHERE ended_at IS NULL`).length === 0,
    { what: 'seed turns to settle', timeout: SEED_SETTLE_TIMEOUT })

  for (const name of AGENTS) {
    await rig.op({ op: 'hire', name, parent: 'boss', tier: 'flash', title: 'Antigravity stall proof agent' })
  }
  const ids = Object.fromEntries(AGENTS.map(a => [a, rig.agentRow(a)?.id]))
  p.check('all 9 Antigravity proof agents hired', AGENTS.every(a => ids[a]), ids)

  const log = (agent, kind) => rig.fakeLog(agent).filter(l => !kind || l.kind === kind)
  const stalledFor = name => rig.sql(
    `SELECT id, body, ev FROM ot.mail WHERE recipient_name = 'boss' AND ev->>'variant' = 'runtime.report_stalled' AND ev->>'report' = '${name}' ORDER BY id`
  )
  const killLogText = () => {
    const f = path.join(rig.data, 'diagnostics', 'logs', 'codex-kills.log')
    return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : ''
  }

  // Launch fast cases in parallel to keep total rig time short
  await Promise.all([
    rig.userMail('hang1', 'PROOF-HANG-RECOVER: read breadcrumbs.'),
    rig.userMail('hang2', 'PROOF-HANG-REPEAT: write breadcrumbs.'),
    rig.userMail('hangmcp', 'PROOF-HANG-MCP: record solo evidence.'),
    rig.userMail('cmdok', 'PROOF-RUN-CMD: build project.'),
    rig.userMail('soft1', 'PROOF-SOFT-NET: finish and report.'),
    rig.userMail('soft2', 'PROOF-SOFT-400: finish and report.'),
    rig.userMail('midnet', 'PROOF-MID-NET: inspect remote.'),
    rig.userMail('mid400', 'PROOF-MID-400: do work.'),
    rig.userMail('notext', 'PROOF-NO-TEXT: check chart after done.'),
  ])

  // ---------------------------------------------------------------- (a3) cmdok: run_command keeps turn idle limit
  const [c1] = await rig.waitTurns('cmdok', 1, { timeout: 30000 })
  p.check('cmdok: run_command > 4 s file-tool ceiling completes cleanly without being stopped', !c1.error && !c1.killed, c1)

  // ---------------------------------------------------------------- (b1) soft1: post-final wsasend -> soft end-of-turn
  const [s1] = await rig.waitTurns('soft1', 1, { timeout: 30000 })
  const soft1Row = rig.agentRow('soft1')
  const soft1Stalls = stalledFor('soft1')
  p.check('soft1: trailing wsasend after done + final text ends softly (no error, no freeze, no REPORT STALLED)',
    !s1.error && !s1.killed && !soft1Row.last_error && !soft1Row.frozen && soft1Stalls.length === 0,
    { turn: s1, last_error: soft1Row.last_error, frozen: soft1Row.frozen, stalls: soft1Stalls })
  await rig.userMail('soft1', 'PROOF-SOFT-FOLLOWUP: confirm fresh process.')
  const s1Turns = await rig.waitTurns('soft1', 2, { timeout: 30000 })
  const s1Starts = log('soft1', 'start')
  p.check('soft1: errored agy process closed cleanly and next turn resumed fresh',
    !s1Turns[1].error && s1Starts.length >= 2 && s1Starts.at(-1).resumed === true,
    { turns: s1Turns, starts: s1Starts.map(x => ({ pid: x.pid, resumed: x.resumed })) })

  // ---------------------------------------------------------------- (b2) soft2: post-final INVALID_ARGUMENT (400) -> soft end-of-turn
  const [s2] = await rig.waitTurns('soft2', 1, { timeout: 30000 })
  const soft2Row = rig.agentRow('soft2')
  const soft2Stalls = stalledFor('soft2')
  p.check('soft2: trailing INVALID_ARGUMENT (400) after done + final text ends softly (no REPORT STALLED)',
    !s2.error && !s2.killed && !soft2Row.last_error && !soft2Row.frozen && soft2Stalls.length === 0,
    { turn: s2, last_error: soft2Row.last_error, frozen: soft2Row.frozen, stalls: soft2Stalls })

  // ---------------------------------------------------------------- (c2) mid400: mid-work 400 -> terminal REPORT STALLED
  const [m400] = await rig.waitTurns('mid400', 1, { timeout: 30000 })
  const m400Stalls = await rig.waitFor(() => stalledFor('mid400'), { what: 'mid400 REPORT STALLED', timeout: 15000 }).catch(() => [])
  const m400Door = m400Stalls[0]?.ev?.door ?? ''
  p.check('mid400: mid-work INVALID_ARGUMENT (400) reports terminal REPORT STALLED with last status working',
    !!m400.error && !rig.agentRow('mid400').frozen && m400Stalls.length === 1 && /last status: working at /i.test(m400Door),
    { error: m400.error, frozen: rig.agentRow('mid400').frozen, door: m400Door, stalls: m400Stalls.length })

  // ---------------------------------------------------------------- (c3) notext: done + extra tool + no final text + 400 -> terminal REPORT STALLED
  const [nt1] = await rig.waitTurns('notext', 1, { timeout: 30000 })
  const ntStalls = await rig.waitFor(() => stalledFor('notext'), { what: 'notext REPORT STALLED', timeout: 15000 }).catch(() => [])
  const ntDoor = ntStalls[0]?.ev?.door ?? ''
  p.check('notext: error after done + subsequent tool without final text is NOT soft-ended and names last status done',
    !!nt1.error && ntStalls.length === 1 && /last status: done at /i.test(ntDoor),
    { error: nt1.error, door: ntDoor, stalls: ntStalls.length })

  // ---------------------------------------------------------------- (a1) hang1: hung read_file -> graceful stop + kill log + auto-resume -> recovers
  const h1Turns = await rig.waitTurns('hang1', 2, { timeout: 45000 }).catch(() => rig.turns('hang1'))
  const h1Prompt2 = log('hang1', 'turn')[1]?.prompt ?? ''
  const h1Kills = killLogText()
  p.check('hang1: hung read_file stopped at ceiling, recorded durable forced kill, auto-resumed naming read_file, and recovered',
    h1Turns.length === 2
      && h1Turns[0].killed === true
      && /stuck in tool read_file since /i.test(h1Turns[0].error ?? '')
      && !h1Turns[1].error
      && /read_file/.test(h1Prompt2) && /hung/i.test(h1Prompt2)
      && stalledFor('hang1').length === 0
      && new RegExp(`codex-force-kill.*agent hang1.*graceful_tried=true`).test(h1Kills),
    { turns: h1Turns, prompt2: h1Prompt2.slice(0, 240), stalls: stalledFor('hang1').length, killsMatch: /codex-force-kill.*hang1/.test(h1Kills) })

  // ---------------------------------------------------------------- (a2) hang2: repeated write_file hang -> stops after 2 turns, reports to boss, NO 3rd attempt
  const h2Turns = await rig.waitTurns('hang2', 2, { timeout: 60000 }).catch(() => rig.turns('hang2'))
  const h2Stalls = await rig.waitFor(() => stalledFor('hang2'), { what: 'hang2 REPORT STALLED after repeat hang', timeout: 20000 }).catch(() => [])
  await new Promise(r => setTimeout(r, 4000))
  const h2After = rig.turns('hang2')
  const h2Door = h2Stalls[0]?.ev?.door ?? ''
  p.check('hang2: repeated write_file hang stops after 2nd attempt (no 3rd turn) and reports stuck in tool write_file since T',
    h2Turns.length === 2
      && h2After.length === 2
      && h2Stalls.length === 1
      && /stuck in tool write_file since /i.test(h2Door)
      && /codex-force-kill.*agent hang2.*graceful_tried=true/.test(killLogText()),
    { turns: h2After, door: h2Door, stalls: h2Stalls.length })

  // ---------------------------------------------------------------- (a2b) hangmcp: solo hung orgtree_work evidence -> ceiling + auto-resume -> recovers
  const hmTurns = await rig.waitTurns('hangmcp', 2, { timeout: 45000 }).catch(() => rig.turns('hangmcp'))
  const hmPrompt2 = log('hangmcp', 'turn')[1]?.prompt ?? ''
  p.check('hangmcp: solo hung orgtree_work evidence stopped at ceiling, auto-resumed naming orgtree_work, and recovered',
    hmTurns.length === 2
      && hmTurns[0].killed === true
      && /stuck in tool orgtree_work since /i.test(hmTurns[0].error ?? '')
      && !hmTurns[1].error
      && /orgtree_work/.test(hmPrompt2) && /hung/i.test(hmPrompt2)
      && stalledFor('hangmcp').length === 0
      && /codex-force-kill.*agent hangmcp.*graceful_tried=true/.test(killLogText()),
    { turns: hmTurns, prompt2: hmPrompt2.slice(0, 240), stalls: stalledFor('hangmcp').length })

  // ---------------------------------------------------------------- (c1) midnet: Go DNS error mid-work -> P34 connection freeze & retry
  const midFrozen = await rig.waitFor(() => {
    const row = rig.agentRow('midnet')
    if (row?.frozen?.connection) return row.frozen
    const ts = rig.turns('midnet')
    if (ts.length >= 2 && ts[1].ended_at) return { retried_already: true }
    return null
  }, { what: 'midnet P34 connection freeze or retry', timeout: 25000 }).catch(() => null)
  const midTurns = await rig.waitFor(() => {
    const ts = rig.turns('midnet')
    return ts.length >= 2 && ts.every(x => x.ended_at) ? ts : null
  }, { what: 'midnet P34 retry turn to finish', timeout: 70000, every: 1000 }).catch(() => rig.turns('midnet'))
  p.check('midnet: mid-work Go DNS error triggers P34 connection freeze and recovers on retry (no terminal REPORT STALLED)',
    !!midFrozen && midTurns.length >= 2 && !midTurns[1].error && stalledFor('midnet').length === 0,
    { frozen: midFrozen, turns: midTurns, stalls: stalledFor('midnet').length })

  // ---------------------------------------------------------------- (d) parallel orgtree_work update + evidence on same item
  const created = await rig.tool('boss', 'orgtree_work', {
    action: 'create',
    title: 'Parallel update and evidence concurrency check',
    kind: 'code',
    objective: 'Verify concurrent update and evidence mutations serialize cleanly without deadlock.',
  })
  const slug = /@item:[^/\s]+\/([a-z0-9-]+)/i.exec(created?.text ?? '')?.[1] ?? rig.one(`SELECT slug FROM ot.work_items ORDER BY id DESC LIMIT 1`)?.slug
  let parOk = !!slug
  const parErrors = []
  if (slug) {
    for (let i = 1; i <= 5; i++) {
      const [u, e] = await Promise.all([
        rig.tool('boss', 'orgtree_work', { action: 'update', slug, working_on_next: [`step ${i}`] }),
        rig.tool('boss', 'orgtree_work', { action: 'evidence', slug, kind: 'note', note: `parallel round ${i}` }),
      ])
      if (!u.ok || !e.ok) {
        parOk = false
        parErrors.push({ round: i, u, e })
      }
    }
  }
  p.check('parwork: 5 rounds of parallel orgtree_work update + evidence on the same item succeed without deadlock',
    parOk, { slug, parErrors })

  p.keep(rig, { agents: AGENTS, grep: /agy|Agy|stuck in tool|soft end-of-turn|codex-force-kill|report_stalled/ })
  return p.summary()
}
