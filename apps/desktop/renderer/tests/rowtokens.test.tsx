import test from 'node:test'
import assert from 'node:assert/strict'
import { mountView } from './harness'
import { Msg, ToolChip } from '../src/canvas/desk'
import { transcriptEntries } from '../src/events/systemruns'
import type { ChatMessage } from '../src/types'

// USER 2026-10-27 m4bad9bdbd3a1: "for messages, like user messages, place the count in the
// header, next to the time. or everything else jkust omit it."; m7c48d80b13f4: "the token
// count in the message header should be only that which is directly attributable to my
// message. anything extra should have an extra "+xyt" token count that when hovered explains
// that its from surrounding data hidden in the turn envelope"; md965e01802ba: "ideally
// explaining exactly what components are carried with it"; m90b8a18987ea: "the mail framing
// itself, which always accompanies the mail, should always be included in the first count".
// The engine counts each message as if sent alone, with its framing, and the conditional
// parts sent with it; the desk only draws them.
const text = (el: Element | null | undefined) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim().replace(/^·(?: T)?\s*/, '')
const row = (m: unknown) => m as ChatMessage
const mail = (id: string, from: string, kind: string, body: string, extra: object = {}) => ({ id, from, kind, body, at: '2026-10-27T09:00:00Z',
  message_id: id, operation_id: 'mail:' + id, relationship: from === '@user' ? 'USER' : 'your superior', ...extra })
const folded = mail('n1', '@system', 'status', 'Something changed.', { notice: true })
const tokens = { count: 3400, estimated: true,
  own: [{ id: 'm1', count: 41, estimated: true }, { id: 'm2', count: 60, estimated: true }, { id: 'n1', count: 30, estimated: true }],
  extras: [{ label: 'Org state', count: 1100 }, { label: 'Provider usage', count: 900 }], extra: 2000 }
const delivered = row({ role: 'user', text: 'Start.', seq: 1, segments: [{ kind: 'mail',
  rows: [mail('m1', '@user', 'message', 'Start.'), mail('m2', 'boss', 'message', 'A note.'), folded] }], tokens })

test("a message's header shows its own count next to its time, and the delivery's last card +N for the envelope, itemized", async t => {
  const v = await mountView(<Msg m={delivered} slug="s" nid="a" />, h => h)
  t.after(() => v.unmount())
  const head = (id: string) => v.el.querySelector(`[data-mail-id="${id}"] .turn-mail-head`)
  const own = head('m1')?.querySelector('time + .msg-tokens .own-tokens')
  assert.equal(text(own), '~41t', "the user's message: its own count, right after its time")
  assert.match(own?.getAttribute('title') ?? '', /about 41 tokens, estimated/)
  assert.match(own?.getAttribute('title') ?? '', /framing that always comes with it/)
  assert.equal(head('m1')?.querySelector('.envelope-tokens'), null, 'the envelope is not repeated on every card')
  assert.equal(text(head('m2')?.querySelector('.own-tokens')), '~60t')
  const extra = head('m2')?.querySelector('.envelope-tokens')
  assert.equal(text(extra), '+2kt', "the delivery's last card that is not a folded notice carries the envelope")
  const title = extra?.getAttribute('title') ?? ''
  assert.match(title, /surrounding data hidden in the turn envelope/)
  for (const line of ['Org state: about 1,100', 'Provider usage: about 900']) assert.ok(title.includes(line), line)
  assert.equal(text(head('n1')?.querySelector('.own-tokens')), '~30t', 'a notice card shows its own count too')
  assert.equal(head('n1')?.querySelector('.envelope-tokens'), null)
  assert.equal(v.el.querySelectorAll('.row-tokens, .row-tokens-line').length, 0, 'no count in the margin')
})

