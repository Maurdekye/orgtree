import { advance, FakeServer, flush, inAct, installFetch, mountView, realClock, useFakeClock } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { RunningTurnContext, ToolTimes, TurnActiveContext } from '../src/canvas/toolclock'
import { DeskChat, Msg, ToolChip } from '../src/canvas/desk'
import { ingestStream, resetConvos } from '../src/convo'
import type { CanvasNode } from '../src/canvas/shared'

const txt = (e: Element | null) => e?.textContent?.replace(/\s+/g, ' ').trim()
for (const [seconds, expected] of [[59, '59s'], [60, '1m 00s'], [125, '2m 05s'], [3725, '1h 02m']] as const) {
  test(`live and finished tool clocks agree at ${seconds}s`, async t => {
    useFakeClock()
    const start = new Date(Date.now() - seconds * 1000 - 200).toISOString()
    const end = new Date(Date.parse(start) + seconds * 1000).toISOString()
    const v = await mountView(<TurnActiveContext.Provider value={true}><RunningTurnContext.Provider value={start}>
      <div data-case="writing"><ToolTimes tool={{ name: 'Bash', writing_started_at: start }} /></div>
      <div data-case="running"><ToolTimes tool={{ name: 'Bash', started_at: start }} /></div>
      <div data-case="done"><ToolTimes tool={{ name: 'Bash', writing_secs: seconds, started_at: start, ended_at: end, result: 'done' }} /></div>
    </RunningTurnContext.Provider></TurnActiveContext.Provider>, h => h)
    t.after(async () => { await v.unmount(); realClock() })
    assert.equal(txt(v.el.querySelector('.tool-writing')), expected)
    assert.equal(txt(v.el.querySelector('.tool-running')), '· ' + expected)
    assert.equal(txt(v.el.querySelector('[data-case="done"]')), `· ${expected} · ${expected}`)
    await advance(799)
    assert.equal(txt(v.el.querySelector('.tool-writing')), expected, 'no sub-second display update')
    if (seconds === 59) {
      await advance(1)
      assert.equal(txt(v.el.querySelector('.tool-writing')), '1m 00s', 'minute rollover remains aligned to actual elapsed second')
    }
  })
  test(`finished thought clocks use shared duration at ${seconds}s`, async t => {
    const v = await mountView(<Msg m={{ role: 'assistant', text: '', thinking_sealed: true, think_secs: seconds }} slug="clock-test" nid="agent" />, h => h)
    t.after(() => v.unmount())
    assert.equal(txt(v.el.querySelector('.thoughtline')), 'thought for ' + expected)
  })
}
test('live thought clock uses minutes and seconds in the actual desk', async t => {
  useFakeClock(); resetConvos(); window.localStorage.clear()
  const server = new FakeServer(); server.busy = true
  const transport = installFetch(server)
  const node = { id: 'agent', state: 'live', tier: 'sol', model_id: 'sol', children: [], seat: 1, grant: 0, free: 0,
    scope: { tools: {}, add_dirs: [] }, busy: true, proc_live: true, tasks: 0, bg_tasks: 0,
    inflight_at: new Date().toISOString(), activity: { phase: 'thinking' } } as unknown as CanvasNode
  const v = await mountView(<DeskChat node={node} map={new Map([['agent', node]])} op={async () => ({})} slug="clock-test" toast={() => {}} bare onJump={() => {}} />, h => h)
  t.after(async () => { await v.unmount(); transport.release(); resetConvos(); realClock() })
  await flush(6); transport.holdAll = true
  await inAct(() => ingestStream('clock-test', { node: 'agent', kind: 'thinking_start', text: '', t: Date.now() }))
  await advance(125000)
  assert.match(txt(v.el.querySelector('.thinking.sealed')) ?? '', /thinking… for 2m 05s/)
})
test('helper task duration uses the shared tool duration style', async t => {
  const v = await mountView(<ToolChip slug="clock-test" nid="agent" t={{ name: 'Agent', result: 'done', task: { tools: 2, ms: 125000 } }} />, h => h)
  t.after(() => v.unmount())
  assert.match(txt(v.el) ?? '', /2 tools · 2m 05s/)
})
