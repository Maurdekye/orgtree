// reportedlabel.test.ts — the one word this surface may not say is "served".
//
// The backend collects what the CLI REPORTED about each message it delivered:
// `message.model`, `message.provider`, `message.id` and the wrapper-level
// `request_id`. On a gateway lane the reported model is routinely an ECHO of
// the id that was REQUESTED — measured in a captured transcript on this
// machine, where an agent asked for `x-ai/grok-4.6` and every one of 560
// assistant records reported `x-ai/grok-4.6` back. So a label reading "served
// by x-ai/grok-4.6" would be a claim about which machine answered that
// nothing behind it can support, and the operator would have no way to tell
// the claim from the echo.
//
// The other failure this guards is quieter: a turn answered by more than one
// reported upstream, collapsed to whichever came last. That reads as a
// confident single answer and is wrong in the one case anybody would look.
import './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { reportedLabel } from '../src/canvas/shared'

test('§1 it says REPORTED, and never that anything was served', () => {
  const label = reportedLabel({ providers: ['xAI'], models: ['x-ai/grok-4.6'] })
  assert.match(label, /^reported /)
  assert.doesNotMatch(label, /serv/i)
  assert.ok(label.includes('upstream xAI'), label)
  assert.ok(label.includes('model x-ai/grok-4.6'), label)
})

test('§2 a turn with more than one reported upstream says so', () => {
  const mixed = reportedLabel({
    providers: ['Together', 'xAI'], models: ['m'], mixed: true,
  })
  assert.ok(mixed.includes('Together') && mixed.includes('xAI'), mixed)
  assert.ok(mixed.endsWith('(mixed)'), mixed)
  // …and one that did not is not decorated with a warning it has not earned
  const single = reportedLabel({ providers: ['xAI'], models: ['m'] })
  assert.doesNotMatch(single, /mixed/)
})

test('§3 a capped turn is marked partial, so the list is not read as complete', () => {
  const partial = reportedLabel({ providers: ['xAI'], models: ['m'], truncated: true })
  assert.ok(partial.includes('(partial)'), partial)
})

test('§4 nothing reported renders NOTHING — not an empty separator', () => {
  for (const empty of [undefined, null, {}, { providers: [], models: [] },
    { providers: [''], models: [''] }]) {
    assert.equal(reportedLabel(empty), '', JSON.stringify(empty))
  }
})

test('§5 one half missing does not leave a dangling separator', () => {
  assert.equal(reportedLabel({ providers: ['xAI'], models: [] }), 'reported upstream xAI')
  assert.equal(reportedLabel({ providers: [], models: ['m'] }), 'reported model m')
  for (const half of [{ providers: ['xAI'], models: [] }, { providers: [], models: ['m'] }]) {
    assert.doesNotMatch(reportedLabel(half), / · $| ·$|· ·/)
  }
})
