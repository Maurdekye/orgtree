// desktabstore.test.ts — the store behind "every desk reopens where it was
// left" (canvas/desktabs.ts; the desks themselves: desktabmemory.test.tsx).
//
// WHAT THIS FILE HOLDS THE CODE TO:
//   §1 a rename moves a node's memory to its new id, and a value already
//      under the new id wins (OrgCanvas's client-state move);
//   §2 without storage the memory lasts the session;
//   §3 hand-edited storage and an id like `__proto__` neither throw nor leak.
//
// Run:  cd apps/desktop/renderer && node tests/run.mjs desktabstore

import './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { deskMemory, moveDeskMemory, rememberDesk } from '../src/canvas/desktabs'

const stored = (slug: string) => JSON.parse(localStorage.getItem('orgtree-desk-tabs:' + slug) ?? 'null') as unknown

test('§1 a rename moves the memory; a value already under the new id wins', () => {
  localStorage.clear()
  rememberDesk('org', 'old', 'tab', 'docket')
  rememberDesk('org', 'old', 'mail', 'listeners')
  rememberDesk('org', 'other', 'tab', 'presented')
  moveDeskMemory('org', 'old', 'new')
  assert.equal(deskMemory('org', 'new', 'tab'), 'docket')
  assert.equal(deskMemory('org', 'new', 'mail'), 'listeners')
  assert.equal(deskMemory('org', 'old', 'tab'), null, 'the old id holds nothing')
  assert.equal(deskMemory('org', 'other', 'tab'), 'presented', 'other desks are untouched')
  rememberDesk('org', 'a', 'tab', 'docket')
  rememberDesk('org', 'b', 'tab', 'team')
  moveDeskMemory('org', 'a', 'b')
  assert.equal(deskMemory('org', 'b', 'tab'), 'team', 'the destination keeps its own value')
  moveDeskMemory('org', 'missing', 'x')
  moveDeskMemory('org', 'b', 'b')
  assert.equal(deskMemory('org', 'x', 'tab'), null, 'nothing to move is a no-op')
  assert.equal(deskMemory('org', 'b', 'tab'), 'team', 'and so is a rename to itself')
  assert.equal(deskMemory('elsewhere', 'new', 'tab'), null, 'organizations are separate')
})

test('§2 when storage refuses a write, the memory lasts the session', (t) => {
  localStorage.clear()
  const proto = Object.getPrototypeOf(localStorage) as Storage
  const setItem = proto.setItem
  proto.setItem = () => { throw new Error('QuotaExceededError') }
  t.after(() => { proto.setItem = setItem })
  rememberDesk('quota', 'writer', 'tab', 'docket')
  assert.equal(deskMemory('quota', 'writer', 'tab'), 'docket', 'the session copy answers')
  assert.equal(localStorage.getItem('orgtree-desk-tabs:quota'), null, 'nothing reached storage')
  proto.setItem = setItem
  rememberDesk('quota', 'writer', 'tab', 'presented')
  assert.equal(deskMemory('quota', 'writer', 'tab'), 'presented')
  assert.deepEqual(stored('quota'), { writer: { tab: 'presented' } }, 'once storage works again it holds the memory')
})

test('§3 hand-edited storage and odd ids neither throw nor leak', () => {
  localStorage.clear()
  for (const bad of ['not json', '[1,2]', '"docket"', 'null', '{"writer":"docket"}', '{"writer":["docket"]}', '{"writer":{"tab":7}}']) {
    localStorage.setItem('orgtree-desk-tabs:org', bad)
    assert.equal(deskMemory('org', 'writer', 'tab'), null, `${bad} remembers nothing`)
  }
  localStorage.setItem('orgtree-desk-tabs:org', '{"writer":"docket"}')
  rememberDesk('org', 'writer', 'tab', 'inbox')
  assert.deepEqual(stored('org'), { writer: { tab: 'inbox' } }, 'a write replaces a malformed entry cleanly')
  rememberDesk('org', '__proto__', 'tab', 'docket')
  assert.equal(deskMemory('org', '__proto__', 'tab'), 'docket', 'an id is only ever a key')
  assert.equal(({} as { tab?: unknown }).tab, undefined, 'no prototype was touched')
  assert.equal(deskMemory('org', 'constructor', 'tab'), null, 'an inherited name is not an entry')
  assert.equal(deskMemory('org', 'toString', 'mail'), null)
})
