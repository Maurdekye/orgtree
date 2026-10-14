import { advance, mountView, realClock, useFakeClock } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { RunningTimer, RunningTurnContext, ToolTimes, ToolWritingLine, TurnActiveContext } from '../src/canvas/toolclock'

const text = (el: Element) => el.textContent?.replace(/\s+/g, ' ').trim()
test('offset writing timer changes only on the actual whole-second boundaries', async t => {
  useFakeClock()
  const start = new Date(Date.now() - 200).toISOString()
  const view = await mountView(<ToolWritingLine name="Bash" startedAt={start} />, text)
  t.after(async () => { await view.unmount(); realClock() })
  assert.equal(view.last(), '0s')
  await advance(799); assert.equal(view.last(), '0s')
  await advance(1); assert.equal(view.last(), '1s')
  await advance(999); assert.equal(view.last(), '1s')
  await advance(1); assert.equal(view.last(), '2s')
})

test('execution timer shares whole-second boundaries and respects active turn state', async t => {
  useFakeClock()
  const start = new Date(Date.now() - 200).toISOString()
  // the call's own turn, admitted as the call started
  const render = (active = true) => <TurnActiveContext.Provider value={active}><RunningTurnContext.Provider value={start}>
    <RunningTimer startedAt={start} /></RunningTurnContext.Provider></TurnActiveContext.Provider>
  const view = await mountView(render(), text)
  t.after(async () => { await view.unmount(); realClock() })
  assert.equal(view.last(), '· 0s')
  await advance(799); assert.equal(view.last(), '· 0s')
  await advance(1); assert.equal(view.last(), '· 1s')
  await advance(1000); assert.equal(view.last(), '· 2s')
  await view.render(render(false)); assert.equal(view.last(), '')
  await advance(3000); assert.equal(view.last(), '')
  await view.render(render()); assert.equal(view.last(), '· 5s')
})

test('a changed start cancels the old tick and invalid starts show no clock', async t => {
  useFakeClock()
  const view = await mountView(<ToolWritingLine name="one" startedAt={new Date(Date.now() - 200).toISOString()} />, text)
  t.after(async () => { await view.unmount(); realClock() })
  await advance(300)
  const next = new Date(Date.now() - 50).toISOString()
  await view.render(<ToolWritingLine name="two" startedAt={next} />)
  await advance(500); assert.equal(view.last(), '0s', 'the old timer cannot advance the new clock')
  await advance(449); assert.equal(view.last(), '0s')
  await advance(1); assert.equal(view.last(), '1s')
  await view.render(<ToolWritingLine name="unknown" startedAt="invalid" />)
  assert.equal(view.last(), '')
  await advance(1000); assert.equal(view.last(), '')
})

test('completed observations retain precise existing durations after the live timer retires', async t => {
  useFakeClock()
  const start = new Date(Date.now() - 200).toISOString()
  const live = { name: 'Bash', writing_started_at: start }
  const view = await mountView(<ToolTimes tool={live} />, text)
  t.after(async () => { await view.unmount(); realClock() })
  assert.equal(view.last(), '· 0s')
  await advance(1000); assert.equal(view.last(), '· 1s')
  const final = { name: 'Bash', writing_secs: 1.2, started_at: start,
    ended_at: new Date(Date.parse(start) + 200).toISOString(), result: 'done' }
  await view.render(<ToolTimes tool={final} />)
  assert.equal(view.last(), '· 1.2s · 200 ms')
  await advance(2000); assert.equal(view.last(), '· 1.2s · 200 ms')
})

test('completed precision is unchanged without a live observation', async t => {
  const view = await mountView(<ToolTimes tool={{ name: 'Bash', writing_secs: 1.2,
    started_at: '2026-10-14T16:00:00Z', ended_at: '2026-10-14T16:00:00.200Z', result: 'done' }} />, text)
  t.after(() => view.unmount())
  assert.equal(view.last(), '· 1.2s · 200 ms')
})
