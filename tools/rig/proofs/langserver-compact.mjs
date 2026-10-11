// Proof: a Language Server agent whose context fills keeps going. The live
// bug (2026-10-11, alpha.7, llama.cpp + Qwen 3.8 27B, 64K window): Claude
// Code's compaction got no text back from the model (it can call one of the
// offered tools, or think until the window is gone), and the turn ended
// "Prompt is too long · automatic compaction failed: summarization produced
// empty response", not retried; Codex fails the same way with "Incomplete
// response returned, reason: max_output_tokens".
//
// The server is tools/rig/fakellm.mjs in WINDOW mode: a 64K window like the
// live one, llama.cpp's refusal past it, an answer cut where the window ends.
// An agent reads part files until its context fills; the fake answers the
// CLI's summary request like a model that calls an offered tool, and
// otherwise thinks first: TOOLS for 8K tokens (the live model's 07:58Z
// summary), RUNAWAY past any window. Each fake honours only the thinking
// switches its real server is known to honour (SWITCHES, from the servers'
// sources 2026-10; LM Studio and custom: none assumed).
//   1. every preset x harness x profile: the agent finishes its task;
//   2. TOOLS everywhere, RUNAWAY where the server honours a thinking switch
//      the engine sends: the CLI's own compaction works (the pass-through
//      sends the summary request without tools, without earlier thinking,
//      with thinking off);
//   3. RUNAWAY elsewhere: the CLI's compaction fails, the engine moves the
//      agent to a fresh session with a handoff note, its superior is told
//      once, and the agent carries on from where it was;
//   4. the context gauge: every agent's window (65,536) and occupancy.
// PROOF_COMPACT_ONLY=<substring>[,<substring>…] runs only the cases whose name contains one
// (e.g. "llamacpp", "RUNAWAY", "codex").
// Run: node tools/rig/rig.mjs run tools/rig/proofs/langserver-compact.mjs

import fs from 'node:fs'
import path from 'node:path'

import { startFakeLlm } from '../fakellm.mjs'
import { seed } from '../fixture.mjs'
import { Proof } from '../proof.mjs'

const MODEL = 'fake-model:latest'
const WINDOW = 65536
const PRESETS = ['llamacpp', 'ollama', 'lmstudio', 'vllm', 'custom']
const HARNESSES = ['claude-code', 'codex-cli']
/** how long the model thinks before a summary, in characters (4 a token) */
const PROFILES = { TOOLS: 32000, RUNAWAY: 400000 }
/** the thinking switches each real server is known to honour (sources
 *  2026-10): llama.cpp its template switch and the Responses effort, Ollama
 *  the Messages thinking field and the Responses effort, vLLM the Messages
 *  thinking field and its template switch; LM Studio, custom: none assumed */
const SWITCHES = { llamacpp: ['template', 'effort'], ollama: ['anthropic', 'effort'], vllm: ['anthropic', 'template'] }
/** the switches the engine's pass-through sends with a summary request */
const SENT = {
  'claude-code': preset => preset === 'llamacpp' ? ['anthropic', 'template'] : ['anthropic'],
  'codex-cli': preset => ['llamacpp', 'ollama'].includes(preset) ? ['effort'] : [],
}
const thinkingOff = (preset, harness) => SENT[harness](preset).some(s => (SWITCHES[preset] ?? []).includes(s))
/** enough parts to fill each CLI's context (Codex keeps 10 KB of each tool output) */
const PARTS = { 'claude-code': 6, 'codex-cli': 12 }
const PART_CHARS = 16000
const SUMMARY_ASK = { 'claude-code': 'CRITICAL: Respond with TEXT ONLY', 'codex-cli': 'CONTEXT CHECKPOINT COMPACTION' }
const WAKE = 'Carry on where you left off'
const posix = s => s.replace(/\\/g, '/')

/** a part the agent reads: engine-log-like lines, PART_CHARS long */
function partText(n) {
  const lines = []
  for (let i = 0; lines.join('\n').length < PART_CHARS; i++) {
    lines.push(`2026-10-11T07:3${n % 10}:${String(i % 60).padStart(2, '0')}.${String(i).padStart(3, '0')}Z INFO runtime.actor ` +
      `agent:15${n}${i % 10}/qwen-logs part ${n} line ${i} handle_msg(msg=Wake) ensure_proc ok queued=0 busy=true`)
  }
  return lines.join('\n').slice(0, PART_CHARS)
}

export async function setup() {
  return { name: 'langserver-compact', 'real-cli': true, fixture: 'none' }
}

