import { advance, inAct, mountView, realClock, useFakeClock } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { RunningTimer, RunningTurnContext, ToolTimes, ToolWritingLine, TurnActiveContext } from '../src/canvas/toolclock'

const text = (el: Element) => el.textContent ?? ''

test('completed writing and execution tooltips expose recorded millisecond durations', async t => {
  const view = await mountView(<ToolTimes tool={{ name: 'Bash', writing_secs: 0.00433,
    started_at: '2026-10-18T08:00:00.123000Z', ended_at: '2026-10-18T08:00:00.123432Z', result: 'done' }} />, text)
  t.after(() => view.unmount())
  assert.equal(view.el.querySelector('.tool-writing-time')?.getAttribute('title'), 'writing time: 4.330ms')
  assert.equal(view.el.querySelector('.tool-exec-time')?.getAttribute('title'), 'execution time: 0.432ms')
})

test('coarse or missing timestamps never invent millisecond precision', async t => {
  const view = await mountView(<ToolTimes tool={{ name: 'Bash',
    started_at: '2026-10-18T08:00:00Z', ended_at: '2026-10-18T08:00:01Z', result: 'done' }} />, text)
  t.after(() => view.unmount())
  assert.match(view.el.querySelector('.tool-exec-time')?.getAttribute('title') ?? '', /millisecond precision unavailable/i)
  assert.equal(!!view.el.querySelector('.tool-writing-time'), false)
  await view.render(<ToolTimes tool={{ name: 'Bash', result: 'done' }} />)
  assert.match(view.el.querySelector('.tool-exec-time')?.getAttribute('title') ?? '', /not observed/i)
  await view.render(<ToolTimes tool={{ name: 'Bash', writing_secs: 0,
    started_at: '2026-10-18T08:00:00.000Z', ended_at: '2026-10-18T08:00:00.000Z', result: 'done' }} />)
  assert.equal(view.el.querySelector('.tool-writing-time')?.getAttribute('title'), 'writing time: 0.000ms')
  assert.equal(view.el.querySelector('.tool-exec-time')?.getAttribute('title'), 'execution time: 0.000ms')
})

test('live time hover samples current elapsed milliseconds without changing the second clock', async t => {
  useFakeClock()
  const start = new Date(Date.now() - 12347).toISOString()
  const view = await mountView(<TurnActiveContext.Provider value={true}><RunningTurnContext.Provider value={start}>
    <ToolWritingLine name="Bash" startedAt={start} /><RunningTimer startedAt={start} />
  </RunningTurnContext.Provider></TurnActiveContext.Provider>, text)
  t.after(async () => { await view.unmount(); realClock() })
  await advance(123)
  await inAct(() => {
    view.el.querySelector('.tool-writing')!.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true }))
    view.el.querySelector('.tool-running')!.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true }))
  })
  assert.equal(view.el.querySelector('.tool-writing')?.getAttribute('title'), 'writing time: 12470.000ms')
  assert.equal(view.el.querySelector('.tool-running')?.getAttribute('title'), 'execution time: 12470.000ms')
  assert.match(view.last(), /12s/)
  assert.doesNotMatch(view.last(), /12470/)
})
