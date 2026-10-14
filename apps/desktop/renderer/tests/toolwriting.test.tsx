import { advance, FakeServer, flush, inAct, installFetch, mountView, realClock, useFakeClock } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { RunningTurnContext, ToolTimes, ToolWritingLine, TurnActiveContext } from '../src/canvas/toolclock'
import { Msg, ToolChip } from '../src/canvas/desk'
import { ingestStream, refreshConvo, resetConvos, useConvo } from '../src/convo'
import type { ChatMessage, ChatTransient } from '../src/types'

test('completed and reloaded chips show both icons and durations without timing words', async t => {
  useFakeClock()
  const start = new Date(Date.now()).toISOString()
  const view = await mountView(<ToolTimes tool={{ name: 'orgtree_message', writing_secs: 3,
    started_at: start, ended_at: new Date(Date.parse(start) + 200).toISOString(), result: 'sent' }} />, el => el.textContent ?? '')
  t.after(async () => { await view.unmount(); realClock() })
  const chip = JSON.parse(JSON.stringify({ name: 'orgtree_message', writing_secs: 3,
    started_at: start, ended_at: new Date(Date.parse(start) + 200).toISOString(), result: 'sent' }))
  await view.render(<ToolTimes tool={chip} />)
  assert.equal(view.last().replace(/\s+/g, ' ').trim(), '· 3.0s · 200 ms')
  assert.ok(view.el.querySelector('[aria-label="written in 3.0s"] [data-testid="EditOutlinedIcon"]'))
  assert.ok(view.el.querySelector('[aria-label="ran for 200 ms"] [data-testid="ArrowForwardIcon"]'))
  await view.render(<ToolTimes tool={{ name: 'old', started_at: start, ended_at: chip.ended_at }} />)
  assert.doesNotMatch(view.last(), /written/)
  assert.doesNotMatch(view.last(), /—/)
  assert.match(view.last(), /200 ms/)
  assert.equal(view.el.querySelector('.tool-writing-time'), null)
  await view.render(<Msg m={{ role: 'assistant', text: '', tools: [chip] }} slug="org" nid="worker" />)
  await inAct(() => { view.el.querySelector<HTMLElement>('.tline')!.click() }); await flush()
  assert.equal(view.el.querySelectorAll('[aria-label="written in 3.0s"]').length, 1)
  assert.equal(view.el.querySelectorAll('[aria-label="ran for 200 ms"]').length, 1)
})

test('a writing chip shows its pencil and streamed fields in the shared chip layout', async t => {
  useFakeClock()
  const start = new Date(Date.now()).toISOString()
  const initial = { id: 'streamed', name: 'Bash', writing_started_at: start }
  const view = await mountView(<ToolChip t={initial} slug="org" nid="worker" />, el => el.textContent ?? '')
  t.after(async () => { await view.unmount(); realClock() })
  assert.ok(view.el.querySelector('.tline .tool-writing-status'))
  assert.equal(view.el.querySelector('.tline .tool-running-status'), null)
  assert.match(view.last(), /Bash/)
  assert.match(view.last(), /0s/)
  assert.doesNotMatch(view.last(), /Writing|written in|ran for|unavailable|—/)
  assert.equal(view.el.querySelector('.targ'), null, 'unknown fields are absent')
  await view.render(<ToolChip t={{ ...initial, arg: 'echo hel', preview_input: { command: 'echo hel' } }} slug="org" nid="worker" />)
  assert.match(view.last(), /echo hel/)
  await inAct(() => view.el.querySelector<HTMLElement>('.tline')!.click()); await flush()
  assert.match(view.el.querySelector('.toolinput')?.textContent ?? '', /echo hel/)
  await view.render(<ToolChip t={{ ...initial, arg: 'Say hello', preview_input: { command: 'echo hello', description: 'Say hello' } }} slug="org" nid="worker" />)
  assert.match(view.el.querySelector('.targ')?.textContent ?? '', /Say hello/)
  assert.match(view.el.querySelector('.toolinput')?.textContent ?? '', /echo hello/)
  await advance(3000)
  assert.match(view.el.querySelector('.tool-writing-time')?.textContent ?? '', /3s/)
  assert.equal(view.el.querySelector('.tool-exec-time,.tool-running'), null)
})

test('executing chips use the execution-time arrow and an immediate icon-only clock, then keep the finished dot', async t => {
  useFakeClock()
  const start = new Date(Date.now()).toISOString()
  const chip = { id: 'running', name: 'Bash', arg: 'echo hi', writing_secs: 3.1, started_at: start }
  // the call's own turn, admitted as the call started
  const render = (tool = chip, active = true) => <TurnActiveContext.Provider value={active}><RunningTurnContext.Provider value={start}>
    <ToolChip t={tool} slug="org" nid="worker" /></RunningTurnContext.Provider></TurnActiveContext.Provider>
  const view = await mountView(render(), el => el.textContent ?? '')
  t.after(async () => { await view.unmount(); realClock() })
  // Icon spans leave adjacent text-node spaces; the browser collapses them.
  const clockText = (selector: string) => view.el.querySelector(selector)?.textContent?.replace(/\s+/g, ' ').trim()
  assert.ok(view.el.querySelector('.tline .tool-running-status[data-testid="ArrowForwardIcon"]'))
  assert.equal(view.el.querySelector('.tline .tool-running-status[data-testid="PlayArrowIcon"]'), null)
  assert.ok(view.el.querySelector('[aria-label="executing tool call"][title="Executing tool call"]'))
  assert.equal(clockText('.tool-running'), '· 0s')
  await advance(1000)
  assert.equal(clockText('.tool-running'), '· 1s')
  assert.doesNotMatch(view.last(), /written in|ran for|running for/)
  await view.render(render({ ...chip, ended_at: new Date(Date.now()).toISOString(), result: 'done' } as typeof chip))
  assert.equal(view.el.querySelector('.tool-running-status,.tool-writing-status'), null)
  assert.ok(view.el.querySelector('.tooldot[data-testid="FiberManualRecordIcon"]'))
  assert.equal(clockText('.tool-exec-time'), '· 1.0s')
  await view.render(render(chip, false))
  assert.equal(view.el.querySelector('.tool-running'), null, 'an interrupted inactive call cannot keep counting')
  assert.ok(view.el.querySelector('[aria-label="execution time unavailable"]'))
})

