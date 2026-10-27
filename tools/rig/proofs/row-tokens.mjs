// Real PG engine with the fake Claude and Codex CLIs, then the real renderer: every
// conversation row carries a token count (USER 2026-10-27 m10e4ca6d8934 "token counts
// in messages of all kinds (agent, monitor event, system, etc)"; mafe020c4912b "and user
// messages"). A Claude seat takes one turn holding an agent's notice, a watchdog fire and
// the user's message, then answers with thinking, text, a tool call and a compaction; a
// Codex seat answers with thinking, text and a command, then a reply alone, then fails.
// tools/rig/desktop/row-tokens.cjs captures both desks. Build first with
// tools/rig/app-background-ui.mjs and pass its folder in APP_BACKGROUND_BUILD.
// Session 0 only; fake CLIs; synthetic org only.
import fs from 'node:fs'
import path from 'node:path'
import { Proof } from '../proof.mjs'
import { runDesktop } from '../desktop.mjs'
import { REPO } from '../lib.mjs'
import { SEED_SETTLE_TIMEOUT } from '../seed-settle.mjs'

const built = process.env.APP_BACKGROUND_BUILD ? path.resolve(process.env.APP_BACKGROUND_BUILD) : ''
export function setup() {
  if (!built || !fs.existsSync(path.join(built, 'ui', 'index.html'))) throw Error('set APP_BACKGROUND_BUILD to the output of tools/rig/app-background-ui.mjs')
  // The rig has no sign-in helper: session0 '0' keeps turns from waiting for one when the
  // capture runs in Session 0 while the user is signed in. The Codex seat reports to the
  // Claude seat, whose watchdog may watch only itself or a descendant.
  return { ui: path.join(built, 'ui'), session0: '0', fixture: { org: { name: 'Synthetic row tokens' },
    agents: [{ name: 'boss', tier: 'sol', grant: 1 }, { name: 'claude-worker', tier: 'sonnet', grant: 1 },
      { name: 'codex-worker', tier: 'sol', grant: 1, parent: 'claude-worker' }],
    scenario: { default: { turns: [{ steps: [{ text: 'Ready.' }] }] } } } }
}

