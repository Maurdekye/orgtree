// foldpersist.test.tsx — AN EXPANDED TRANSCRIPT MESSAGE STAYS EXPANDED
// (user bug 2026-09-12: a message the operator had opened collapsed itself as
// soon as the next event arrived, in the middle of being read).
//
// THE MECHANISM, read from the source rather than guessed at:
//   · every fold — a tool chip's result, a thought, a compaction summary —
//     kept its open/closed flag in its own component `useState`;
//   · that state lives exactly as long as the component instance does, and an
//     instance lives exactly as long as its React key;
//   · the transcript row's key is `assistant_id ?? native_event_id ?? row_id
//     ?? event_id ?? seq ?? index` (desk.tsx), which is not ONE identity. A
//     streaming assistant row is keyed by its assistant_id; when the durable
//     projection replaces it the key becomes its native_event_id. Different
//     key → React unmounts the subtree and mounts a new one → every fold
//     inside it snaps shut.
// The fix moves the flags into the desk, keyed by each part's own durable id
// (canvas/foldstate.tsx). §1-§4 are the collapse itself; §5-§7 are the rest of
// the contract — an explicit collapse still collapses, one chip's fold is not
// another's, and a message that genuinely leaves takes its state with it.
//
// ANTI-VACUITY: §5 and §6 fail for anything that simply forces folds open or
// shares one flag between rows, and §1's first assertion (the click really did
// expand it) guards every later "still expanded".
//
// Run:  node apps/desktop/renderer/tests/run.mjs foldpersist

import test from 'node:test'
import assert from 'node:assert/strict'
import { FakeServer, flush, inAct, installFetch, mountView } from './harness'
import { DeskChat } from '../src/canvas/desk'
import type { CanvasNode } from '../src/canvas/shared'
import { refreshConvo, resetConvos } from '../src/convo'
import type { ChatMessage } from '../src/types'

const writer: CanvasNode = { id: 'writer', generation: 2, state: 'live', tier: 'haiku',
  children: [], seat: 1, grant: 0, free: 0, scope: { tools: {}, add_dirs: [] } }

interface Mounted {
  el: HTMLElement
  server: FakeServer
  /** the next poll lands — what "a new event arrives" is, for this desk */
  poll: () => Promise<void>
  unmount: () => Promise<void>
}

async function desk(messages: ChatMessage[]): Promise<Mounted> {
  localStorage.clear(); resetConvos()
  const server = new FakeServer()
  server.messages = messages
  installFetch(server)
  const view = await mountView(
    <DeskChat node={writer} map={new Map([[writer.id, writer]])} slug="org"
      op={async () => ({})} toast={() => {}} pub={false} bare />, el => el)
  await inAct(async () => { await refreshConvo('org', 'writer'); await flush(5) })
  return {
    el: view.el, server,
    poll: async () => { await inAct(async () => { await refreshConvo('org', 'writer'); await flush(5) }) },
    unmount: async () => { await view.unmount(); resetConvos() },
  }
}

const chip = (m: Mounted, arg: string) =>
  [...m.el.querySelectorAll('.tchip .tline')]
    .find(l => (l.textContent ?? '').includes(arg)) as HTMLElement | undefined
/** every tool result currently UNFOLDED, by its text */
const shownResults = (m: Mounted) =>
  [...m.el.querySelectorAll('.respre')].map(p => p.textContent ?? '')
const shownThoughts = (m: Mounted) =>
  [...m.el.querySelectorAll('.thoughtbody')].map(p => p.textContent ?? '')
const shownSummaries = (m: Mounted) =>
  [...m.el.querySelectorAll('.msg.sys .filepre')].map(p => p.textContent ?? '')

async function click(el: Element | undefined, what: string): Promise<void> {
  assert.ok(el, `nothing to click for ${what}`)
  await inAct(() => { (el as HTMLElement).click() })
  await flush(2)
}

