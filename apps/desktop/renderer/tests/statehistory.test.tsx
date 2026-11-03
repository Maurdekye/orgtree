import { mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { Msg } from '../src/canvas/desk'
import { stateMarkerText } from '../src/canvas/statemarker'
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
  assert.equal(line!.textContent, 'Active for 12m', 'the ended state and how long it lasted, not the new state')
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

// USER 2026-11-03 17:37:22Z m1bfdb3fba01b: the marker says what the PREVIOUS state was and how long it lasted
// ("active for 32s", "idle for 19s"), never the new state; nothing at all for a state under a second.
test('the marker reads "<ended state> for <duration>" for every state kind', () => {
  for (const [prev, label] of [['active', 'Active'], ['idle', 'Idle'], ['blocked', 'Blocked'], ['halted', 'Halted'], ['frozen', 'Frozen']] as const) {
    assert.equal(stateMarkerText(stateRow({ prev_state: prev, prev_secs: 32 })), `${label} for 32s`)
  }
  assert.equal(stateMarkerText(stateRow({ state: 'active', prev_state: 'idle', prev_secs: 19 })), 'Idle for 19s')
  assert.equal(stateMarkerText(stateRow({ prev_secs: 7200 })), 'Active for 2h', 'the States tab\'s own age words')
})

test('an ended state under one second is not drawn: 0 s hides, 1 s shows', () => {
  assert.equal(stateMarkerText(stateRow({ prev_secs: 0 })), null)
  assert.equal(stateMarkerText(stateRow({ prev_secs: 1 })), 'Active for 1s')
})

test('a suppressed marker draws no row at all, in the desk and wherever Msg is reused', async t => {
  const view = await mountView(<Msg m={stateRow({ prev_secs: 0 })} slug="org" nid="worker" />, el => el)
  t.after(() => view.unmount())
  assert.equal(view.el.querySelector('.msg'), null, 'no line')
  assert.equal(view.el.textContent, '', 'no text, no empty row to leave a gap')
})

test('edge rows: an unknown start names the ended state alone; a first row with no ended state says nothing; an old row keeps its text', () => {
  assert.equal(stateMarkerText(stateRow({ prev_secs: undefined })), 'Active')
  assert.equal(stateMarkerText(stateRow({ prev_state: undefined, prev_secs: undefined, text: 'Idle' })), null)
  assert.equal(stateMarkerText({ role: 'system', kind: 'state', text: 'Idle · was active 12m' } as ChatMessage), 'Idle · was active 12m')
  assert.equal(stateMarkerText({ role: 'system', kind: 'session', text: 'Session ended' } as ChatMessage), undefined, 'not a state row')
})

test('an "Active for …" marker carries its ended state for the provider-colour rule; the other states do not turn Active-coloured', async t => {
  const { readFileSync } = await import('node:fs')
  const path = await import('node:path')
  const css = readFileSync(path.join(__SRC_DIR__, 'styles.css'), 'utf8')
  assert.match(css, /\.msg\.sys\[data-ended-state="active"\] \{ color: var\(--agent-accent-text, var\(--accent\)\); \}/)
  const a = await mountView(<Msg m={stateRow({ prev_state: 'active', prev_secs: 32 })} slug="org" nid="worker" />, el => el)
  const i = await mountView(<Msg m={stateRow({ state: 'active', prev_state: 'idle', prev_secs: 19 })} slug="org" nid="worker" />, el => el)
  t.after(() => { a.unmount(); i.unmount() })
  assert.equal(a.el.querySelector('.msg.sys')?.getAttribute('data-ended-state'), 'active')
  assert.equal(i.el.querySelector('.msg.sys')?.getAttribute('data-ended-state'), 'idle')
})

declare const __SRC_DIR__: string
