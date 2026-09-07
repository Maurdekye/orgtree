// primedchip.test.ts — FR-27, the "restart primed" indicator's words.
//
// The user asked for "some visual indication somewhere that a prime is active
// and will trigger the next moment the system quiesces". The thing worth
// testing is not that a chip renders — it is WHAT IT CLAIMS, because this chip
// has an unusual audience.
//
// ⚠ THE RECORD IS MACHINE-WIDE. `api.py` injects the same `primed_restart`
// into every org's tree, so most people who see this chip did not arm it and
// are learning about it here. Two things follow, and both are checked below:
//
//   · a prime that WILL cut the org reading this must say so plainly, and
//   · a `mailhub` prime, which rebuilds a container and restarts no agent at
//     all, must NOT wear the same words. If both said "restart primed", the
//     chip would be a false alarm for the whole of one target's audience —
//     and false alarms are how an indicator gets ignored, which costs the
//     real one too.
//
// So the labels are compared TO EACH OTHER. "the mailhub label is right" is
// satisfied by a function that returns one string for everything.
//
// Run:  cd frontend && node tests/run.mjs primedchip

import test from 'node:test'
import assert from 'node:assert/strict'
import { primedRestartChip } from '../src/canvas/shared'

const REC = {
  target: 'org', by_org: 'orgtree', by_node: 'coordinator',
  at: '2026-08-27T01:00:00.000Z', reason: 'ship bb5236e',
}

test('nothing primed renders nothing', () => {
  assert.equal(primedRestartChip(null), null)
  assert.equal(primedRestartChip(undefined), null)
  // …and the control: with a record it does NOT return null, or every
  // assertion in this file is about a chip that never appears
  assert.notEqual(primedRestartChip(REC), null)
})

test('an armed prime says a restart is coming and how it fires', () => {
  const c = primedRestartChip(REC)!
  assert.match(c.label, /restart primed/)
  // the whole promise of the feature, in the tooltip: it WAITS
  assert.match(c.title, /fires by itself once the machine is quiet/)
  assert.match(c.title, /mid-turn/)
  // who armed it and why — the reader did not arm it and has to find out
  assert.match(c.title, /orgtree\/coordinator/)
  assert.match(c.title, /ship bb5236e/)
  // and how to stop it: armed-and-forgotten must not be a trap
  assert.match(c.title, /cancel/)
})

test('a reason-less prime still names its owner (no "undefined" on screen)', () => {
  const c = primedRestartChip({ ...REC, reason: undefined })!
  assert.match(c.title, /orgtree\/coordinator/)
  assert.doesNotMatch(c.title, /undefined/)
  assert.doesNotMatch(c.label, /undefined/)
  // a record with nothing but a target must not print "undefined" either —
  // this is the shape a hand-edited or older record can arrive in
  const bare = primedRestartChip({ target: 'org' })!
  assert.doesNotMatch(bare.title, /undefined/)
  assert.doesNotMatch(bare.title, /null/)
})

test('☠ mailhub does NOT claim this org restarts — the labels differ', () => {
  const org = primedRestartChip(REC)!
  const hub = primedRestartChip({ ...REC, target: 'mailhub' })!
  const both = primedRestartChip({ ...REC, target: 'both' })!

  assert.equal(org.cutsUs, true)
  assert.equal(both.cutsUs, true, 'target "both" restarts the backend too')
  assert.equal(hub.cutsUs, false,
    'a mail-hub rebuild was reported as cutting this org — a false alarm for '
    + 'every org that reads it, and the way an indicator gets ignored')

  // COMPARED TO EACH OTHER: a function that returns one string for every
  // target satisfies each label check above on its own.
  assert.notEqual(org.label, hub.label)
  assert.notEqual(org.label, both.label,
    '"both" also rebuilds the hub and the chip does not mention it')
  assert.notEqual(hub.label, both.label)

  // and the claims must be opposites, not merely different spellings
  assert.match(org.title, /every org on this machine restarts/)
  assert.match(hub.title, /agents here are NOT restarted/)
  assert.doesNotMatch(hub.title, /every org on this machine restarts/)
  assert.doesNotMatch(org.title, /agents here are NOT restarted/)
})

test('an unknown target is treated as cutting us (fail LOUD, not silent)', () => {
  // A target this build does not know about is a record written by a newer
  // backend. Guessing "harmless" would hide a real restart from everyone;
  // guessing "cuts us" over-warns at worst. Over-warning is the safe side.
  const c = primedRestartChip({ ...REC, target: 'something-new' })!
  assert.equal(c.cutsUs, true)
  assert.match(c.label, /restart primed/)
})
