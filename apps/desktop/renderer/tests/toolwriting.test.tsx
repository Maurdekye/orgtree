import { advance, FakeServer, flush, inAct, installFetch, mountView, realClock, useFakeClock } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { ToolTimes, ToolWritingLine, TurnActiveContext } from '../src/canvas/toolclock'
import { ingestStream, refreshConvo, resetConvos, useConvo } from '../src/convo'
import type { ChatMessage, ChatTransient } from '../src/types'

test('writing appears immediately with name and pencil; completed and reloaded call retains two times', async t => {
  useFakeClock()
  const start = new Date(Date.now()).toISOString()
  const view = await mountView(<ToolWritingLine name="orgtree_message" startedAt={start} />, el => el.textContent ?? '')
  t.after(async () => { await view.unmount(); realClock() })
  assert.match(view.last(), /Writing orgtree_message/)
  assert.match(view.last(), /0 ms/)
  assert.ok(view.el.querySelector('[data-testid="EditOutlinedIcon"]'))
  await advance(3000)
  assert.match(view.last(), /3.0s/)
  const chip = JSON.parse(JSON.stringify({ name: 'orgtree_message', writing_secs: 3,
    started_at: start, ended_at: new Date(Date.parse(start) + 200).toISOString(), result: 'sent' }))
  await view.render(<ToolTimes tool={chip} />)
  assert.match(view.last(), /written in 3.0s/)
  assert.match(view.last(), /ran for 200 ms/)
  assert.ok(view.el.querySelector('[aria-label="written in 3.0s"] [data-testid="EditOutlinedIcon"]'))
  assert.ok(view.el.querySelector('[aria-label="ran for 200 ms"] [data-testid="ArrowForwardIcon"]'))
  await view.render(<ToolTimes tool={{ name: 'old', started_at: start, ended_at: chip.ended_at }} />)
  assert.doesNotMatch(view.last(), /written/)
  assert.match(view.last(), /writing time unavailable/)
  assert.match(view.last(), /ran for 200 ms/)
})

test('parallel writing snapshots retire atomically with durable chips and survive transcript reload', async t => {
  useFakeClock()
  const server = new FakeServer(); server.busy = true
  installFetch(server)
  resetConvos()
  const snapshots: { writing: number; tools: number }[] = []
  function View() {
    const c = useConvo('org', 'worker')
    snapshots.push({ writing: c.chat?.transient?.filter(r => r.kind === 'tool_writing').length ?? 0,
      tools: c.chat?.messages.flatMap(r => r.tools ?? []).length ?? 0 })
    return <TurnActiveContext.Provider value={true}>
      {c.chat?.transient?.filter(r => r.kind === 'tool_writing').map(r => <ToolWritingLine key={r.event_id} name={r.text} startedAt={r.started_at} />)}
      {c.chat?.messages.flatMap(r => r.tools ?? []).map((tool, i) => tool && <ToolTimes key={i} tool={tool} />)}
    </TurnActiveContext.Provider>
  }
  const view = await mountView(<View />, el => el.textContent ?? '')
  t.after(async () => { await view.unmount(); resetConvos(); realClock() })
  await inAct(() => refreshConvo('org', 'worker'))
  const writing = (id: string, order: number): ChatTransient => ({ event_id: `write-${id}`, role: 'assistant',
    kind: 'tool_writing', text: id, tool_id: id, started_at: new Date(Date.now()).toISOString(), stream_order: order })
  const active = [writing('one', 1), writing('two', 2)]
  const frame = (rows: ChatTransient[], commits: ChatMessage[] = []) => ingestStream('org', {
    node: 'worker', kind: 'tool_writing', text: '', t: 0, tool_writing: rows, convo_rows: commits,
  })
  await inAct(() => frame(active)); await flush()
  assert.match(view.last(), /Writing one/); assert.match(view.last(), /Writing two/)
  const row: ChatMessage = { role: 'assistant', text: '', ts: active[0].started_at!, row_id: 'call-row',
    seq: 1, convo_revision: 1, tools: [{ id: 'one', name: 'one', writing_secs: 3,
      started_at: active[0].started_at, ended_at: new Date(Date.parse(active[0].started_at!) + 200).toISOString(), result: 'ok' }] }
  await inAct(() => frame([active[1]], [row])); await flush()
  assert.doesNotMatch(view.last(), /Writing one/)
  assert.match(view.last(), /Writing two/)
  assert.match(view.last(), /written in 3.0s/); assert.match(view.last(), /ran for 200 ms/)
  assert.ok(!snapshots.some(s => s.writing === 0 && s.tools === 1), 'transition carries still-active second call')
  await inAct(() => frame([])); await flush()
  assert.doesNotMatch(view.last(), /Writing two/)
  server.messages = [row]; server.busy = false
  await inAct(() => refreshConvo('org', 'worker', { force: true })); await flush()
  assert.match(view.last(), /written in 3.0s/); assert.match(view.last(), /ran for 200 ms/)
})