export default async function (rig) {
  const p = new Proof('row-tokens')
  p.check("the rig serves this worktree's renderer build", path.resolve(rig.run.ui ?? '') === path.join(built, 'ui'), { ui: rig.run.ui })
  await rig.waitFor(() => rig.sql('SELECT 1 FROM ot.turns WHERE ended_at IS NULL').length === 0, { what: 'seed turns settle', timeout: SEED_SETTLE_TIMEOUT })
  const usage = (output, thinking) => ({ input_tokens: 1200, cache_read_input_tokens: 300, cache_creation_input_tokens: 0,
    output_tokens: output, output_tokens_details: { thinking_tokens: thinking } })
  const assistant = (id, content, u, stop = 'tool_use') => ({ raw: { type: 'assistant', parent_tool_use_id: null,
    message: { id, role: 'assistant', content, usage: u, stop_reason: stop } } })
  const stream = event => ({ raw: { type: 'stream_event', parent_tool_use_id: null, event } })
  // Each script runs once, on a word no org-state header holds (the org slug has "row-tokens").
  rig.scenario({ agents: {
    'claude-worker': { turns: [{ match: 'COUNT-EVERY-ROW', once: true, steps: [
      // The CLI's order (USER 2026-10-27 mf421a040506c: a reply of about 130 tokens showed 8t):
      // each block's assistant event carries the usage as it stood before the response
      // finished; the response's final output comes in its message_delta.
      stream({ type: 'message_start', message: { id: 'row-one', usage: usage(1, 0) } }),
      assistant('row-one', [{ type: 'thinking', thinking: 'Planning the synthetic check.' }], usage(8, 20)),
      assistant('row-one', [{ type: 'text', text: 'Checking the synthetic files.' }], usage(8, 20)),
      assistant('row-one', [{ type: 'tool_use', id: 'row-call', name: 'Bash', input: { command: 'echo synthetic-only' } }], usage(8, 20)),
      stream({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 64 } }),
      { raw: { type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: 'row-call', content: 'synthetic line\n'.repeat(40) }] } } },
      assistant('row-two', [{ type: 'text', text: 'ROW-TOKENS-DONE' }], usage(9, 0), 'end_turn'),
      { raw: { type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'auto', pre_tokens: 150000 } } },
    ] }] },
    'codex-worker': { turns: [
      { match: 'COUNT-EVERY-ROW', once: true, steps: [{ thinking: 'Planning the synthetic check.' }, { text: 'Checking the synthetic files.' },
        { tool: 'shell', args: { command: 'echo synthetic-only' }, result: 'synthetic line\n'.repeat(40), exit_code: 0 },
        { text: 'Codex work done.' }, { usage: { input: 1200, cached: 900, output: 80 } }] },
      { match: 'REPLY-ONLY', once: true, steps: [{ text: 'A reply and nothing else.' }, { usage: { input: 1300, cached: 900, output: 9 } }] },
      { match: 'FAIL-TURN', once: true, steps: [{ error: { message: 'synthetic failure' }, will_retry: false }] },
    ] } }, default: { turns: [{ steps: [{ text: 'Ready.' }] }] } })
  const chat = agent => rig.api('GET', `/api/orgs/${rig.org}/nodes/${agent}/chat?last=60`)
  const open = agent => rig.sql(`SELECT 1 FROM ot.turns t JOIN ot.agents a ON a.id=t.agent_id WHERE a.name='${agent}' AND t.ended_at IS NULL`).length > 0
  const settle = async (agent, what) => {
    await rig.waitFor(() => open(agent), { what: what + ' starts', timeout: 15000 }).catch(() => null)
    await rig.waitFor(async () => !open(agent) && !(await chat(agent)).busy, { what: what + ' settles', timeout: 30000 })
  }

  // A monitor event and an agent's notice wait for the Claude seat's next turn.
  const dog = await rig.tool('claude-worker', 'orgtree_watchdog', { action: 'create', name: 'codex-turns', kind: 'activity',
    target: 'codex-worker', pattern: 'turn_done', notice: true, once: true })
  const note = await rig.tool('boss', 'orgtree_message', { to: 'claude-worker', body: 'Synthetic note from boss.', notice: true })
  p.check('a watchdog on the Codex seat is armed and a notice waits', dog.ok && note.ok, { dog: String(dog.text).slice(0, 200), note: String(note.text).slice(0, 200) })
  await rig.userMail('codex-worker', 'COUNT-EVERY-ROW'); await settle('codex-worker', 'the Codex work turn')
  await rig.userMail('codex-worker', 'REPLY-ONLY'); await settle('codex-worker', 'the Codex reply-only turn')
  await rig.waitFor(() => rig.sql("SELECT 1 FROM ot.mail WHERE kind='watchdog' AND sender='codex-turns'").length > 0, { what: 'the watchdog fire', timeout: 30000 }).catch(() => null)
  await rig.userMail('claude-worker', 'COUNT-EVERY-ROW'); await settle('claude-worker', 'the Claude turn')
  // The failure is reported to the Claude seat, its superior, which takes a turn of its own.
  await rig.userMail('codex-worker', 'FAIL-TURN'); await settle('codex-worker', 'the failing Codex turn')
  await settle('claude-worker', "the Claude seat's turn for the failure report")

  const C = (await chat('claude-worker')).messages, X = (await chat('codex-worker')).messages
  p.file('claude-rows.json', C); p.file('codex-rows.json', X)
  // USER 2026-10-27 m7c48d80b13f4, md965e01802ba, m90b8a18987ea: each message's own count,
  // and the conditional parts sent with them itemized apart.
  const cards = row => (row?.segments ?? []).flatMap(s => s.kind === 'mail' ? s.rows : [])
  const owns = row => row?.tokens?.own ?? []
  const extras = row => (row?.tokens?.extras ?? []).map(part => part.label)
  const sent = (r, from) => r.from === from || (from === '@user' && r.from === 'user')
  const ownOf = (row, from) => owns(row).find(o => o.id === cards(row).find(r => sent(r, from))?.id)?.count
  const asked = row => row.role === 'user' && cards(row).some(r => String(r.body ?? '').includes('COUNT-EVERY-ROW'))
  const delivered = C.find(asked)
  const summed = row => (row?.tokens?.extras ?? []).reduce((n, part) => n + part.count, 0)
  p.check("Claude: the delivered message counts each card alone (the user's message, the notice and the watchdog fire) and lists the envelope apart",
    delivered?.tokens?.estimated === true && delivered.tokens.count > 0
    && cards(delivered).every(r => owns(delivered).some(o => o.id === r.id && o.count > 0))
    && ['@user', 'boss', 'codex-turns'].every(from => ownOf(delivered, from) > 0) && ownOf(delivered, '@user') < 200
    && ['Org state', 'Provider usage'].every(label => extras(delivered).includes(label))
    && delivered.tokens.extra === summed(delivered) && delivered.tokens.extra > 0,
    delivered && { tokens: delivered.tokens, cards: cards(delivered).map(r => ({ id: r.id, from: r.from })) })
  const one = C.find(row => row.assistant_id === 'row-one'), two = C.find(row => row.assistant_id === 'row-two')
  p.check("Claude: each response keeps the final output Claude reported for it (its message_delta, not a block's earlier 8), and its thought the reported thinking",
    one?.tokens?.reported === 'Claude' && one.tokens.count === 64 && two?.tokens?.reported === 'Claude' && two.tokens.count === 9 && one.thinking_tokens === 20,
    { one: one?.tokens, two: two?.tokens, thinking: one?.thinking_tokens })
  const call = one?.tools?.find(tool => tool.id === 'row-call')
  p.check('Claude: the tool call shows its input count and the result its output count',
    call?.input_tokens > 0 && call.input_tokens_estimated === true && call.output_tokens > 0, call && { input: call.input_tokens, output: call.output_tokens })
  const compact = C.find(row => row.role === 'system' && row.kind === 'compact')
  p.check('Claude: the compaction is not counted, says why and keeps the context size Claude reported before it',
    compact?.tokens?.not_counted === 'the provider keeps the compaction summary' && compact.pre_tokens === 150000, compact)
  const xmail = X.find(asked)
  p.check("Codex: the delivered message has the user's own count and the envelope apart",
    xmail?.tokens?.estimated === true && xmail.tokens.count > 0 && ownOf(xmail, '@user') > 0 && extras(xmail).includes('Org state'), xmail?.tokens)
  const reply = X.find(row => row.role === 'assistant' && row.text === 'A reply and nothing else.')
  p.check("Codex: a reply that was its request's only output shows the count Codex reported", reply?.tokens?.reported === 'Codex' && reply.tokens.count === 9, reply?.tokens)
  const work = X.find(row => row.role === 'assistant' && /Checking the synthetic files/.test(row.text ?? ''))
  p.check('Codex: other responses are estimated from their text and tool calls', work?.tokens?.estimated === true && work.tokens.count > 0, work?.tokens)
  // The fake reports one usage for the whole turn, so no single thought owns its reasoning.
  const thought = X.find(row => row.role === 'assistant' && row.thinking && !row.text)
  p.check('Codex: a thought alone says its tokens were not reported, never an estimate of its summary',
    thought?.tokens?.not_counted === 'thinking tokens were not reported for this response' && thought.thinking_tokens === undefined, thought && { tokens: thought.tokens, thinking_tokens: thought.thinking_tokens })
  const command = X.flatMap(row => row.tools ?? []).find(tool => tool.input_tokens !== undefined)
  p.check('Codex: the command shows its input count', command?.input_tokens > 0 && command.input_tokens_estimated === true, command && { name: command.name, input: command.input_tokens })
  const failed = X.find(row => row.role === 'system' && row.kind === 'error')
  p.check("Codex: the failed turn's system row is not counted and says why", failed?.tokens?.not_counted === 'not sent to the agent', failed)
  p.check('no row shows a count of 0 for something uncounted', [...C, ...X].every(row => !row.tokens || row.tokens.not_counted || row.tokens.count > 0))
  const read = await rig.tool('boss', 'orgtree_read_transcript', { node: 'boss', last: 5 })
  const own = await rig.tool('claude-worker', 'orgtree_read_transcript', { node: 'claude-worker', last: 40 })
  const listed = own.json?.messages ?? []
  p.check('orgtree_read_transcript rows carry the same counts', read.ok && own.ok && listed.some(row => row.tokens?.reported === 'Claude' && row.tokens.count === 64)
    && listed.some(row => row.tokens?.own?.some(o => o.count > 0) && row.tokens.extras?.some(part => part.label === 'Org state')), listed.map(row => row.tokens ?? null))

  // Both desks in the real renderer, muted.
  const run = await runDesktop(rig, path.join(REPO, 'tools', 'rig', 'desktop', 'row-tokens.cjs'), { preset: 'wide', out: path.join(p.dir, 'desktop'), timeout: 240000,
    args: { agents: ['claude-worker', 'codex-worker'] } })
  p.file('desktop-row-tokens.json', run)
  if (!p.check('the capture ran in Session 0, muted', run.ok && run.value?.session?.sessionId === 0 && run.value?.muted === true,
    { error: run.error, session: run.value?.session, output: run.electronOutput?.slice(-600) })) return p.summary()
  const R = run.value
  p.check('clipboard isolated: every page clipboard path refused, none used, no permission granted', R.installed.clipboardStub && R.clipboard.calls.length === 0 && R.clipboard.requests.length === 0, R.clipboard)
  for (const agent of ['claude-worker', 'codex-worker']) {
    const D = R.desks[agent] ?? {}
    // USER 2026-10-27 m4bad9bdbd3a1: the count in a message's header next to its time,
    // nothing anywhere else but tool and thought lines.
    p.check(`${agent}: each message card shows its own count right after its time`,
      D.owns?.length > 0 && D.owns.every(r => r.afterTime && /^~[\d.]+k?t$/.test(r.text) && /this message: about/.test(r.title)), D.owns)
    p.check(`${agent}: a delivery's last card shows +N for the turn envelope, its parts itemized on hover`,
      D.envelopes?.length > 0 && D.envelopes.length <= D.owns.length && D.envelopes.every(r => r.afterTime
        && /^\+[\d.]+k?t$/.test(r.text) && /surrounding data hidden in the turn envelope/.test(r.title))
      && D.envelopes.some(r => /Org state: about/.test(r.title) && /Provider usage: about/.test(r.title)), D.envelopes)
    p.check(`${agent}: replies, system rows and compactions show no count and nothing sits in the margin`,
      D.margins === 0 && D.stray?.length === 0 && D.inputs?.length > 0, { margins: D.margins, stray: D.stray })
  }
  const X1 = R.desks['codex-worker'] ?? {}
  p.check('the Codex command keeps its estimate on its chip', X1.inputs?.length === 1, { inputs: X1.inputs })
  p.check('the Claude thought shows the thinking Claude reported, and the Codex thought alone a dash',
    R.desks['claude-worker']?.thinking?.some(r => r.text === '20t') && R.desks['codex-worker']?.thinking?.some(r => r.text === '—' && /not reported/.test(r.title)),
    { claude: R.desks['claude-worker']?.thinking, codex: R.desks['codex-worker']?.thinking })
  return p.summary()
}