export default async function (rig) {
  const p = new Proof('langserver-compact')
  const dir = path.join(p.dir, 'parts')
  fs.mkdirSync(dir, { recursive: true })
  for (let n = 1; n <= PARTS['codex-cli']; n++) fs.writeFileSync(path.join(dir, `part${n}.txt`), partText(n))
  // each harness's shell tool, named so that a handoff note's digest names
  // the last part read: Claude Code's call by its description; Codex's by a
  // short command run in the parts folder (a digest keeps 90 characters of a
  // command, and on Windows Codex's PowerShell wrapper takes 75 of them)
  const read = (h, n) => h === 'claude-code'
    ? { tool: 'Bash', input: { command: `cat "${posix(dir)}/part${n}.txt"`, description: `Read part${n}.txt` } }
    : { tool: 'exec_command', input: { cmd: `cat part${n}.txt`, workdir: dir } }
  const only = process.env.PROOF_COMPACT_ONLY ?? ''
  const cases = PRESETS.flatMap(preset => HARNESSES.flatMap(harness => Object.keys(PROFILES).map(profile => ({
    preset, harness, profile,
    name: `ls${preset.slice(0, 4)}${harness === 'claude-code' ? 'c' : 'x'}${profile === 'TOOLS' ? 't' : 'r'}`,
    token: `PROOF-COMPACT-${preset.toUpperCase()}-${harness === 'claude-code' ? 'C' : 'X'}-${profile}`,
    // what must save it: the CLI's own compaction, or the engine's fresh session
    expect: profile === 'RUNAWAY' && !thinkingOff(preset, harness) ? 'fresh-session' : 'cli-compaction',
  })))).filter(c => only.split(",").some(o => `${c.profile}:${c.preset}:${c.harness}:${c.name}`.includes(o)))
  const servers = []
  try {
    for (const c of cases) {
      const last = PARTS[c.harness]
      // how many parts the text shows read: the calls it names, and the
      // progress an earlier summary recorded (its NEXT-PART)
      const progress = (t) => Math.max(0,
        ...[...t.matchAll(/part(\d+)\.txt/g)].map(m => Number(m[1])).filter(n => n <= last),
        ...[...t.matchAll(/NEXT-PART=(\d+)/g)].map(m => Number(m[1]) - 1))
      const step = (next) => next > last
        ? { tool: 'orgtree_status', input: { status: 'done', summary: `${c.token}-DONE` } } : read(c.harness, next)
      const rules = [
        // the CLI asks for a summary: a tool call when tools are offered,
        // else thinking (unless switched off) and then the summary, which
        // records the progress (and, unlike the task, carries no token)
        { match: [SUMMARY_ASK[c.harness]], withTool: true, think: PROFILES[c.profile], toolIfOffered: read(c.harness, 1),
          respond: (t, whole) => ({ text: `<analysis>The agent reads parts.</analysis>\n<summary>PROOF-SUMMARY: the task is to read ` +
            `the part files one at a time with cat, in order, then report done with orgtree_status. ${progress(whole)} of them ` +
            `are read. NEXT-PART=${progress(whole) + 1}</summary>` }) },
        // on from where the conversation was: after the CLI's compaction (its
        // summary) or in the engine's fresh session (its note and wake)
        { match: ['PROOF-SUMMARY'], respond: (t) => step(progress(t) + 1) },
        { match: [WAKE], respond: (t) => step(progress(t) + 1) },
        { match: [c.token], ...read(c.harness, 1) },
        ...Array.from({ length: last - 1 }, (_, i) => ({ afterCall: [`part${i + 1}.txt`], ...read(c.harness, i + 2) })),
        { afterCall: [`part${last}.txt`], tool: 'orgtree_status', input: { status: 'done', summary: `${c.token}-DONE` } },
      ]
      c.llm = await startFakeLlm({ window: WINDOW, thinkingSwitches: SWITCHES[c.preset] ?? [], rules,
        log: path.join(p.dir, `fakellm-${c.name}.jsonl`), bodies: path.join(p.dir, `bodies-${c.name}`),
        models: [{ name: MODEL, context: WINDOW, running: WINDOW }] })
      servers.push(c.llm)
      const body = { preset: c.preset, address: c.llm.url, harness: c.harness, label: `${c.preset} ${c.name}`,
        models: [{ id: MODEL, context: WINDOW }] }
      if (c.preset === 'custom' && c.harness === 'codex-cli') body.base_path = 'v1'
      const made = await rig.api('POST', '/api/langservers', body)
      c.tier = Object.values(made.server?.models ?? {})[0]?.tier ?? null
    }
    p.check('a 64K server per case, each model a tier', cases.length > 0 && cases.every(c => c.tier),
      cases.map(c => ({ name: c.name, tier: c.tier })))
    const scope = { org_visibility: 'self', permission_mode: 'bypassPermissions',
      tools: { bash: true, web: false, edit: true, subagents: false, mcp: [] }, add_dirs: [] }
    await seed(rig, { org: { name: 'Compaction Org' }, agents: [
      { name: 'lslead', tier: cases[0].tier, grant: 0, charter: 'You lead the compaction proof.', team_charter: 'Read files and report.' },
      ...cases.map(c => ({ name: c.name, tier: c.tier, grant: 0, parent: 'lslead', charter: 'You read files and report.', ...scope })),
    ] })
    const q = s => s.replace(/'/g, "''")
    const status = n => rig.one(`SELECT last_status->>'summary' AS summary FROM ot.agents WHERE name = '${q(n)}'`)
    const busy = n => rig.sql(`SELECT 1 FROM ot.turns t JOIN ot.agents a ON a.id = t.agent_id WHERE a.name = '${q(n)}' AND t.ended_at IS NULL`).length > 0
    const waiting = n => rig.sql(`SELECT 1 FROM ot.mail m JOIN ot.agents a ON a.id = m.recipient_agent_id
      WHERE a.name = '${q(n)}' AND m.state = 'pending' AND NOT m.notice`).length > 0
    const compactRows = n => rig.sql(`SELECT c.body->>'text' AS text FROM ot.convo c JOIN ot.agents a ON a.id = c.agent_id
      WHERE a.name = '${q(n)}' AND c.body->>'kind' = 'compact' ORDER BY c.seq`)
    const leadNotes = n => rig.sql(`SELECT m.body FROM ot.mail m JOIN ot.agents a ON a.id = m.recipient_agent_id
      WHERE a.name = 'lslead' AND m.body LIKE '${q(n)} now has a fresh session (its context window filled up%'`)
    // one preset at a time (four CLIs at once)
    for (const preset of PRESETS) {
      const batch = cases.filter(c => c.preset === preset)
      // a few seconds apart: two Codex processes starting at once can both
      // open the shared profile's state database, and one fails (rig 2026-10-11)
      for (const c of batch) {
        await rig.userMail(c.name, `${c.token}: read the part files one at a time with cat, then report done with orgtree_status.`)
        await new Promise(r => setTimeout(r, 4000))
      }
      await Promise.all(batch.map(async (c) => {
        c.done = await rig.waitFor(() => {
          if (status(c.name)?.summary === `${c.token}-DONE`) return { done: true }
          const row = rig.agentRow(c.name)
          // a terminal failure: an error, no turn running, nothing waiting to start one
          if (row?.last_error && !busy(c.name) && !waiting(c.name)) return { done: false, error: row.last_error }
          return null
        }, { what: `${c.name} to finish or fail`, timeout: 420000 }).catch(() => ({ done: false, error: 'timeout' }))
      }))
    }
    for (const c of cases) {
      const reqs = c.llm.requests.filter(r => r.path === '/v1/messages' || r.path === '/v1/responses')
      const asks = reqs.filter(r => String(r.reply?.text ?? '').includes('PROOF-SUMMARY'))
      // answered with the summary: no tool call, not cut off in its thinking
      const summarised = asks.filter(r => !r.reply?.tool && !r.cut)
      const rows = compactRows(c.name).map(r => r.text)
      const fresh = rows.filter(t => /^The context window filled up/.test(t ?? ''))
      const row = rig.agentRow(c.name)
      const notes = leadNotes(c.name).length
      const facts = { done: c.done, profile: c.profile, expect: c.expect,
        summary_requests: asks.map(r => ({ at: r.at, usage_in: r.usage_in, offered: r.offered, thinking_off: r.thinking_off,
          answered: r.reply?.tool ? `tool ${r.reply.tool}` : r.cut ? 'cut off' : 'summary', think: r.reply?.think ?? 0, cut: r.cut, body: r.body_file })),
        compact_rows: rows, lead_notices: notes, overflows: reqs.filter(r => r.overflow).length,
        last_error: row?.last_error ?? null, occupancy: row?.occupancy ?? null, context_window: row?.context_window ?? null }
      const label = `${c.preset} · ${c.harness} · ${c.profile}`
      p.check(`${label}: the agent's context filled and it finished its task`, c.done?.done === true, facts)
      if (c.expect === 'cli-compaction') {
        // a 64K window holds ~35K of fixed prefix: Claude Code may compact
        // fine and still stop ("Autocompact is thrashing"), which the
        // engine's fresh session catches; the superior hears of it once
        p.check(`${label}: the CLI's own compaction worked (summary requests without tools, answered with the summary); a later stop, if any, caught once`,
          summarised.length > 0 && asks.every(r => !r.offered) && notes === Math.min(fresh.length, 1), facts)
      } else {
        // one task, one run of fresh sessions: the superior hears of it once
        p.check(`${label}: the CLI's compaction failed; the engine moved the agent to a fresh session and told its superior once`,
          summarised.length === 0 && fresh.length >= 1 && notes === 1, facts)
      }
    }
    // a turn writes the gauge when it ends: the status call comes before that
    await rig.waitFor(() => cases.every(c => !busy(c.name)) || null, { what: 'every turn to end', timeout: 60000 }).catch(() => null)
    const gauge = cases.map(c => ({ name: c.name, ...rig.one(`SELECT occupancy, context_window FROM ot.agents WHERE name = '${q(c.name)}'`) }))
    p.check('the context gauge: every agent has its window (65,536) and an occupancy',
      gauge.every(g => Number(g.context_window) === WINDOW && Number(g.occupancy) > 0), gauge)
    p.keep(rig, { grep: /langserver|lsproxy|pass-through|summary request|fresh session|compact|Compaction Org/ })
  } finally {
    for (const s of servers) await s.close()
  }
  return p.summary()
}
