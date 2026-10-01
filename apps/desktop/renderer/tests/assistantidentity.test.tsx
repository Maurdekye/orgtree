import { FakeServer, advance, flush, inAct, installFetch, mountView, realClock, useFakeClock } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { DeskChat } from '../src/canvas/desk'
import { ingestStream, loadOlder, refreshConvo, resetConvos, useConvo } from '../src/convo'
import { applyAssistantDelta, mergeAssistantRows } from '../src/assistantMessages'
import type { ChatMessage, ChatPayload, OpResult } from '../src/types'
import type { CanvasNode } from '../src/canvas/shared'

const partial = (id: string, text: string, revision = 1): ChatMessage => ({
  role: 'assistant', text, ts: new Date(Date.now()).toISOString(),
  assistant_id: id, assistant_ids: [id], assistant_scope: 'scope',
  assistant_revision: revision, assistant_state: 'partial', assistant_pending: true,
  row_id: id, event_id: `reply:${id}:${revision}`,
})
const complete = (id: string, text: string, revision = 3): ChatMessage => ({
  ...partial(id, text, revision), assistant_state: 'complete',
})
const native = (id: string, text: string, seq = 1): ChatMessage => ({
  ...complete(id, text, 0), assistant_pending: undefined, seq,
  native_event_id: `native:${id}`, event_id: `native-reply:${id}`,
})
const rows = (el: HTMLElement) => [...el.querySelectorAll<HTMLElement>('[data-assistant-id]')]
const text = (el: HTMLElement) => rows(el).map(row => (row.querySelector('.msgtext')?.textContent ?? '').trim())

test('revision order, completion, native receipt and multi-block aliases are independent of arrival', () => {
  const snapshots = [partial('a', 'one'), partial('a', 'one two', 2), complete('a', 'one two three')]
  for (const order of [snapshots, [...snapshots].reverse(), [snapshots[1]!, snapshots[0]!, snapshots[2]!]]) {
    assert.deepEqual(mergeAssistantRows([...order, ...order]).map(row => row.text), ['one two three'])
  }
  assert.equal(mergeAssistantRows([native('a', 'native'), partial('a', 'late', 999)])[0]!.text, 'native')
  const multi = { ...native('a', 'left right'), assistant_ids: ['a', 'b'] }
  for (const order of [[partial('a', 'left'), partial('b', 'right'), multi],
    [multi, partial('b', 'right'), partial('a', 'left')]]) {
    assert.deepEqual(mergeAssistantRows(order).map(row => row.text), ['left right'])
  }
  assert.equal(mergeAssistantRows([native('a', 'same'), native('b', 'same')]).length, 2)
  assert.equal(mergeAssistantRows([{role:'assistant',text:'same'}, {role:'assistant',text:'same'}]).length, 2)
})

let sequence = 0
function lifecycle(name: string, run: (ctx: {
  id: string; server: FakeServer; transport: ReturnType<typeof installFetch>;
  el: HTMLElement; emit: (row: ChatMessage) => Promise<void>;
  refresh: () => Promise<void>; renderStates: ChatPayload[];
  mount: () => ReturnType<typeof mountView<string[]>>;
}) => Promise<void>) {
  test(name, async t => {
    useFakeClock()
    const id = `assistant-${++sequence}`
    const server = new FakeServer()
    server.busy = true
    const chat = server.chat.bind(server)
    server.chat = last => ({ ...chat(last), assistant_identity: 1, assistant_scope: 'scope' })
    const transport = installFetch(server)
    const node = { id, state:'live', tier:'haiku', children:[], seat:1, grant:0, free:0,
      scope:{tools:{},add_dirs:[]}, model_id:'haiku' } as CanvasNode
    const renderStates: ChatPayload[] = []
    function Sink() {
      const convo = useConvo('org', id)
      if (convo.chat) renderStates.push(convo.chat)
      return null
    }
    const views: Array<{unmount: () => Promise<void>}> = []
    const mount = async () => {
      const view = await mountView(<><Sink /><DeskChat node={node} map={new Map([[id,node]])}
        op={() => Promise.resolve({} as OpResult)} slug="org" toast={() => {}} pub={false} bare /></>, text)
      views.push(view)
      return view
    }
    t.after(async () => {
      for (const view of views) await view.unmount()
      resetConvos()
      realClock()
    })
    await refreshConvo('org', id)
    const view = await mount()
    await flush()
    await run({id, server, transport, el:view.el, renderStates, mount,
      emit: row => inAct(() => ingestStream('org', {node:id, kind: row.assistant_state === 'complete' ? 'text' : 'delta',
        text: row.text, assistant_row: row, t:Date.now()})),
      refresh: () => inAct(() => refreshConvo('org', id, {force:true})),
    })
  })
}