/** an assistant row carrying one tool chip with a result behind the fold */
const toolRow = (over: Partial<ChatMessage> = {}, arg = 'ls', result = 'THE-RESULT'): ChatMessage => ({
  role: 'assistant', text: 'working', seq: 1, event_id: 'reply-1',
  tools: [{ name: 'Bash', arg, id: 'tu-' + arg, result, result_lines: 1 }],
  ...over,
})

// ─────────────────────────────────────────────── §1 the reported collapse

test('§1 THE BUG: an expanded chip survives the row being re-keyed mid-stream',
  async () => {
    // the row arrives as a streaming assistant snapshot — keyed by
    // assistant_id — and is then replaced by its durable projection, keyed by
    // native_event_id. That re-key is what used to throw the fold away.
    const m = await desk([
      { role: 'user', text: 'go', seq: 0, event_id: 'ask-1' },
      toolRow({ assistant_id: 'as-1', assistant_revision: 1, assistant_state: 'partial',
        assistant_pending: true, assistant_scope: 'turn', event_id: undefined }),
    ])
    try {
      await click(chip(m, 'ls'), 'the tool chip')
      assert.deepEqual(shownResults(m), ['THE-RESULT'], 'the click expanded it')
      m.server.messages[1] = toolRow({ native_event_id: 'nat-1', assistant_state: 'complete' })
      m.server.assistantMsg('and the turn goes on', { event_id: 'reply-2' })
      await m.poll()
      assert.deepEqual(shownResults(m), ['THE-RESULT'],
        'the message collapsed itself when the next event arrived')
    } finally { await m.unmount() }
  })

test('§1b a plain append leaves it open too', async () => {
  const m = await desk([{ role: 'user', text: 'go', seq: 0, event_id: 'ask-1' }, toolRow()])
  try {
    await click(chip(m, 'ls'), 'the tool chip')
    assert.deepEqual(shownResults(m), ['THE-RESULT'])
    for (let i = 0; i < 5; i++) m.server.assistantMsg('filler ' + i, { event_id: 'f' + i })
    await m.poll()
    assert.deepEqual(shownResults(m), ['THE-RESULT'], 'five appends closed it')
  } finally { await m.unmount() }
})

test('§1c …and so does a PREPEND, which renames every row below it', async () => {
  // a row with no durable id of its own falls through to the index key, so
  // prepending renames it. The chip's own tool_use_id does not move.
  const m = await desk([
    { role: 'user', text: 'go', seq: 0 },
    toolRow({ seq: undefined, event_id: undefined }),
  ])
  try {
    await click(chip(m, 'ls'), 'the tool chip')
    assert.deepEqual(shownResults(m), ['THE-RESULT'])
    m.server.messages.unshift({ role: 'assistant', text: 'an earlier page', seq: -1 })
    await m.poll()
    assert.deepEqual(shownResults(m), ['THE-RESULT'], 'a prepend closed it')
  } finally { await m.unmount() }
})

// ────────────────────────────────────────── §2 the other two foldable parts

test('§2 an open THOUGHT survives the same re-key', async () => {
  const m = await desk([
    { role: 'assistant', text: 'done', seq: 0, assistant_id: 'as-1',
      assistant_revision: 1, assistant_state: 'partial', assistant_pending: true,
      assistant_scope: 'turn', thinking: 'THE-REASONING', thinking_event_id: 'th-1',
      think_secs: 3 },
  ])
  try {
    await click(m.el.querySelector('.thoughtline') ?? undefined, 'the thought line')
    assert.deepEqual(shownThoughts(m), ['THE-REASONING'])
    m.server.messages[0] = { role: 'assistant', text: 'done', seq: 0,
      native_event_id: 'nat-1', event_id: 'reply-1', thinking: 'THE-REASONING',
      thinking_event_id: 'th-1', think_secs: 3 }
    await m.poll()
    assert.deepEqual(shownThoughts(m), ['THE-REASONING'], 'the thought re-folded itself')
  } finally { await m.unmount() }
})

