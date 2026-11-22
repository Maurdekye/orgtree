// Proof: Antigravity hung tool calls & false REPORT STALLED fixes
// (docket antigravity-agents-hung-tool-calls-stall-turns-f).
//   hang1:    hangs inside native read_file -> stopped gracefully-first after the
//             shortened rig ceiling (4 s) with a durable forced-kill record,
//             auto-resumed once with a prompt naming read_file, and recovers.
//   hang2:    hangs inside write_file on turn 1 AND again on the auto-resumed
//             turn 2 -> stops after 2 turns, no third attempt, boss receives
//             runtime.report_stalled with door "stuck in tool write_file since …".
//   hangdiff: hangs inside read_file on turn 1, then hangs inside write_file on
//             the resumed turn 2 -> stops after exactly 2 turns (no 3rd turn
//             despite tool change), boss receives runtime.report_stalled naming
//             write_file, durable forced-kill records for both tools.
//   hangmcp:  solo hung orgtree_work evidence -> ceiling + auto-resume -> recovers.
//   cmdok:    runs run_command for 6.5 s (> 4 s file-tool ceiling) -> NOT cut off
//             (run_command keeps the normal turn idle limit).
//   soft1:    orgtree_status(done) + final text + trailing wsasend transport error
//             -> soft end-of-turn (no error, no REPORT STALLED, no P34 retry,
//             errored agy process closed so next turn starts fresh).
//   soft2:    orgtree_status(done) + final text + trailing INVALID_ARGUMENT (400)
//             -> soft end-of-turn (no error, no REPORT STALLED).
//   partial:  orgtree_status(done) + completed answer + unfinished ACTIVE second
//             answer + INVALID_ARGUMENT (400) -> NOT soft-ended; terminal error
//             and REPORT STALLED.
//   steered:  orgtree_status(done) + completed answer + delivered follow-up steer
//             + INVALID_ARGUMENT (400) -> NOT soft-ended; terminal error,
//             REPORT STALLED, and follow-up delivery custody preserved.
//   midnet:   mid-work Go DNS error ("dial tcp: ... no such host") without done
//             -> P34 connection freeze & retry (not terminal REPORT STALLED).
//   mid400:   mid-work INVALID_ARGUMENT (code 400) after status=working
//             -> terminal REPORT STALLED with door naming "last status: working at …".
//   notext:   orgtree_status(done) followed by another tool with NO final text,
//             then INVALID_ARGUMENT (code 400) -> NOT soft-ended; terminal
//             REPORT STALLED with door naming "last status: done at …".
//   clerr / cxerr: Claude (sonnet) and Codex (luna) receiving "The stream was
//             interrupted." -> NO connection freeze (net_fail_run=0); behaves
//             identically to base 6a9cf2d with terminal error & REPORT STALLED.
//   failrec / failwake: hung read_file with injected PG write failure on the
//             retry record or resume wake -> fails toward telling the boss
//             (REPORT STALLED sent, no silent stall suppression or extra retry).
//   slowmsg / msgbob: orgtree_message handler slower than the MCP timeout after
//             mail commit -> detached handler still wakes msgbob while slowmsg
//             receives the check-before-retry timeout error.
//   sparse:   progress event omitting tool_name after read_file preserves the
//             known tool name and 4 s ceiling (stopped & auto-resumed).
//   unnamed:  tool step omitting tool_name from the start records "an unnamed tool"
//             (never blank or "tool").
//   parwork:  parallel orgtree_work update + evidence on the same item completes
//             cleanly without deadlocking.
// Run: node tools/rig/rig.mjs run tools/rig/proofs/agy-stall.mjs

import fs from 'node:fs'
import path from 'node:path'

import { SEED_SETTLE_TIMEOUT } from '../seed-settle.mjs'
import { Proof } from '../proof.mjs'

const AGY_AGENTS = [
  'hang1', 'hang2', 'hangdiff', 'hangmcp', 'cmdok',
  'soft1', 'soft2', 'partial', 'steered',
  'midnet', 'mid400', 'notext',
  'failrec', 'failwake', 'sparse', 'unnamed',
]

