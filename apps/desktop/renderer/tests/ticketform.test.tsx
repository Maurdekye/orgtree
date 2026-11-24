// THE @ticket: FORM (USER 2026-11-24 mb9bc017ee96e "also allow the @ticket: prefix to list all tickets, as well
// as @item:"; mc6e8d9a7dab7 "and actually make that the canonical way to mention a ticket now (as the docs
// mention), but keep @item: as working"). One ticket, two written forms: both parse to the same reference,
// both are the same link, chip and transcript mention; what the app writes is @ticket:; text that says @item:
// is shown as it was written.
//
// Run: node apps/desktop/renderer/tests/run.mjs ticketform
import './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { findRefs, parseRef } from '../src/canvas/workrefs'
import { refToken, splitTypedRefs } from '../src/canvas/reflinks'
import type { RefWorld } from '../src/canvas/reflinks'
import { extractMentionRecency, MENTION_PREFIXES } from '../src/canvas/agentmentions'

test('both forms parse to the same ticket, and neither is guessed from a malformed token', () => {
  const old = parseRef('@item:alpha/fix-login'), now = parseRef('@ticket:alpha/fix-login')
  assert.deepEqual({ ...old }, { kind: 'item', org: 'alpha', id: 'fix-login' }, 'POSITIVE CONTROL: the old form')
  assert.deepEqual({ ...now }, { ...old }, 'the new form is the same reference')
  for (const bad of ['@ticket:alpha/a/b', '@ticket:Org/Thing', '@ticket:alpha/not-a-node@4', '@tickets:alpha/a', '@ticket:alpha'])
    assert.equal(parseRef(bad), null, `${bad} is no reference`)
})

test('prose is scanned for both forms with the same boundaries', () => {
  assert.deepEqual(findRefs('see @ticket:alpha/a, then @item:alpha/b.'), [['item', 'alpha/a'], ['item', 'alpha/b']])
  assert.deepEqual(findRefs('@agent:alpha/one@ticket:alpha/two'), [['agent', 'alpha/one'], ['item', 'alpha/two']], 'two adjacent references both survive')
  assert.deepEqual(findRefs('@item:alpha/one@ticket:alpha/two'), [['item', 'alpha/one'], ['item', 'alpha/two']])
  assert.deepEqual(findRefs('word@ticket:alpha/x and @ticket:alpha/one/extra'), [], 'inside a word, or with more after it, it is no reference')
})

test('the app writes @ticket:', () => {
  assert.equal(refToken({ kind: 'item', org: 'alpha', id: 'fix-login' }), '@ticket:alpha/fix-login')
})

test('an old @item: link resolves as the same ticket, and its text stays as it was written', () => {
  const world: RefWorld = { org: 'acme', items: new Map([['fix-login', 'fix-login']]) }
  const runs = splitTypedRefs('old @item:acme/fix-login new @ticket:acme/fix-login gone @item:acme/gone and @ticket:acme/gone', world).filter(r => r.ref)
  assert.deepEqual(runs.map(r => r.text), ['@item:acme/fix-login', '@ticket:acme/fix-login', '@item:acme/gone', '@ticket:acme/gone'], 'each run is the text as written')
  const [old, now, oldGone, nowGone] = runs.map(r => r.ref!)
  assert.equal(old!.outcome, 'ready', 'POSITIVE CONTROL: the old form opens its ticket')
  assert.deepEqual([now!.outcome, now!.label, { ...now!.ref }], [old!.outcome, old!.label, { ...old!.ref }], 'the new form is the same link')
  assert.deepEqual([oldGone!.outcome, nowGone!.outcome], ['absent', 'absent'])
  // a chip that cannot open shows its token: the one the writer wrote, never a rewritten one
  assert.deepEqual([oldGone!.token, nowGone!.token], ['@item:acme/gone', '@ticket:acme/gone'])
})

test('a transcript mentions a ticket by either form: one ticket, one recency', () => {
  const seen = extractMentionRecency(['first @item:acme/weekly-plan and @item:acme/fix-login', 'later @ticket:acme/weekly-plan'])
  assert.ok(seen.get('item:acme/fix-login'), 'POSITIVE CONTROL: the old form counts')
  assert.ok((seen.get('item:acme/weekly-plan') ?? 0) > (seen.get('item:acme/fix-login') ?? 0), 'the later @ticket: mention is the newest mention of that ticket')
  assert.equal(seen.has('ticket:acme/weekly-plan'), false, 'under the ticket\u2019s one key')
})

test('@ticket: is a kind prefix of the @ menu, the same as @item:', () => {
  assert.deepEqual(MENTION_PREFIXES.ticket, MENTION_PREFIXES.item)
  assert.deepEqual(MENTION_PREFIXES.item, { kind: 'ticket', search: 'item' }, 'POSITIVE CONTROL: @item: still lists tickets')
})
