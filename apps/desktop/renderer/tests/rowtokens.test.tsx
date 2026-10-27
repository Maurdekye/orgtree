import test from 'node:test'
import assert from 'node:assert/strict'
import { mountView } from './harness'
import { Msg, ToolChip } from '../src/canvas/desk'
import { transcriptEntries } from '../src/events/systemruns'
import type { ChatMessage } from '../src/types'

// USER 2026-10-27 m10e4ca6d8934: "token counts in messages of all kinds (agent, monitor
// event, system, etc)"; mafe020c4912b: "and user messages". Counts come from the engine:
// reported where the provider gives one, otherwise estimated and marked ~, and a row
// that is not counted says why instead of showing 0.
const text = (el: Element | null | undefined) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim().replace(/^·(?: T)?\s*/, '')
const row = (m: unknown) => m as ChatMessage
const mail = (id: string, from: string, kind: string, body: string) => ({ id, from, kind, body, at: '2026-10-27T09:00:00Z',
  message_id: id, operation_id: 'mail:' + id, relationship: from === '@user' ? 'USER' : 'your superior' })

test('every row kind shows its token count: reported plainly, estimated with ~, and why when not counted', async t => {
  const v = await mountView(<>
    <div data-case="reply"><Msg m={row({ role: 'assistant', text: 'Done.', tokens: { count: 412, reported: 'Claude' } })} slug="s" nid="a" /></div>
    <div data-case="estimate"><Msg m={row({ role: 'assistant', text: 'Working on it.', tokens: { count: 1234, estimated: true, covers: 'text and tool calls' } })} slug="s" nid="a" /></div>
    <div data-case="mail"><Msg m={row({ role: 'user', text: 'Start.', segments: [{ kind: 'mail', rows: [mail('m1', '@user', 'message', 'Start.'), mail('m2', '@system', 'notice', 'A watchdog fired.')] }],
      tokens: { count: 3400, estimated: true, parts: [{ label: 'Org state', count: 1100 }, { label: 'Provider usage', count: 900 },
        { label: 'Mail from user', count: 1200 }, { label: 'Notice from orgtree', count: 200 }] } })} slug="s" nid="a" /></div>
    <div data-case="system"><Msg m={row({ role: 'system', kind: 'session', text: 'The session ended.', tokens: { not_counted: 'not sent to the agent' } })} slug="s" nid="a" /></div>
    <div data-case="compact"><Msg m={row({ role: 'system', kind: 'compact', text: 'Context compacted', compact_state: 'done', pre_tokens: 150000,
      tokens: { not_counted: 'the provider keeps the compaction summary' } })} slug="s" nid="a" /></div>
    <div data-case="legacy"><Msg m={row({ role: 'assistant', text: 'Before this version.' })} slug="s" nid="a" /></div>
  </>, h => h)
  t.after(() => v.unmount())
  const count = (c: string) => v.el.querySelector(`[data-case="${c}"] .row-tokens`)
  assert.equal(text(count('reply')), '412t', 'a reported count shows plainly')
  assert.match(count('reply')?.getAttribute('title') ?? '', /412 output tokens reported by Claude/)
  assert.equal(text(count('estimate')), '~1.2kt', 'an estimate is marked ~')
  assert.match(count('estimate')?.getAttribute('title') ?? '', /about 1,234 tokens, estimated/)
  assert.match(count('estimate')?.getAttribute('title') ?? '', /text and tool calls/)
  assert.equal(text(count('mail')), '~3.4kt', 'a delivered message counts everything the agent was sent')
  const parts = count('mail')?.getAttribute('title') ?? ''
  for (const line of ['Org state: about 1,100', 'Provider usage: about 900', 'Mail from user: about 1,200', 'Notice from orgtree: about 200'])
    assert.ok(parts.includes(line), line)
  assert.equal(text(count('system')), '—', 'a row that is not counted never shows 0')
  assert.match(count('system')?.getAttribute('title') ?? '', /not sent to the agent/)
  assert.match(count('compact')?.getAttribute('title') ?? '', /the provider keeps the compaction summary/)
  assert.match(count('compact')?.getAttribute('title') ?? '', /150,000 tokens before/, 'the reported context size before a compaction is kept')
  assert.equal(count('legacy'), null, 'a row from before token counts shows nothing')
})

