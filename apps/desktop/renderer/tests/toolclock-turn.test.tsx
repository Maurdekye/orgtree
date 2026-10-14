import { advance, mountView, realClock, useFakeClock } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import type { Context, ReactNode } from 'react'
import * as clock from '../src/canvas/toolclock'
import { ToolChip } from '../src/canvas/desk'

// A tool call is timed live only while its own turn runs (docket
// tool-calls-left-open-by-an-earlier-turn-count-up). The user's report
// (2026-10-14): yesterday's Muse call, left open when its turn ended, counted
// "23h 08m" again during today's turn, because the desk only knew that SOME
// turn ran. The running turn's start reaches the desk as `RunningTurnContext`;
// it is read through the module so this file also runs, as the red control,
// against the renderer before that context existed. Absent elements are
// checked as booleans: a failing assertion handed a jsdom element runs out of
// memory before it reports (AGENTS.md).
const RunningTurn = (clock as { RunningTurnContext?: Context<string | null> }).RunningTurnContext
const desk = (turnStart: string | null, node: ReactNode, active = true) =>
  <clock.TurnActiveContext.Provider value={active}>
    {RunningTurn ? <RunningTurn.Provider value={turnStart}>{node}</RunningTurn.Provider> : node}
  </clock.TurnActiveContext.Provider>
const text = (el: Element) => el.textContent?.replace(/\s+/g, ' ').trim() ?? ''

/** Under the fake clock: today's turn admitted 41 s ago, its call started 8 s
 *  after it, and yesterday's call 23h 08m before the turn. */
function stamps() {
  const now = Date.now()
  const at = (ms: number) => new Date(now - ms).toISOString()
  return { turn: at(41_000), current: at(33_000), old: at(41_000 + (23 * 60 + 8) * 60_000) }
}

test('a call an earlier turn left open is not timed under a new turn: it shows as unfinished', async t => {
  useFakeClock()
  const { turn, old } = stamps()
  const open = { id: 'old', name: 'powershell', arg: 'List workspace roots', started_at: old }
  const view = await mountView(desk(turn, <ToolChip t={open} slug="org" nid="worker" />), text)
  t.after(async () => { await view.unmount(); realClock() })
  assert.equal(view.el.querySelector('.tool-running') === null, true, "no live timer for an earlier turn's call")
  assert.equal(view.el.querySelector('.tline .tool-running-status') === null, true, 'nor the executing icon')
  assert.ok(view.el.querySelector('.tooldot[data-testid="FiberManualRecordIcon"]'))
  assert.ok(view.el.querySelector('[aria-label="execution time unavailable"]'), 'the existing unfinished form')
  assert.doesNotMatch(view.last(), /\d+\s*(h|m|s|ms)\b/, 'no duration, live or made up')
  await advance(3000)
  assert.equal(view.el.querySelector('.tool-running') === null, true, 'nor once time passes')
})

test("the running turn's own call is timed live from its start, with the executing icon", async t => {
  useFakeClock()
  const { turn, current } = stamps()
  const call = { id: 'now', name: 'powershell', arg: 'Show current dir contents', started_at: current }
  const view = await mountView(desk(turn, <ToolChip t={call} slug="org" nid="worker" />), text)
  t.after(async () => { await view.unmount(); realClock() })
  const clockText = () => view.el.querySelector('.tool-running')?.textContent?.replace(/\s+/g, ' ').trim()
  assert.ok(view.el.querySelector('.tline .tool-running-status'))
  assert.equal(clockText(), '· 33s')
  await advance(1000)
  assert.equal(clockText(), '· 34s')
})

test('a desk busy before its turn is known (the optimistic send, a slot wait) times no earlier call', async t => {
  useFakeClock()
  const { old } = stamps()
  const open = { id: 'old', name: 'powershell', arg: 'List workspace roots', started_at: old }
  const view = await mountView(desk(null, <ToolChip t={open} slug="org" nid="worker" />), text)
  t.after(async () => { await view.unmount(); realClock() })
  assert.equal(view.el.querySelector('.tool-running') === null, true, 'no live timer without a known turn')
  assert.equal(view.el.querySelector('.tline .tool-running-status') === null, true, 'nor the executing icon')
  assert.ok(view.el.querySelector('[aria-label="execution time unavailable"]'))
})

test("a writing clock known to be an earlier turn's stops; without a known turn it ticks as before", async t => {
  useFakeClock()
  const { turn, current, old } = stamps()
  const view = await mountView(desk(turn, <clock.ToolWritingLine name="Bash" startedAt={old} />), text)
  t.after(async () => { await view.unmount(); realClock() })
  assert.equal(view.last(), '', "an earlier turn's writing is not timed")
  await view.render(desk(turn, <clock.ToolWritingLine name="Bash" startedAt={current} />))
  assert.equal(view.last(), '33s')
  await view.render(<clock.ToolWritingLine name="Bash" startedAt={current} />)
  assert.equal(view.last(), '33s', 'outside a desk nothing changes')
})

test('the turn a call belongs to, and the newer of two turn starts, by the engine stamps', () => {
  const { ofRunningTurn, newerStamp } = clock as unknown as {
    ofRunningTurn: (startedAt: unknown, turnStart: string | null) => boolean
    newerStamp: (a?: string | null, b?: string | null) => string | null
  }
  const turn = '2026-10-14T17:31:49.199Z', earlier = '2026-10-13T17:58:10.000Z'
  assert.equal(ofRunningTurn('2026-10-14T17:31:57.345Z', turn), true)
  assert.equal(ofRunningTurn(turn, turn), true, 'a call stamped at its admission is that turn')
  assert.equal(ofRunningTurn('2026-10-13T18:24:25.670Z', turn), false)
  assert.equal(ofRunningTurn('2026-10-14T17:31:57.345Z', null), false, 'no known turn: no call is its')
  assert.equal(ofRunningTurn('invalid', turn), false)
  assert.equal(ofRunningTurn(undefined, turn), false)
  assert.equal(newerStamp(earlier, turn), turn)
  assert.equal(newerStamp(turn, earlier), turn)
  assert.equal(newerStamp(null, turn), turn)
  assert.equal(newerStamp('invalid', turn), turn)
  assert.equal(newerStamp(undefined, undefined), null)
})
