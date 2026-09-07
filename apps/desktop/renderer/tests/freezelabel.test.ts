// freezelabel.test.ts — every freeze kind gets its OWN words.
//
// This label surface has now produced the same failure three times in one day,
// each time by the same route: a kind the payload could not describe fell
// through to the `else` branch and the display said "usage limit" with total
// confidence.
//
//   · AUTH (`cause === "auth"` — the credential was rejected) carries
//     `limit: true`, so it is a usage-limit freeze in SHAPE only. It read as
//     "usage limit hit", telling the operator to wait for capacity when the
//     fix is to replace a credential. Worse, `_rederive_freeze_reset` then
//     OVERWROTE its "replace it, then resume" text with "capacity available"
//     — true, and the exact opposite of what to do.
//   · SPEND read as "usage limit" on the node badges. The org banner escaped
//     only because it returns early on the org-level `spend_frozen` flag; a
//     badge has no org flag to consult.
//
// Both were unreachable until `ledger.tree()`'s frozen projection was taught
// to carry `cause` and `spend` — it rebuilds the record key by key and drops
// whatever it does not name, so the client could not make the test at all.
//
// ⚠ WHY A LEG PER KIND, AND WHY THE LABELS ARE COMPARED TO EACH OTHER. A
// single "the label is right" case passes while every other kind is silently
// collapsed into `limit` — which is the bug. Totality alone is not enough
// either: a map that answers "usage limit" for all five kinds is total. The
// property that actually matters is that no two kinds share a word, so §3
// asserts DISTINCTNESS, not just presence.
//
// Run:  cd frontend && node tests/run.mjs freezelabel

import './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  freezeKind, FREEZE_LABEL, FREEZE_LABEL_SHORT, type FreezeKind,
} from '../src/canvas/shared'

/** every kind, named here so a new one added to the union without a label is
 *  a failure rather than a silent fall-through */
const KINDS: FreezeKind[] = ['halted', 'spend', 'auth', 'balance', 'connection', 'limit']

// ------------------------------------------------------ §1 classification
test('§1 a leg per kind — each is classified as itself, not as `limit`', () => {
  // usage limit: the default, and the one every other kind used to collapse to
  assert.equal(freezeKind({ limit: true }), 'limit')
  // network: PURE connection only (D-122 — both flags means a limit whose
  // wake waits on the auto-resume toggle)
  assert.equal(freezeKind({ connection: true }), 'connection')
  assert.equal(freezeKind({ connection: true, limit: true }), 'limit',
    'a record carrying BOTH kinds is a limit, not a network freeze')
  // auth: carries limit:true, which is exactly why it used to read as one
  assert.equal(freezeKind({ limit: true, cause: 'auth' }), 'auth',
    'an auth freeze carries limit:true — that is the whole trap')
  // balance (an OpenRouter 402, 2026-09-05): the same limit:true shape, and
  // the same trap — it read "usage limit" while the remedy is the key's credit
  assert.equal(freezeKind({ limit: true, cause: 'balance' }), 'balance',
    'a balance freeze carries limit:true — same trap as auth')
  assert.equal(freezeKind({ limit: true, cause: 'balance' }, true), 'halted')
  // spend
  assert.equal(freezeKind({ spend: true }), 'spend')
  // halted outranks everything: a fable lock's clock can never fire, so any
  // other word here would promise a reset nobody performs
  assert.equal(freezeKind({ limit: true, cause: 'auth' }, true), 'halted')
  assert.equal(freezeKind({ spend: true }, true), 'halted')
  // no record, no kind
  assert.equal(freezeKind(null), null)
  assert.equal(freezeKind(undefined), null)
})