test('tool calls show their input count beside the result count, and unreported thinking says so', async t => {
  const v = await mountView(<>
    <ToolChip t={{ id: 'c1', name: 'Bash', result: 'ok', input_tokens: 120, input_tokens_estimated: true, output_tokens: 40,
      output_tokens_estimated: true, started_at: '2026-10-27T09:00:00Z', ended_at: '2026-10-27T09:00:01Z' }} slug="s" nid="a" />
    <div data-case="thought"><Msg m={row({ role: 'assistant', text: 'Answer.', thinking: 'Considering.', tokens: { count: 50, estimated: true, covers: 'text and tool calls' } })} slug="s" nid="a" /></div>
    <div data-case="old-thought"><Msg m={row({ role: 'assistant', text: 'Answer.', thinking: 'Considering.' })} slug="s" nid="a" /></div>
  </>, h => h)
  t.after(() => v.unmount())
  const input = v.el.querySelector('.tool-input-tokens')
  assert.equal(text(input), '~120t', 'the call input count')
  assert.match(input?.getAttribute('title') ?? '', /tool call: about 120 tokens, estimated/)
  assert.ok(v.el.querySelector('.tool-output-tokens'), 'the result count stays')
  const thought = v.el.querySelector('[data-case="thought"] .thinking-tokens')
  assert.equal(text(thought), '—', 'thinking without a reported count says so instead of 0')
  assert.match(thought?.getAttribute('title') ?? '', /thinking tokens were not reported/)
  assert.equal(v.el.querySelector('[data-case="old-thought"] .thinking-tokens'), null, 'old rows stay blank')
})

test('a thought alone shows its count once, on its thought line', async t => {
  const v = await mountView(<>
    <div data-case="unreported"><Msg m={row({ role: 'assistant', text: '', tools: [], thinking: 'Planning.',
      tokens: { not_counted: 'thinking tokens were not reported for this response' } })} slug="s" nid="a" /></div>
    <div data-case="reported"><Msg m={row({ role: 'assistant', text: '', tools: [], thinking: 'Planning.', thinking_tokens: 30,
      tokens: { count: 30, reported: 'Codex' } })} slug="s" nid="a" /></div>
  </>, h => h)
  t.after(() => v.unmount())
  const at = (c: string, selector: string) => [...v.el.querySelectorAll(`[data-case="${c}"] ${selector}`)]
  assert.equal(text(at('unreported', '.thinking-tokens')[0]), '—', 'a thought whose tokens were not reported says so')
  assert.match(at('unreported', '.thinking-tokens')[0]?.getAttribute('title') ?? '', /thinking tokens were not reported/)
  assert.equal(at('unreported', '.row-tokens').length, 0, 'and its row shows no second dash')
  assert.equal(text(at('reported', '.thinking-tokens')[0]), '30t', 'the reasoning the provider reported')
  assert.equal(at('reported', '.row-tokens').length, 0, 'shown once')
})

test('a delivered message split into cards shows its one count once, not on a folded notice', () => {
  const folded = { id: 'n1', from: '@system', kind: 'status', notice: true, body: 'Something changed.', at: '2026-10-27T09:00:00Z' }
  const entries = transcriptEntries([row({ role: 'user', text: 'Start.', seq: 1, segments: [{ kind: 'mail',
    rows: [mail('m1', '@user', 'message', 'Start.'), mail('m2', 'boss', 'message', 'A note.'), folded] }], tokens: { count: 900, estimated: true } })])
  assert.equal(entries.length, 3, 'one card per mail')
  assert.deepEqual(entries.map(entry => !!entry.message.tokens), [false, true, false], 'on the last mail, not under the folded notice')
})

test('a lone tool call shows its estimate once, on its chip; several calls keep the row total', async t => {
  const chip = (id: string, n: number) => ({ id, name: 'exec_command', input_tokens: n, input_tokens_estimated: true, result: 'ok',
    started_at: '2026-10-27T09:00:00Z', ended_at: '2026-10-27T09:00:01Z' })
  const v = await mountView(<>
    <div data-case="lone"><Msg m={row({ role: 'assistant', text: '', tools: [chip('c1', 50)], tokens: { count: 50, estimated: true, covers: 'tool calls' } })} slug="s" nid="a" /></div>
    <div data-case="two"><Msg m={row({ role: 'assistant', text: '', tools: [chip('c2', 50), chip('c3', 40)], tokens: { count: 90, estimated: true, covers: 'tool calls' } })} slug="s" nid="a" /></div>
  </>, h => h)
  t.after(() => v.unmount())
  const at = (c: string, selector: string) => [...v.el.querySelectorAll(`[data-case="${c}"] ${selector}`)]
  assert.equal(text(at('lone', '.tool-input-tokens')[0]), '~50t', 'the call shows its input count')
  assert.equal(at('lone', '.row-tokens').length, 0, 'and its row does not repeat it')
  assert.equal(text(at('two', '.row-tokens')[0]), '~90t', 'several calls keep the row total')
})