test('§2b an open COMPACTION SUMMARY survives an append', async () => {
  const m = await desk([
    { role: 'system', text: 'compacted', seq: 0, event_id: 'sys-1', summary: 'THE-SUMMARY' },
  ])
  try {
    await click(m.el.querySelector('.msg.sys.click') ?? undefined, 'the compaction line')
    assert.deepEqual(shownSummaries(m), ['THE-SUMMARY'])
    m.server.assistantMsg('a new turn begins', { event_id: 'reply-2' })
    await m.poll()
    assert.deepEqual(shownSummaries(m), ['THE-SUMMARY'], 'the summary re-folded itself')
  } finally { await m.unmount() }
})

// ──────────────────────────────────────────────── §3 identity, not position

test('§3 the fold belongs to the CHIP, not to its place in the list',
  async () => {
    // two chips on one row: open the second, then prepend a message so every
    // row moves. Position moved; identity did not.
    const m = await desk([
      { role: 'assistant', text: 'working', seq: 1, event_id: 'reply-1', tools: [
        { name: 'Bash', arg: 'one', id: 'tu-one', result: 'FIRST', result_lines: 1 },
        { name: 'Bash', arg: 'two', id: 'tu-two', result: 'SECOND', result_lines: 1 },
      ] },
    ])
    try {
      await click(chip(m, 'two'), 'the second chip')
      assert.deepEqual(shownResults(m), ['SECOND'], 'only the chip that was clicked')
      m.server.messages.unshift({ role: 'user', text: 'earlier', seq: 0, event_id: 'ask-0' })
      await m.poll()
      assert.deepEqual(shownResults(m), ['SECOND'],
        'the fold moved to another chip, or was lost, when the list shifted')
    } finally { await m.unmount() }
  })

// ────────────────────────────────────────────── §4 the operator still rules

test('§4 an explicit collapse still collapses — and stays collapsed', async () => {
  const m = await desk([toolRow()])
  try {
    await click(chip(m, 'ls'), 'the tool chip')
    assert.deepEqual(shownResults(m), ['THE-RESULT'])
    await click(chip(m, 'ls'), 'the tool chip again')
    assert.deepEqual(shownResults(m), [], 'a second click must close it')
    m.server.assistantMsg('a new event', { event_id: 'reply-2' })
    await m.poll()
    assert.deepEqual(shownResults(m), [],
      'a new event re-opened something the operator had closed')
  } finally { await m.unmount() }
})

test('§4b a chip nobody opened stays closed through every update', async () => {
  const m = await desk([toolRow()])
  try {
    assert.deepEqual(shownResults(m), [], 'nothing starts open')
    m.server.assistantMsg('a new event', { event_id: 'reply-2' })
    await m.poll()
    assert.deepEqual(shownResults(m), [])
  } finally { await m.unmount() }
})

// ─────────────────────────────────────────── §5 nothing stale is kept alive

test('§5 a message that genuinely leaves the transcript keeps nothing behind',
  async () => {
    const m = await desk([toolRow()])
    try {
      await click(chip(m, 'ls'), 'the tool chip')
      assert.deepEqual(shownResults(m), ['THE-RESULT'])
      // the row leaves — and then an identically-shaped one arrives. If the
      // desk had kept the old fold, this would come back already open.
      m.server.messages = [{ role: 'assistant', text: 'a different turn', seq: 2,
        event_id: 'reply-2' }]
      await m.poll()
      assert.deepEqual(shownResults(m), [], 'the row left; so did its result')
      m.server.messages.push(toolRow({ seq: 3, event_id: 'reply-3' }))
      await m.poll()
      assert.deepEqual(shownResults(m), [],
        'a returning chip opened itself from state that should have been swept')
    } finally { await m.unmount() }
  })
