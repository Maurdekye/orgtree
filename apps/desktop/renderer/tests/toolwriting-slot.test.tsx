import { advance, mountView, realClock, useFakeClock } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { RunningTurnContext, ToolTimes, TurnActiveContext } from '../src/canvas/toolclock'
import { Msg } from '../src/canvas/desk'
import type { ToolChip } from '../src/types'

const start = '2026-10-14T16:00:00Z'
const completed = { name: 'powershell', arg: 'Show current dir contents', started_at: start,
  ended_at: '2026-10-14T16:00:00.784Z', result: 'done' }
const text = (el: Element) => el.textContent?.replace(/\s+/g, ' ').trim()

test('absent or null writing observations leave no pencil, dash or separator on completed calls', async t => {
  const view = await mountView(<ToolTimes tool={completed} />, text)
  t.after(() => view.unmount())
  for (const writing_secs of [undefined, null]) {
    await view.render(<ToolTimes tool={{ ...completed, writing_secs } as ToolChip} />)
    assert.equal(view.last(), '· 784 ms')
    assert.equal(!!view.el.querySelector('.tool-writing-time,[data-testid="EditOutlinedIcon"]'), false)
    assert.ok(view.el.querySelector('[aria-label="ran for 784 ms"] [data-testid="ArrowForwardIcon"]'))
  }
})

test('a real zero or positive writing duration retains its pencil and precise duration', async t => {
  const view = await mountView(<ToolTimes tool={{ ...completed, writing_secs: 0 }} />, text)
  t.after(() => view.unmount())
  assert.equal(view.last(), '· 0 ms · 784 ms')
  assert.ok(view.el.querySelector('[aria-label="written in 0 ms"] [data-testid="EditOutlinedIcon"]'))
  await view.render(<ToolTimes tool={{ ...completed, writing_secs: 1.2 }} />)
  assert.equal(view.last(), '· 1.2s · 784 ms')
  assert.ok(view.el.querySelector('[aria-label="written in 1.2s"] [data-testid="EditOutlinedIcon"]'))
})

test('unknown writing stays absent during execution and after transcript reload', async t => {
  useFakeClock()
  const liveStart = new Date(Date.now()).toISOString()
  const view = await mountView(<TurnActiveContext.Provider value={true}>
    <RunningTurnContext.Provider value={liveStart}>
      <ToolTimes tool={{ name: 'powershell', started_at: liveStart }} />
    </RunningTurnContext.Provider>
  </TurnActiveContext.Provider>, text)
  t.after(async () => { await view.unmount(); realClock() })
  assert.equal(view.last(), '· 0s')
  assert.equal(!!view.el.querySelector('.tool-writing-time,.tool-writing'), false)
  await advance(1000)
  assert.equal(view.last(), '· 1s')
  assert.equal(!!view.el.querySelector('.tool-writing-time,.tool-writing'), false)
  const tool = JSON.parse(JSON.stringify(completed))
  await view.render(<Msg m={{ role: 'assistant', text: '', tools: [tool] }} slug="org" nid="worker" />)
  assert.equal(!!view.el.querySelector('.tool-writing-time,[data-testid="EditOutlinedIcon"]'), false)
  assert.ok(view.el.querySelector('[aria-label="ran for 784 ms"]'))
  assert.doesNotMatch(view.last() ?? '', /—/)
})
