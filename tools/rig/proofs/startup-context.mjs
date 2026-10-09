// Proof: an edit to a CLI's startup instruction files reaches the agent
// (decision 61, 3.x parity; user 2026-10-09: "an edit to your standing notes
// or anything fed at the start of context should trigger a queued restart of
// your session"). The fake CLIs log the file they read at process start
// (Claude: the cwd's CLAUDE.md; Codex: the cwd's AGENTS.md), as the real
// ones do.
//   sam (Claude): his first turn runs on a CLI that read CLAUDE.md v1. With
//   no edit, a later turn (after the 20 s idle re-check) reuses that CLI.
//   After an edit to v2 while he is idle, his forecast lists "startup" as a
//   changed input and his CLI is replaced, resuming the SAME session, and
//   his next turn reads v2. An edit to v3 during a long turn leaves that turn
//   alone: no new CLI until it has ended, then one that read v3.
//   cora (Codex): the same with AGENTS.md: no edit, no new app-server; after
//   an edit, the next turn runs on a new one that read v2 and resumed the
//   same thread.
// Run: node tools/rig/rig.mjs run tools/rig/proofs/startup-context.mjs

import fs from 'node:fs'
import path from 'node:path'

import { Proof } from '../proof.mjs'

const pause = ms => new Promise(resolve => setTimeout(resolve, ms))