test('line counts are absent inline in every phase and shown only after expansion', async t => {
  const chip = { id: 'lines', name: 'Read', arg: 'notes.txt', result_lines: 2, result: 'one\ntwo' }
  const view = await mountView(<ToolChip t={chip} slug="org" nid="worker" />, el => el.textContent ?? '')
  t.after(() => view.unmount())
  assert.doesNotMatch(view.el.querySelector('.tline')?.textContent ?? '', /2 lines/)
  assert.equal(view.el.querySelector('.tool-line-count'), null)
  await inAct(() => view.el.querySelector<HTMLElement>('.tline')!.click()); await flush()
  assert.equal(view.el.querySelector('.tool-line-count')?.textContent, '2 lines')
  for (const phase of [{ writing_started_at: '2026-10-14T10:00:00Z' }, { started_at: '2026-10-14T10:00:00Z' }]) {
    await view.render(<TurnActiveContext.Provider value={true}><ToolChip t={{ ...chip, result: undefined, ...phase }} slug="org" nid="worker" /></TurnActiveContext.Provider>)
    assert.doesNotMatch(view.el.querySelector('.tline')?.textContent ?? '', /2 lines/)
  }
})

test('unknown writing clocks are omitted while execution retains its accessible explanation', async t => {
  const view = await mountView(<ToolTimes tool={{ name: 'old', result: 'done' }} />, el => el.textContent ?? '')
  t.after(() => view.unmount())
  assert.equal(view.last().replace(/\s+/g, ' ').trim(), '· —')
  assert.equal(view.el.querySelector('.tool-writing-time'), null)
  assert.ok(view.el.querySelector('[aria-label="execution time unavailable"][title]'))
  await view.render(<ToolWritingLine name="" />)
  assert.equal(view.last().trim(), '')
  assert.ok(view.el.querySelector('[aria-label="Writing tool call"]'))
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
  assert.ok(view.el.querySelector('[aria-label="Writing one"]')); assert.ok(view.el.querySelector('[aria-label="Writing two"]'))
  const row: ChatMessage = { role: 'assistant', text: '', ts: active[0].started_at!, row_id: 'call-row',
    seq: 1, convo_revision: 1, tools: [{ id: 'one', name: 'one', writing_secs: 3,
      started_at: active[0].started_at, ended_at: new Date(Date.parse(active[0].started_at!) + 200).toISOString(), result: 'ok' }] }
  await inAct(() => frame([active[1]], [row])); await flush()
  assert.equal(view.el.querySelector('[aria-label="Writing one"]'), null)
  assert.ok(view.el.querySelector('[aria-label="Writing two"]'))
  assert.match(view.last(), /3.0s/); assert.match(view.last(), /200 ms/)
  assert.ok(!snapshots.some(s => s.writing === 0 && s.tools === 1), 'transition carries still-active second call')
  await inAct(() => frame([])); await flush()
  assert.equal(view.el.querySelector('[aria-label="Writing two"]'), null)
  server.messages = [row]; server.busy = false
  await inAct(() => refreshConvo('org', 'worker', { force: true })); await flush()
  assert.match(view.last(), /3.0s/); assert.match(view.last(), /200 ms/)
})

test('same-millisecond stale HTTP cannot remove or resurrect writing snapshots', async t => {
  useFakeClock()
  const server = new FakeServer(); server.busy = true
  const originalChat = server.chat.bind(server)
  let serverActive: ChatTransient[] = []
  server.chat = last => ({ ...originalChat(last), transient: serverActive })
  const transport = installFetch(server)
  resetConvos()
  function View() {
    const c = useConvo('org', 'same-ms')
    return <>{c.chat?.transient?.map(r => <span key={r.event_id}>{r.text}</span>)}</>
  }
  const view = await mountView(<View />, el => el.textContent ?? '')
  t.after(async () => { await view.unmount(); resetConvos(); realClock() })
  await inAct(() => refreshConvo('org', 'same-ms'))
  const active: ChatTransient = { event_id: 'write-one', role: 'assistant', kind: 'tool_writing',
    text: 'WRITING_ONE', tool_id: 'one', started_at: new Date(Date.now()).toISOString() }
  transport.holdAll = true
  let pending = refreshConvo('org', 'same-ms', { force: true })
  await inAct(() => ingestStream('org', { node: 'same-ms', kind: 'tool_writing', text: '', t: 0, tool_writing: [active] }))
  await inAct(async () => { transport.release(); await pending })
  assert.match(view.last(), /WRITING_ONE/, 'an older empty HTTP snapshot cannot remove a newer active writer')
  serverActive = [active]
  pending = refreshConvo('org', 'same-ms', { force: true })
  await inAct(() => ingestStream('org', { node: 'same-ms', kind: 'tool_writing', text: '', t: 0, tool_writing: [] }))
  await inAct(async () => { transport.release(); await pending })
  assert.equal(view.last(), '', 'an older HTTP writer cannot resurrect after admission/turn cleanup')
})