test('§2 precedence is deliberate where kinds coexist', () => {
  // spend outranks limit: a spend freeze is released by RAISING THE LIMIT,
  // not by waiting, so "usage limit" would send the reader to wait
  assert.equal(freezeKind({ spend: true, limit: true }), 'spend')
  // auth outranks limit for the same reason: same shape, different remedy
  assert.equal(freezeKind({ limit: true, cause: 'auth', connection: false }), 'auth')
  // an unknown cause is NOT auth — it must not silently claim a remedy
  assert.equal(freezeKind({ limit: true, cause: 'something-new' }), 'limit')
  assert.equal(freezeKind({ limit: true, cause: null }), 'limit')
})

// ------------------------------------------------------------- §3 the words
test('§3 both registers are TOTAL over the kinds and share no word', () => {
  for (const map of [FREEZE_LABEL, FREEZE_LABEL_SHORT]) {
    for (const k of KINDS) {
      assert.ok(map[k], `no label for kind ${k}`)
    }
    assert.equal(Object.keys(map).length, KINDS.length,
      `label map has entries beyond the known kinds: ${Object.keys(map)}`)
    // THE CHECK THAT CATCHES A COLLAPSED BRANCH. A map answering "usage limit"
    // for everything is total and useless; distinctness is the real property.
    const words = KINDS.map((k) => map[k])
    assert.equal(new Set(words).size, KINDS.length,
      `two kinds share a label, which is the bug this file exists for: ${words}`)
  }
})

test('§4 the words a reader would be misled by are not used for other kinds', () => {
  // the three specific misreadings that shipped
  assert.notEqual(FREEZE_LABEL.auth, FREEZE_LABEL.limit,
    'an auth freeze must not read as a usage limit')
  assert.notEqual(FREEZE_LABEL.spend, FREEZE_LABEL.limit,
    'a spend freeze must not read as a usage limit')
  assert.notEqual(FREEZE_LABEL_SHORT.auth, FREEZE_LABEL_SHORT.limit)
  assert.notEqual(FREEZE_LABEL_SHORT.spend, FREEZE_LABEL_SHORT.limit)
  assert.notEqual(FREEZE_LABEL.balance, FREEZE_LABEL.limit,
    'a balance freeze must not read as a usage limit — a 402 is not a wall')
  assert.notEqual(FREEZE_LABEL_SHORT.balance, FREEZE_LABEL_SHORT.limit)
  // and each names its own remedy rather than a capacity wait
  assert.match(FREEZE_LABEL.auth, /credential/i)
  assert.match(FREEZE_LABEL.spend, /spend/i)
})

// ------------------------------------------ §5 the banner's set-level choice
// The org banner names a cause only when the WHOLE set shares one; a mixed set
// says the count and the action and stops. These are the predicates that block
// drives, tested as values rather than through a render jsdom cannot lay out.
const kindsOf = (recs: Parameters<typeof freezeKind>[0][]) =>
  recs.map((r) => freezeKind(r))

test('§5 the banner names a cause only when the whole set shares one', () => {
  const AUTH = { limit: true, cause: 'auth' }
  const LIM = { limit: true }
  const CONN = { connection: true }

  const allAuth = kindsOf([AUTH, AUTH])
  assert.ok(allAuth.every((k) => k === 'auth'), 'all-auth set names auth')

  const allConn = kindsOf([CONN, CONN])
  assert.ok(allConn.every((k) => k === 'connection'), 'all-connection names network')

  // MIXED — the case that must NOT claim a cause. Under the old two-branch
  // code this fell to "usage limit hit" and over-claimed for the auth member.
  const mixed = kindsOf([AUTH, LIM])
  assert.ok(!mixed.every((k) => k === 'auth'), 'mixed must not claim auth')
  assert.ok(mixed.some((k) => k === 'auth'),
    'mixed must still be DETECTED as containing an auth freeze — this is the '
    + 'test the old code could not make, so it said "usage limit hit"')

  // an all-limit set is the only one that may say "usage limit hit"
  const allLimit = kindsOf([LIM, LIM])
  assert.ok(!allLimit.some((k) => k === 'auth'))
  assert.ok(allLimit.every((k) => k === 'limit'))
})