export default async function (rig) {
  const p = new Proof('startup-context')
  rig.scenario({
    agents: { sam: { turns: [{ name: 'long', match: 'PROOF-LONG', once: true, steps: [{ text: 'Working on it.' }, { sleep_ms: 35000 }, { text: 'Done.' }] }] } },
    default: { turns: [{ name: 'default', steps: [{ text: 'OK.' }] }] },
  })
  await rig.waitFor(() => rig.sql('SELECT 1 FROM ot.turns WHERE ended_at IS NULL').length === 0, { what: 'seed turns to settle', timeout: 60000 })
  await rig.op({ op: 'hire', name: 'sam', parent: 'boss', tier: 'haiku', title: 'Claude notes' })
  await rig.op({ op: 'hire', name: 'cora', parent: 'boss', tier: 'luna', title: 'Codex notes' })
  const scratch = name => path.join(rig.data, 'scratch', rig.org, name)
  const write = (name, file, text) => { fs.mkdirSync(scratch(name), { recursive: true }); fs.writeFileSync(path.join(scratch(name), file), text) }
  const starts = name => rig.fakeLog(name).filter(l => l.kind === 'start')
  const turnsDone = name => rig.turns(name).filter(t => t.ended_at).length
  const turn = async (name, text) => {
    const done = turnsDone(name)
    await rig.userMail(name, text)
    await rig.waitTurns(name, done + 1)
  }
  const session = name => rig.agentRow(name)?.session_id
  const resumeArg = s => { const a = s?.args ?? []; const i = a.indexOf('--resume'); return i >= 0 ? a[i + 1] : null }
  const forecast = async name => {
    const tree = await rig.api('GET', `/api/orgs/${rig.org}`)
    let found = null
    const walk = v => {
      if (found || !v || typeof v !== 'object') return
      if (v.name === name && 'cache_forecast' in v) { found = v.cache_forecast; return }
      for (const x of Array.isArray(v) ? v : Object.values(v)) walk(x)
    }
    walk(tree)
    return found
  }

  // ---------------------------------------------------------------- sam (Claude)
  write('sam', 'CLAUDE.md', '# Sam\n\nSTANDING NOTES v1\n')
  await turn('sam', 'Hello sam, first turn.')
  const first = starts('sam').at(-1)
  p.check('sam: his first turn runs on a CLI that read CLAUDE.md v1', /STANDING NOTES v1/.test(first?.claude_md ?? ''),
    { claude_md: first?.claude_md, starts: starts('sam').length })
  const sid = session('sam')

  const before = starts('sam').length
  await pause(30000)   // longer than the idle re-check, with nothing edited
  await turn('sam', 'Hello again, no edit.')
  p.check('sam: no edit, no new CLI, through an idle re-check and a turn', starts('sam').length === before,
    { before, after: starts('sam').length })

  write('sam', 'CLAUDE.md', '# Sam\n\nSTANDING NOTES v2\n')
  const fc = await rig.waitFor(async () => {
    const f = await forecast('sam')
    return (f?.changed_inputs ?? []).includes('startup') ? f : null
  }, { what: 'sam\'s forecast to list startup', timeout: 60000 }).catch(() => null)
  p.check('sam: after an edit while idle, his forecast lists "startup" as the changed input', !!fc,
    { readiness: fc?.readiness, cause: fc?.readiness_cause, changed: fc?.changed_inputs })
  const replaced = await rig.waitFor(() => starts('sam').length > before ? starts('sam').at(-1) : null,
    { what: 'sam\'s CLI to be replaced', timeout: 60000 }).catch(() => null)
  p.check('sam: his parked CLI is replaced before the next turn, resuming the same session with v2',
    !!replaced && /STANDING NOTES v2/.test(replaced.claude_md ?? '') && resumeArg(replaced) === sid,
    { claude_md: replaced?.claude_md, resume: resumeArg(replaced), session: sid })
  const n2 = starts('sam').length
  await turn('sam', 'Hello, after the edit.')
  const second = starts('sam').at(-1)
  p.check('sam: his next turn runs on that CLI (v2); the session is the same, not a fresh one',
    starts('sam').length === n2 && /STANDING NOTES v2/.test(second?.claude_md ?? '') && session('sam') === sid,
    { starts: starts('sam').length, claude_md: second?.claude_md, session: session('sam'), was: sid })

  // never mid-turn
  const n3 = starts('sam').length
  await rig.userMail('sam', 'PROOF-LONG: the long job, please.')
  await rig.waitFor(() => rig.fakeLog('sam').some(l => l.kind === 'step' && l.step?.sleep_ms), { what: 'sam to be mid-turn', timeout: 30000 })
  write('sam', 'CLAUDE.md', '# Sam\n\nSTANDING NOTES v3\n')
  await pause(25000)   // past the re-check interval, still inside the turn
  const midTurn = starts('sam').length
  const running = rig.turns('sam').some(t => !t.ended_at)
  await rig.waitTurns('sam', turnsDone('sam') + (running ? 1 : 0), { timeout: 60000 })
  const ended = Date.now()
  const third = await rig.waitFor(() => starts('sam').length > n3 ? starts('sam').at(-1) : null,
    { what: 'sam\'s CLI to be replaced after the long turn', timeout: 60000 }).catch(() => null)
  p.check('sam: an edit during a turn leaves that turn alone; a CLI that read v3 comes only after it ends',
    running && midTurn === n3 && !!third && /STANDING NOTES v3/.test(third.claude_md ?? '') && resumeArg(third) === sid
    && Date.parse(third.at ?? third.ts ?? new Date().toISOString()) >= ended - 5000,
    { running, midTurn, before: n3, claude_md: third?.claude_md, resume: resumeArg(third) })

  // ---------------------------------------------------------------- cora (Codex)
  write('cora', 'AGENTS.md', '# Cora\n\nCODEX NOTES v1\n')
  await turn('cora', 'Hello cora, first turn.')
  const c1 = starts('cora').at(-1)
  const threads = () => rig.fakeLog('cora').filter(l => l.kind === 'thread')
  const thread = threads().at(-1)?.thread
  p.check('cora: her first turn runs on an app-server that read AGENTS.md v1', /CODEX NOTES v1/.test(c1?.agents_md ?? ''),
    { agents_md: c1?.agents_md, thread })
  const cBefore = starts('cora').length
  await turn('cora', 'Hello again, no edit.')
  p.check('cora: no edit, no new app-server', starts('cora').length === cBefore, { before: cBefore, after: starts('cora').length })
  write('cora', 'AGENTS.md', '# Cora\n\nCODEX NOTES v2\n')
  await turn('cora', 'Hello, after the edit.')
  const c2 = starts('cora').at(-1)
  const resumed = threads().filter(l => l.action === 'resume').at(-1)
  p.check('cora: after an edit her next turn runs on a new app-server that read v2 and resumed the same thread',
    starts('cora').length > cBefore && /CODEX NOTES v2/.test(c2?.agents_md ?? '') && !!resumed && resumed.thread === thread,
    { starts: starts('cora').length, agents_md: c2?.agents_md, resumed: resumed?.thread, thread })

  p.keep(rig, { agents: ['sam', 'cora'] })
  return p.summary()
}