test('split into cards, each card keeps its own count and only the last card that is not a folded notice the envelope', async t => {
  const entries = transcriptEntries([delivered])
  assert.equal(entries.length, 3, 'one card per mail')
  assert.deepEqual(entries.map(entry => entry.message.tokens?.own?.length), [3, 3, 3], 'every card finds its own count')
  assert.deepEqual(entries.map(entry => entry.message.tokens?.extra), [undefined, 2000, undefined], 'the envelope once, on the last mail')
  const v = await mountView(<>{entries.map(entry => <div key={entry.key} data-case={entry.key}><Msg m={entry.message} systemPart slug="s" nid="a" /></div>)}</>, h => h)
  t.after(() => v.unmount())
  assert.deepEqual([...v.el.querySelectorAll('.own-tokens')].map(text), ['~41t', '~60t', '~30t'])
  assert.deepEqual([...v.el.querySelectorAll('.envelope-tokens')].map(text), ['+2kt'])
  assert.ok(v.el.querySelector('[data-mail-id="m2"] .envelope-tokens'), 'on the last mail')
})

test('rows without a timed header show no count; tool calls and thoughts keep their inline counts', async t => {
  const v = await mountView(<>
    <div data-case="reply"><Msg m={row({ role: 'assistant', text: 'Done.', tokens: { count: 412, reported: 'Claude' } })} slug="s" nid="a" /></div>
    <div data-case="estimate"><Msg m={row({ role: 'assistant', text: 'Working on it.', tokens: { count: 1234, estimated: true, covers: 'text and tool calls' } })} slug="s" nid="a" /></div>
    <div data-case="system"><Msg m={row({ role: 'system', kind: 'session', text: 'The session ended.', tokens: { not_counted: 'not sent to the agent' } })} slug="s" nid="a" /></div>
    <div data-case="compact"><Msg m={row({ role: 'system', kind: 'compact', text: 'Context compacted', compact_state: 'done', pre_tokens: 150000,
      tokens: { not_counted: 'the provider keeps the compaction summary' } })} slug="s" nid="a" /></div>
    <div data-case="old-mail"><Msg m={row({ role: 'user', text: 'Start.', segments: [{ kind: 'mail', rows: [mail('o1', '@user', 'message', 'Start.')] }],
      tokens: { count: 3400, estimated: true, parts: [{ label: 'Org state', count: 1100 }] } })} slug="s" nid="a" /></div>
    <div data-case="tool"><ToolChip t={{ id: 'c1', name: 'Bash', result: 'ok', input_tokens: 120, input_tokens_estimated: true, output_tokens: 40,
      output_tokens_estimated: true, started_at: '2026-10-27T09:00:00Z', ended_at: '2026-10-27T09:00:01Z' }} slug="s" nid="a" /></div>
    <div data-case="thought"><Msg m={row({ role: 'assistant', text: 'Answer.', thinking: 'Considering.', thinking_tokens: 30, tokens: { count: 50, reported: 'Claude' } })} slug="s" nid="a" /></div>
    <div data-case="unreported"><Msg m={row({ role: 'assistant', text: 'Answer.', thinking: 'Considering.', tokens: { count: 50, estimated: true } })} slug="s" nid="a" /></div>
  </>, h => h)
  t.after(() => v.unmount())
  const at = (c: string, selector: string) => [...v.el.querySelectorAll(`[data-case="${c}"] ${selector}`)]
  for (const c of ['reply', 'estimate', 'system', 'compact'])
    assert.equal(at(c, '.token-count').length, 0, `${c}: no header, no count`)
  assert.equal(at('old-mail', '.token-count').length, 0, 'a message delivered before own counts shows none: its stored total mixed in the envelope')
  assert.equal(text(at('tool', '.tool-input-tokens')[0]), '~120t', 'the tool call keeps its input count')
  assert.ok(at('tool', '.tool-output-tokens').length, 'and its result count')
  assert.deepEqual(at('thought', '.token-count').map(text), ['30t'], 'a thought keeps the thinking reported for it, and the reply shows nothing')
  assert.equal(text(at('unreported', '.thinking-tokens')[0]), '—', 'unreported thinking says so instead of 0')
  assert.equal(at('unreported', '.token-count').length, 1)
})
