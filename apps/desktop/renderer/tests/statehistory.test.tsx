import { mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { Msg } from '../src/canvas/desk'
import { transcriptEntries } from '../src/events/systemruns'
import type { ChatMessage } from '../src/types'

/** A state-history row exactly as the engine writes it (see
 *  `runtime/state_history.rs`): an ordinary transcript system row whose
 *  text names the state just entered and the one it ended, with the
 *  ended state's duration, and whose `ts` is the new state's start. */
const stateRow = (over: Partial<ChatMessage> = {}): ChatMessage => ({
  role: 'system', kind: 'state', state: 'idle', prev_state: 'active', prev_secs: 720,
  text: 'Idle · was active 12m', ts: '2026-11-01T10:12:00Z', seq: 7, row_id: 'r7', ...over,
})

test('a state row reads as one compact system line with its start time on hover', async t => {
  const view = await mountView(<Msg m={stateRow()} slug="org" nid="worker" />, el => el)
  t.after(() => view.unmount())
  const line = view.el.querySelector('.msg.sys')
  assert.ok(line, 'the row renders in the transcript system-row style')
  assert.equal(line!.textContent, 'Idle · was active 12m')
  // the start time is the row's own instant, named the way every other
  // age on the desk names it on hover: what it counts from, then the
  // full instant (`ageTitle`)
  assert.match(line!.getAttribute('title') ?? '', /^Idle since 2026-/)
  assert.equal(line!.getAttribute('aria-label'), line!.getAttribute('title'))
})

test('every state names itself in the hover', async t => {
  for (const [state, label] of [['active', 'Active'], ['blocked', 'Blocked'], ['halted', 'Halted'], ['frozen', 'Frozen']] as const) {
    const view = await mountView(
      <Msg m={stateRow({ state, text: `${label} · was idle 3h` })} slug="org" nid="worker" />, el => el)
    const line = view.el.querySelector('.msg.sys')
    assert.ok(line)
    assert.match(line!.getAttribute('title') ?? '', new RegExp(`^${label} since `), state)
    view.unmount()
  }
  t.after(() => {})
})

test('state rows are never folded into a system-notice pile', () => {
  const entries = transcriptEntries([stateRow(), stateRow({ seq: 8, row_id: 'r8' })])
  assert.deepEqual(entries.map(e => e.system), [false, false])
})

test('an ordinary system row is unchanged: no state hover appears', async t => {
  const plain: ChatMessage = { role: 'system', kind: 'session', text: 'Session ended', ts: '2026-11-01T10:12:00Z', seq: 3 }
  const view = await mountView(<Msg m={plain} slug="org" nid="worker" />, el => el)
  t.after(() => view.unmount())
  const line = view.el.querySelector('.msg.sys')
  assert.ok(line)
  assert.equal(line!.textContent, 'Session ended')
  assert.equal(line!.getAttribute('title'), null)
  // a state row with no known start has no hover to give
  const noTs = await mountView(<Msg m={stateRow({ ts: null })} slug="org" nid="worker" />, el => el)
  const bare = noTs.el.querySelector('.msg.sys')
  assert.ok(bare)
  assert.equal(bare!.getAttribute('title'), null)
  noTs.unmount()
})