export async function setup() {
  return {
    agyToolCeilingS: 4,
    agyMcpTimeoutMs: 1200,
    fixture: {
      org: { name: 'Antigravity stall proof' },
      agents: [
        { name: 'boss', tier: 'opus', grant: 60, title: 'Rig lead', charter: 'You lead the rig org. You exist only in test runs.' },
      ],
    },
  }
}

export default async function (rig) {
  const p = new Proof('agy-stall')
  const openSecondResponse = {
    event: 'step_update',
    step_update: {
      step_type: 'agent_response',
      state: 'ACTIVE',
      step_index: 18,
      text_delta: 'An unfinished second answer begins.',
    },
  }
  const toolStep = (step_index, state, extra = {}) => ({
    raw: {
      event: 'step_update',
      step_update: { step_index, step_type: 'tool', state, ...extra },
    },
  })
  const streamInterrupted = 'The stream was interrupted.'

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
      hangdiff: {
        turns: [
          {
            name: 'diff-third-forbidden',
            match: 'write_file',
            once: true,
            steps: [{ text: 'Third turn should never start.' }],
          },
          {
            name: 'diff-second-write',
            match: 'read_file',
            once: true,
            steps: [
              { text: 'Switching to write_file.' },
              { tool: 'write_file', args: { Path: 'out.txt', Content: 'second' }, hang: true },
            ],
          },
          {
            name: 'diff-first-read',
            match: 'PROOF-HANG-DIFF',
            once: true,
            steps: [
              { text: 'Reading before writing.' },
              { tool: 'read_file', args: { Path: 'in.txt' }, hang: true },
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
      partial: {
        turns: [
          {
            name: 'partial-second',
            match: 'PROOF-PARTIAL',
            once: true,
            steps: [
              { tool: 'orgtree_status', args: { status: 'done', summary: 'First answer done.' } },
              { text: 'First answer completed.' },
              { raw: openSecondResponse },
              { error: 'API error: INVALID_ARGUMENT (code 400): failed mid second answer' },
            ],
          },
        ],
      },
      steered: {
        turns: [
          {
            name: 'followup-delivered',
            match: 'PROOF-STEER',
            once: true,
            steps: [
              { tool: 'orgtree_status', args: { status: 'done', summary: 'First request done.' } },
              { text: 'First request completed.' },
              { poll_mail: { every_ms: 200, timeout_ms: 16000 } },
              { error: 'API error: INVALID_ARGUMENT (code 400): failed after follow-up delivered' },
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
      clerr: {
        turns: [
          {
            name: 'claude-stream-interrupted',
            match: 'PROOF-CROSS-LANE',
            once: true,
            steps: [{ result: { is_error: true, text: streamInterrupted } }],
          },
        ],
      },
      cxerr: {
        turns: [
          {
            name: 'codex-stream-interrupted',
            match: 'PROOF-CROSS-LANE',
            once: true,
            steps: [{ result: { status: 'failed', error: { message: streamInterrupted } } }],
          },
        ],
      },
      failrec: {
        turns: [
          {
            name: 'failrec-unexpected-resume',
            match: 'read_file',
            once: true,
            steps: [{ text: 'Should not auto-resume when retry record write failed.' }],
          },
          {
            name: 'failrec-hang',
            match: 'PROOF-FAIL-REC',
            once: true,
            steps: [
              { text: 'Hanging with broken retry record write.' },
              { tool: 'read_file', args: { Path: 'rec.txt' }, hang: true },
            ],
          },
        ],
      },
      failwake: {
        turns: [
          {
            name: 'failwake-hang',
            match: 'PROOF-FAIL-WAKE',
            once: true,
            steps: [
              { text: 'Hanging with broken wake write.' },
              { tool: 'read_file', args: { Path: 'wake.txt' }, hang: true },
            ],
          },
        ],
      },
      slowmsg: {
        turns: [
          {
            name: 'slow-orgtree-message',
            match: 'PROOF-SLOW-MSG',
            once: true,
            steps: [
              { tool: 'orgtree_message', args: { to: 'msgbob', body: 'SLOW-MAIL-WAKE' } },
              { text: 'Observed MCP timeout on orgtree_message.' },
            ],
          },
        ],
      },
      msgbob: {
        turns: [
          {
            name: 'bob-woken',
            match: 'SLOW-MAIL-WAKE',
            once: true,
            steps: [{ text: 'Received slow mail and woke cleanly.' }],
          },
        ],
      },
      sparse: {
        turns: [
          {
            name: 'sparse-resumed',
            match: 'read_file',
            once: true,
            steps: [
              { tool: 'orgtree_status', args: { status: 'done', summary: 'Recovered after sparse progress hang.' } },
              { text: 'Recovered after sparse progress hang.' },
            ],
          },
          {
            name: 'sparse-progress',
            match: 'PROOF-SPARSE',
            once: true,
            steps: [
              toolStep(21, 'ACTIVE', { tool_name: 'read_file', tool_info: { parameters: {} } }),
              toolStep(21, 'ACTIVE', { tool_info: { parameters: {} } }),
              { sleep_ms: 8500 },
              toolStep(21, 'DONE', { tool_name: 'read_file', tool_info: { result: 'reached' } }),
              { text: 'Processed the delayed result.' },
            ],
          },
        ],
      },
      unnamed: {
        turns: [
          {
            name: 'unnamed-tool-step',
            match: 'PROOF-UNNAMED',
            once: true,
            steps: [
              toolStep(5, 'ACTIVE', { tool_info: { parameters: {} } }),
              toolStep(5, 'DONE', { tool_info: { result: 'done' } }),
              { text: 'Finished unnamed tool.' },
            ],
          },
        ],
      },
    },
    default: { turns: [{ name: 'default', steps: [{ text: 'OK.' }] }] },
  })

  await rig.waitFor(() => rig.sql(`SELECT 1 FROM ot.turns WHERE ended_at IS NULL`).length === 0,
    { what: 'seed turns to settle', timeout: SEED_SETTLE_TIMEOUT })

  for (const name of AGY_AGENTS) {
    await rig.op({ op: 'hire', name, parent: 'boss', tier: 'flash', title: 'Antigravity stall proof agent' })
  }
  await rig.op({ op: 'hire', name: 'slowmsg', parent: 'boss', tier: 'flash', grant: 2, title: 'Slow MCP message sender' })
  await rig.op({ op: 'hire', name: 'msgbob', parent: 'slowmsg', tier: 'flash', title: 'Slow MCP message recipient' })
  await rig.op({ op: 'hire', name: 'clerr', parent: 'boss', tier: 'sonnet', title: 'Claude cross-lane regression' })
  await rig.op({ op: 'hire', name: 'cxerr', parent: 'boss', tier: 'luna', title: 'Codex cross-lane regression' })

  const ALL_AGENTS = [...AGY_AGENTS, 'slowmsg', 'msgbob', 'clerr', 'cxerr']
  const ids = Object.fromEntries(ALL_AGENTS.map(a => [a, rig.agentRow(a)?.id]))
  p.check('all 20 proof agents hired', ALL_AGENTS.every(a => ids[a]), ids)

  // Inject real PostgreSQL write failures for failrec/failwake (Ruling 4) and
  // a post-commit delay in forget_hard_fail for msgbob (Ruling 5).
  rig.exec(`
    CREATE OR REPLACE FUNCTION ot._test_agy_stall_agents_guard() RETURNS trigger AS $$
    BEGIN
      IF NEW.name = 'failrec' AND (NEW.extra ? 'agy_tool_hang_retry') AND NOT (OLD.extra ? 'agy_tool_hang_retry') THEN
        RAISE EXCEPTION 'injected retry record write failure';
      END IF;
      IF NEW.name = 'msgbob' AND (OLD.extra ? 'hard_fail_run') AND NOT (NEW.extra ? 'hard_fail_run') THEN
        PERFORM pg_sleep(2.2);
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
    DROP TRIGGER IF EXISTS _test_agy_stall_agents_guard ON ot.agents;
    CREATE TRIGGER _test_agy_stall_agents_guard
      BEFORE UPDATE ON ot.agents
      FOR EACH ROW EXECUTE FUNCTION ot._test_agy_stall_agents_guard();

    CREATE OR REPLACE FUNCTION ot._test_agy_stall_mail_guard() RETURNS trigger AS $$
    BEGIN
      IF NEW.recipient_name = 'failwake' AND NEW.sender = '@system' AND NEW.body LIKE '%hung%' THEN
        RAISE EXCEPTION 'injected resume wake write failure';
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
    DROP TRIGGER IF EXISTS _test_agy_stall_mail_guard ON ot.mail;
    CREATE TRIGGER _test_agy_stall_mail_guard
      BEFORE INSERT ON ot.mail
      FOR EACH ROW EXECUTE FUNCTION ot._test_agy_stall_mail_guard();

    UPDATE ot.agents SET extra = jsonb_set(extra, '{hard_fail_run}', '1'::jsonb) WHERE name = 'msgbob';
  `)

  const log = (agent, kind) => rig.fakeLog(agent).filter(l => !kind || l.kind === kind)
  const stalledFor = name => rig.sql(
    `SELECT id, body, ev FROM ot.mail WHERE recipient_name = 'boss' AND ev->>'variant' = 'runtime.report_stalled' AND ev->>'report' = '${name}' ORDER BY id`
  )
  const killLogText = () => {
    const f = path.join(rig.data, 'diagnostics', 'logs', 'codex-kills.log')
    return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : ''
  }

  // Launch all cases in parallel to keep total rig time short
  await Promise.all([
    rig.userMail('hang1', 'PROOF-HANG-RECOVER: read breadcrumbs.'),
    rig.userMail('hang2', 'PROOF-HANG-REPEAT: write breadcrumbs.'),
    rig.userMail('hangdiff', 'PROOF-HANG-DIFF: read then write.'),
    rig.userMail('hangmcp', 'PROOF-HANG-MCP: record solo evidence.'),
    rig.userMail('cmdok', 'PROOF-RUN-CMD: build project.'),
    rig.userMail('soft1', 'PROOF-SOFT-NET: finish and report.'),
    rig.userMail('soft2', 'PROOF-SOFT-400: finish and report.'),
    rig.userMail('partial', 'PROOF-PARTIAL: finish then start second answer.'),
    rig.userMail('steered', 'PROOF-STEER: finish then accept follow-up.'),
    rig.userMail('midnet', 'PROOF-MID-NET: inspect remote.'),
    rig.userMail('mid400', 'PROOF-MID-400: do work.'),
    rig.userMail('notext', 'PROOF-NO-TEXT: check chart after done.'),
    rig.userMail('clerr', 'PROOF-CROSS-LANE: claude stream interrupted.'),
    rig.userMail('cxerr', 'PROOF-CROSS-LANE: codex stream interrupted.'),
    rig.userMail('failrec', 'PROOF-FAIL-REC: hang with retry write failure.'),
    rig.userMail('failwake', 'PROOF-FAIL-WAKE: hang with wake write failure.'),
    rig.userMail('slowmsg', 'PROOF-SLOW-MSG: send slow orgtree_message.'),
    rig.userMail('sparse', 'PROOF-SPARSE: sparse progress update.'),
    rig.userMail('unnamed', 'PROOF-UNNAMED: unnamed tool step.'),
  ])

  // Deliver the follow-up instruction while `steered` is polling for mid-turn mail
  await rig.waitFor(() => rig.fakeLog('steered').some(row => row.kind === 'step' && row.step?.poll_mail),
    { what: 'steered fake CLI to wait for follow-up mail', timeout: 25000 })
  await rig.userMail('steered', 'SECOND-REVIEW-INSTRUCTION')

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

  // ---------------------------------------------------------------- (Ruling 1a) partial: interrupted second answer -> NOT soft-ended
  const [pt1] = await rig.waitTurns('partial', 1, { timeout: 30000 })
  const ptStalls = await rig.waitFor(() => {
    const s = stalledFor('partial')
    return s.length ? s : null
  }, { what: 'partial REPORT STALLED', timeout: 8000 }).catch(() => stalledFor('partial'))
  p.check('partial: interrupted ACTIVE second answer after earlier done + final text is NOT soft-ended and reports stall',
    !!pt1.error && ptStalls.length === 1,
    { turn: pt1, stalls: ptStalls.length })

  // ---------------------------------------------------------------- (Ruling 1b) steered: delivered follow-up unanswered -> NOT soft-ended
  const [st1] = await rig.waitTurns('steered', 1, { timeout: 30000 })
  const stStalls = await rig.waitFor(() => {
    const s = stalledFor('steered')
    return s.length ? s : null
  }, { what: 'steered REPORT STALLED', timeout: 8000 }).catch(() => stalledFor('steered'))
  const stDelivery = rig.sql("SELECT state, turn_id FROM ot.mail WHERE recipient_name='steered' AND body LIKE '%SECOND-REVIEW-INSTRUCTION%'")
  const stInjected = rig.fakeLog('steered').some(r => r.kind === 'hook_mail' && r.text?.includes('SECOND-REVIEW-INSTRUCTION'))
  p.check('steered: delivered follow-up unanswered before 400 is NOT soft-ended, reports stall, and preserves delivery custody',
    !!st1.error && stStalls.length === 1 && stInjected && stDelivery.length === 1 && stDelivery[0].state === 'delivered',
    { turn: st1, stalls: stStalls.length, injected: stInjected, delivery: stDelivery })

  // ---------------------------------------------------------------- (c2) mid400: mid-work 400 -> terminal REPORT STALLED
  const [m400] = await rig.waitTurns('mid400', 1, { timeout: 30000 })
  const m400Stalls = await rig.waitFor(() => {
    const s = stalledFor('mid400')
    return s.length ? s : null
  }, { what: 'mid400 REPORT STALLED', timeout: 10000 }).catch(() => stalledFor('mid400'))
  const m400Door = m400Stalls[0]?.ev?.door ?? ''
  p.check('mid400: mid-work INVALID_ARGUMENT (400) reports terminal REPORT STALLED with last status working',
    !!m400.error && !rig.agentRow('mid400').frozen && m400Stalls.length === 1 && /last status: working at /i.test(m400Door),
    { error: m400.error, frozen: rig.agentRow('mid400').frozen, door: m400Door, stalls: m400Stalls.length })

  // ---------------------------------------------------------------- (c3) notext: done + extra tool + no final text + 400 -> terminal REPORT STALLED
  const [nt1] = await rig.waitTurns('notext', 1, { timeout: 30000 })
  const ntStalls = await rig.waitFor(() => {
    const s = stalledFor('notext')
    return s.length ? s : null
  }, { what: 'notext REPORT STALLED', timeout: 10000 }).catch(() => stalledFor('notext'))
  const ntDoor = ntStalls[0]?.ev?.door ?? ''
  p.check('notext: error after done + subsequent tool without final text is NOT soft-ended and names last status done',
    !!nt1.error && ntStalls.length === 1 && /last status: done at /i.test(ntDoor),
    { error: nt1.error, door: ntDoor, stalls: ntStalls.length })

  // ---------------------------------------------------------------- (Ruling 3) clerr & cxerr: Claude/Codex stay byte-identical to 6a9cf2d
  const [[cl1], [cx1]] = await Promise.all([
    rig.waitTurns('clerr', 1, { timeout: 25000 }),
    rig.waitTurns('cxerr', 1, { timeout: 25000 }),
  ])
  const clRow = rig.agentRow('clerr')
  const cxRow = rig.agentRow('cxerr')
  const clStalls = await rig.waitFor(() => {
    const s = stalledFor('clerr')
    return s.length ? s : null
  }, { what: 'clerr REPORT STALLED', timeout: 8000 }).catch(() => stalledFor('clerr'))
  const cxStalls = await rig.waitFor(() => {
    const s = stalledFor('cxerr')
    return s.length ? s : null
  }, { what: 'cxerr REPORT STALLED', timeout: 8000 }).catch(() => stalledFor('cxerr'))
  p.check('clerr & cxerr: "The stream was interrupted." does NOT connection-freeze Claude or Codex (net_fail_run=0, terminal stall)',
    !clRow.frozen?.connection && (clRow.extra?.net_fail_run ?? 0) === 0 && cl1.error === streamInterrupted && clStalls.length === 1
      && !cxRow.frozen?.connection && (cxRow.extra?.net_fail_run ?? 0) === 0 && cx1.error === streamInterrupted && cxStalls.length === 1,
    {
      cl: { frozen: clRow.frozen, netRun: clRow.extra?.net_fail_run ?? 0, error: cl1.error, stalls: clStalls.length },
      cx: { frozen: cxRow.frozen, netRun: cxRow.extra?.net_fail_run ?? 0, error: cx1.error, stalls: cxStalls.length },
    })

  // ---------------------------------------------------------------- (Ruling 5) slowmsg + msgbob: detached MCP timeout still wakes recipient
  const [sm1] = await rig.waitTurns('slowmsg', 1, { timeout: 30000 })
  const smToolRes = log('slowmsg', 'tool_result').find(r => r.tool === 'orgtree_message')
  const bobTurns = await rig.waitTurns('msgbob', 1, { timeout: 12000 }).catch(() => rig.turns('msgbob'))
  const slowMailRow = rig.one("SELECT state, body FROM ot.mail WHERE recipient_name='msgbob' AND body='SLOW-MAIL-WAKE'")
  p.check('slowmsg/msgbob: timed-out orgtree_message detaches so committed mail still wakes msgbob while caller gets check-before-retry error',
    !sm1.error
      && smToolRes?.is_error === true
      && /orgtree_message.*timed out.*may still have taken effect.*check/i.test(smToolRes?.text ?? '')
      && bobTurns.length === 1 && !bobTurns[0].error
      && slowMailRow?.state === 'delivered',
    { smTurn: sm1, smToolRes, bobTurns, slowMailRow })

  // ---------------------------------------------------------------- (Ruling 6b) unnamed: unnamed tool step records "an unnamed tool"
  const [un1] = await rig.waitTurns('unnamed', 1, { timeout: 25000 })
  const unnamedChips = rig.sql(
    `SELECT t->>'name' AS name FROM ot.convo c, jsonb_array_elements(coalesce(c.body->'tools', '[]'::jsonb)) t
      WHERE c.agent_id = ${ids.unnamed}`
  )
  p.check('unnamed: tool step omitting tool_name records "an unnamed tool" (never blank or "tool")',
    !un1.error && unnamedChips.length === 1 && unnamedChips[0].name === 'an unnamed tool',
    { turn: un1, chips: unnamedChips })

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
      && /codex-force-kill.*agent hang1.*graceful_tried=true/.test(h1Kills),
    { turns: h1Turns, prompt2: h1Prompt2.slice(0, 240), stalls: stalledFor('hang1').length, killsMatch: /codex-force-kill.*hang1/.test(h1Kills) })

  // ---------------------------------------------------------------- (a2) hang2: repeated write_file hang -> stops after 2 turns, reports to boss, NO 3rd attempt
  const h2Turns = await rig.waitTurns('hang2', 2, { timeout: 60000 }).catch(() => rig.turns('hang2'))
  const h2Stalls = await rig.waitFor(() => {
    const s = stalledFor('hang2')
    return s.length ? s : null
  }, { what: 'hang2 REPORT STALLED after repeat hang', timeout: 15000 }).catch(() => stalledFor('hang2'))
  await new Promise(r => setTimeout(r, 3000))
  const h2After = rig.turns('hang2')
  const h2Door = h2Stalls[0]?.ev?.door ?? ''
  p.check('hang2: repeated write_file hang stops after 2nd attempt (no 3rd turn) and reports stuck in tool write_file since T',
    h2Turns.length === 2
      && h2After.length === 2
      && h2Stalls.length === 1
      && /stuck in tool write_file since /i.test(h2Door)
      && /codex-force-kill.*agent hang2.*graceful_tried=true/.test(killLogText()),
    { turns: h2After, door: h2Door, stalls: h2Stalls.length })

  // ---------------------------------------------------------------- (Ruling 2) hangdiff: read_file hang then write_file hang -> exactly 2 turns, no 3rd turn
  const hdTurns = await rig.waitTurns('hangdiff', 2, { timeout: 60000 }).catch(() => rig.turns('hangdiff'))
  const hdStalls = await rig.waitFor(() => {
    const s = stalledFor('hangdiff')
    return s.length ? s : null
  }, { what: 'hangdiff REPORT STALLED after different-tool repeat hang', timeout: 12000 }).catch(() => stalledFor('hangdiff'))
  await new Promise(r => setTimeout(r, 3000))
  const hdAfter = rig.turns('hangdiff')
  const hdDoor = hdStalls[0]?.ev?.door ?? ''
  const hdKills = killLogText()
  p.check('hangdiff: read_file hang then write_file hang stops at exactly 2 turns (no 3rd turn) and reports stuck in tool write_file',
    hdTurns.length === 2
      && hdAfter.length === 2
      && hdStalls.length === 1
      && /stuck in tool write_file since /i.test(hdDoor)
      && /codex-force-kill.*agent hangdiff.*stuck in tool read_file/i.test(hdKills)
      && /codex-force-kill.*agent hangdiff.*stuck in tool write_file/i.test(hdKills),
    { turns: hdAfter, door: hdDoor, stalls: hdStalls.length })

  // ---------------------------------------------------------------- (Ruling 4) failrec & failwake: injected write failure still notifies boss
  const [fr1] = await rig.waitTurns('failrec', 1, { timeout: 30000 }).catch(() => rig.turns('failrec'))
  const [fw1] = await rig.waitTurns('failwake', 1, { timeout: 30000 }).catch(() => rig.turns('failwake'))
  const frStalls = await rig.waitFor(() => {
    const s = stalledFor('failrec')
    return s.length ? s : null
  }, { what: 'failrec REPORT STALLED', timeout: 8000 }).catch(() => stalledFor('failrec'))
  const fwStalls = await rig.waitFor(() => {
    const s = stalledFor('failwake')
    return s.length ? s : null
  }, { what: 'failwake REPORT STALLED', timeout: 8000 }).catch(() => stalledFor('failwake'))
  await new Promise(r => setTimeout(r, 2000))
  const frTurns = rig.turns('failrec')
  const fwTurns = rig.turns('failwake')
  p.check('failrec & failwake: injected retry-record or wake write failure still sends REPORT STALLED to boss (no silent suppression)',
    !!fr1?.killed && frTurns.length === 1 && frStalls.length === 1 && /stuck in tool read_file since /i.test(frStalls[0]?.ev?.door ?? '')
      && !!fw1?.killed && fwTurns.length === 1 && fwStalls.length === 1 && /stuck in tool read_file since /i.test(fwStalls[0]?.ev?.door ?? ''),
    {
      failrec: { turns: frTurns, stalls: frStalls.length, door: frStalls[0]?.ev?.door ?? '' },
      failwake: { turns: fwTurns, stalls: fwStalls.length, door: fwStalls[0]?.ev?.door ?? '' },
    })

  // ---------------------------------------------------------------- (Ruling 6a) sparse: progress omitting tool_name keeps read_file ceiling
  const spTurns = await rig.waitTurns('sparse', 2, { timeout: 45000 }).catch(() => rig.turns('sparse'))
  const spPrompt2 = log('sparse', 'turn')[1]?.prompt ?? ''
  p.check('sparse: progress update omitting tool_name keeps known read_file ceiling, stops at 4 s, and auto-resumes naming read_file',
    spTurns.length === 2
      && spTurns[0].killed === true
      && /stuck in tool read_file since /i.test(spTurns[0].error ?? '')
      && !spTurns[1].error
      && /read_file/.test(spPrompt2),
    { turns: spTurns, prompt2: spPrompt2.slice(0, 240) })

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

  p.keep(rig, { agents: ALL_AGENTS, grep: /agy|Agy|stuck in tool|soft end-of-turn|codex-force-kill|report_stalled|detached/ })
  return p.summary()
}
