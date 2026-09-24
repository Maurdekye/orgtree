// effortdelivery.test.tsx — WHAT THE EFFORT CONTROL SAYS AFTER A CHANGE
// (docket `support-changing-a-claude-agent-s-effort-level-m`).
//
// The server answers a saved effort with `effort_delivery`: `sent` when the
// level was written to the agent's RUNNING Claude process, `next_turn` when it
// applies from the agent's next turn. The toast must say which, and must never
// claim the running turn APPLIED it: the CLI's acknowledgement proves the
// request was accepted, not used.

import './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { effortChangeToast } from '../src/canvas/effort'

test('a level sent to a running turn says so, and never says "applied"', () => {
  const text = effortChangeToast('worker', 'max',
    { effort_delivery: { delivery: 'sent', effort: 'max' } })
  assert.equal(text, 'worker thinking effort: max — sent to the running agent')
  assert.doesNotMatch(text, /applied/)
})

test('a level that waits for the next turn says so', () => {
  assert.equal(effortChangeToast('worker', 'low',
    { effort_delivery: { delivery: 'next_turn', effort: 'low', reason: 'no turn is running' } }),
  'worker thinking effort: low — applies from its next turn')
})

test('clearing to the org default names the level it resolved to', () => {
  assert.equal(effortChangeToast('worker', '',
    { effort_delivery: { delivery: 'sent', effort: 'medium' } }),
  'worker thinking effort: back to the org default (medium) — sent to the running agent')
})

test('an older engine without the field keeps the plain wording', () => {
  assert.equal(effortChangeToast('worker', 'high', {}), 'worker thinking effort: high')
  assert.equal(effortChangeToast('worker', '', undefined),
    'worker thinking effort: back to the org default')
})

test('an unsupported level in the reply is not echoed', () => {
  assert.equal(effortChangeToast('worker', '',
    { effort_delivery: { delivery: 'next_turn', effort: 'bogus' } }),
  'worker thinking effort: back to the org default — applies from its next turn')
})