lifecycle('one DOM row grows through duplicate/reordered deltas, completion and transcript replacement',
  async ({el, server, emit, refresh, renderStates}) => {
    await emit(partial('a', 'first'))
    const original = rows(el)[0]
    assert.ok(original)
    await emit(partial('a', 'first second', 2))
    await emit(partial('a', 'first', 1))
    await emit(partial('a', 'first second', 2))
    assert.deepEqual(text(el), ['first second'])
    await emit(complete('a', 'first second final'))
    assert.equal(rows(el)[0], original, 'completion updates the existing DOM node')
    server.messages = [native('a', 'first second final')]
    await refresh()
    assert.equal(rows(el)[0], original, 'native handover preserves the DOM node')
    await emit(partial('a', 'late duplicate delta', 100))
    assert.deepEqual(text(el), ['first second final'])
    for (const state of renderStates.filter(s => s.messages.some(m => m.assistant_id === 'a'))) {
      assert.equal(state.messages.filter(m => m.assistant_id === 'a').length, 1)
    }
  })

lifecycle('a fetched partial cannot roll back a newer websocket revision',
  async ({el, server, transport, id, emit}) => {
    server.messages = [partial('a', 'stale fetch', 1)]
    transport.holdAll = true
    const pending = refreshConvo('org', id, {force:true})
    await emit(partial('a', 'newer websocket', 2))
    await inAct(async () => { transport.release(); await pending })
    assert.deepEqual(text(el), ['newer websocket'])
    transport.holdAll = false
  })

lifecycle('native transcript before completion and late events after paging never resurrect old prose',
  async ({el, server, emit, refresh}) => {
    await emit(partial('a', 'partial'))
    server.messages = [native('a', 'complete')]
    await refresh()
    await emit(complete('a', 'complete'))
    assert.deepEqual(text(el), ['complete'])
    server.messages = Array.from({length:12}, (_, i) => native(`n${i}`, `later ${i}`, i+2))
    await refresh()
    await emit(partial('a', 'old replay', 99))
    assert.ok(!text(el).includes('old replay'))
    assert.equal(rows(el).some(row => row.dataset.assistantId === 'a'), false)
  })

lifecycle('completion of A does not retire a distinct identical message B',
  async ({el, server, emit, refresh}) => {
    await emit(partial('a', 'same words'))
    await emit(partial('b', 'same words'))
    await emit(complete('a', 'same words'))
    server.messages = [native('a', 'same words')]
    await refresh()
    assert.deepEqual(text(el), ['same words', 'same words'])
    await emit(complete('b', 'same words'))
    server.messages.push(native('b', 'same words', 2))
    await refresh()
    assert.deepEqual(text(el), ['same words', 'same words'])
    assert.equal(rows(el).length, 2)
  })

lifecycle('a server receipt suppresses late frames even when this window never saw the saved row',
  async ({el, server, emit, refresh}) => {
    server.messages = [native('new', 'current page')]
    await refresh()
    await emit({...partial('old', 'late old partial'), assistant_materialized:true})
    await emit(partial('old', 'another delayed frame', 2))
    assert.deepEqual(text(el), ['current page'])
    await emit(partial('active', 'active partial'))
    server.messages.push(native('active', 'active final', 2))
    await emit({...complete('active', 'active final'), assistant_materialized:true})
    await refresh()
    assert.deepEqual(text(el), ['current page', 'active final'])
  })

lifecycle('reconnect, missed frames, idle and two windows reconstruct the same retained partial',
  async ({el, server, emit, refresh, mount}) => {
    await emit(partial('a', 'survives interruption'))
    server.messages = [partial('a', 'survives interruption')]
    server.busy = false
    server.instance = 'restart'
    await refresh()
    await inAct(() => resetConvos()) // a reload reconstructs from durable snapshots
    await refresh()
    const other = await mount()
    assert.deepEqual(text(el), ['survives interruption'])
    assert.deepEqual(other.last(), text(el))
    server.messages = [native('a', 'completed on resume')]
    await refresh() // completion frame was never delivered
    assert.deepEqual(text(el), ['completed on resume'])
    assert.deepEqual(other.last(), text(el))
  })

lifecycle('an older page replaces an already-retained partial with the same row id',
  async ({el, server, id, emit, refresh}) => {
    server.cursorPages = true
    server.messages = Array.from({length:20}, (_, i) => native(`n${i}`, `later ${i}`, i+2))
    await refresh()
    await emit({...partial('old', 'retained partial'), row_id:'mock-1', seq:1})
    server.messages.unshift(native('old', 'native completion', 1))
    await inAct(() => { assert.equal(loadOlder('org', id, 30), true) })
    await flush()
    assert.ok(text(el).includes('native completion'))
    assert.ok(!text(el).includes('retained partial'))
    assert.equal(rows(el).filter(row => row.dataset.assistantId === 'old').length, 1)
    await emit(partial('old', 'late replay', 99))
    assert.ok(!text(el).includes('late replay'))
  })

lifecycle('scope changes reject old session snapshots while preserving current content',
  async ({el, server, emit, refresh}) => {
    await emit(partial('old', 'old session'))
    const chat = server.chat.bind(server)
    server.chat = last => ({...chat(last), assistant_scope:'new-scope', conversation_id:'new-session'})
    server.messages = [{...native('new', 'new session'), assistant_scope:'new-scope'}]
    await refresh()
    await emit(partial('old', 'late old session'))
    assert.deepEqual(text(el), ['new session'])
  })

// ---- delta frames (supervisor.wire_reply_frame): only the text added since
// assistant_base_revision rides the frame, not the whole message so far
const delta = (id: string, fragment: string, revision: number, quote?: string): ChatMessage => {
  const row: ChatMessage = { ...partial(id, fragment, revision), assistant_delta: true,
    assistant_base_revision: revision - 1 }
  if (quote === undefined) delete row.reply_quote
  else row.reply_quote = quote
  return row
}

test('a delta applies only on the revision it names', () => {
  const base = { ...partial('a', 'one ', 1), reply_quote: 'one ' }
  const next = applyAssistantDelta(base, delta('a', 'two', 2, 'one two'))
  assert.ok(typeof next !== 'string')
  assert.equal(next.text, 'one two')
  assert.equal(next.reply_quote, 'one two')
  assert.equal(next.assistant_revision, 2)
  assert.equal(next.assistant_delta, undefined)
  assert.equal(next.assistant_base_revision, undefined)
  const kept = applyAssistantDelta(next, delta('a', ' three', 3))
  assert.ok(typeof kept !== 'string')
  assert.equal(kept.reply_quote, 'one two', 'an absent quote keeps the one held')
  assert.equal(applyAssistantDelta(next, delta('a', 'two', 2)), 'stale')
  assert.equal(applyAssistantDelta(next, delta('a', 'x', 4)), 'gap')
  assert.equal(applyAssistantDelta(undefined, delta('a', 'x', 2)), 'gap')
  assert.equal(applyAssistantDelta(complete('a', 'done', 1), delta('a', 'x', 2)), 'stale')
  assert.equal(applyAssistantDelta(native('a', 'done'), delta('a', 'x', 2)), 'stale')
})

lifecycle('delta frames grow one row; duplicates and reordered old deltas change nothing',
  async ({el, emit}) => {
    await emit(partial('a', 'one '))
    const original = rows(el)[0]
    await emit(delta('a', 'two ', 2))
    await emit(delta('a', 'three', 3))
    assert.deepEqual(text(el), ['one two three'])
    await emit(delta('a', 'three', 3))
    await emit(delta('a', 'two ', 2))
    assert.deepEqual(text(el), ['one two three'])
    assert.equal(rows(el)[0], original)
    await emit(complete('a', 'one two three!', 4))
    assert.deepEqual(text(el), ['one two three!'])
    await emit(delta('a', ' late', 5))
    assert.deepEqual(text(el), ['one two three!'])
  })

lifecycle('a missed delta refetches once and chains the held deltas onto the fetched row',
  async ({el, server, transport, emit}) => {
    await emit(partial('a', 'one '))
    const before = transport.requests
    server.messages = [partial('a', 'one two ', 2)]
    await emit(delta('a', 'three ', 3))
    await emit(delta('a', 'four', 4))
    assert.deepEqual(text(el), ['one'], 'never shows text with a hole in it')
    await inAct(() => advance(1000))
    await flush()
    assert.ok(transport.requests > before, 'the gap asked for the chat')
    assert.deepEqual(text(el), ['one two three four'])
    await emit(delta('a', '!', 5))
    assert.deepEqual(text(el), ['one two three four!'])
  })

lifecycle('a held delta chains when its base arrives late on the websocket',
  async ({el, emit}) => {
    await emit(partial('a', 'one '))
    await emit(delta('a', 'three', 3))
    assert.deepEqual(text(el), ['one'])
    await emit(delta('a', 'two ', 2))
    assert.deepEqual(text(el), ['one two three'])
  })

lifecycle('a client that joins mid-reply takes the text from the fetch',
  async ({el, server, emit}) => {
    server.messages = [partial('a', 'one two three', 3)]
    await emit(delta('a', ' five', 5))
    await emit(delta('a', 'three', 3))
    await inAct(() => advance(1000))
    await flush()
    assert.deepEqual(text(el), ['one two three'])
    await emit(delta('a', ' four', 4))
    assert.deepEqual(text(el), ['one two three four five'], 'the held rev 5 chains on')
  })
