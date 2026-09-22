// The held-event queue, driven directly.
//
// The property under test is a NEGATIVE one and it is the whole reason this
// module exists: nothing here may ever mark an event delivered on its own. An
// earlier revision sent held events once a grace expired, which discharges them
// whether or not anybody is listening — the original loss with a delay in front
// of it. So most of these tests are about what does NOT happen when no consumer
// ever appears.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { build } from 'esbuild'
import { createRequire } from 'node:module'

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'orgtree-outbox-test-'))
const out = path.join(temp, 'window-outbox.cjs')
await build({ entryPoints: ['apps/desktop/main/window-outbox.ts'], outfile: out, bundle: true, platform: 'node', format: 'cjs' })
const { windowOutbox } = createRequire(import.meta.url)(out)

const HELD = new Set(['open-org', 'notification-click', 'window-identity', 'restore-skipped'])
const make = (limit) => windowOutbox({ hold: type => HELD.has(type), ...(limit ? { limit } : {}) })
const ev = (type, n = 0) => ({ type, data: n })

test('an event a renderer can re-read is never held', () => {
  const outbox = make()
  for (const type of ['window-state', 'popout-state', 'main-window-shown', 'engine-status', 'preferences', 'update']) {
    assert.equal(outbox.offer(ev(type)), true, type)
  }
  assert.equal(outbox.pending(), 0, 'holding one could only hand over a stale duplicate')
  assert.equal(outbox.holding(), true, 'and sending them does not end the holding')
})

test('an event a renderer cannot rediscover is held until there is somewhere to send it', () => {
  const outbox = make()
  for (const type of [...HELD]) assert.equal(outbox.offer(ev(type)), false, type)
  assert.equal(outbox.pending(), 4)
})

test('NEGATIVE CONTROL: with no consumer, nothing is ever marked delivered', () => {
  // The case the timer got wrong. A window whose renderer never arrives - it
  // crashed before mounting, it is a holding page, it is simply slow - must
  // keep its events, not have them counted as sent to nobody.
  const outbox = make()
  outbox.offer(ev('open-org', 1))
  outbox.offer(ev('notification-click', 2))
  // time passing is not an event; nothing in this module observes a clock
  assert.equal(outbox.holding(), true)
  assert.equal(outbox.pending(), 2)
  assert.equal(outbox.dropped(), 0)
  // and they are still all there whenever a consumer does appear
  assert.deepEqual(outbox.drain().map(e => e.data), [1, 2])
})

test('draining is idempotent, so a listener signal and an explicit request cannot double-deliver', () => {
  const outbox = make()
  outbox.offer(ev('open-org', 1))
  assert.deepEqual(outbox.drain().map(e => e.data), [1])
  assert.deepEqual(outbox.drain(), [], 'the second caller gets nothing rather than a copy')
  assert.equal(outbox.holding(), false)
})

test('once anything has drained, every event goes live — including held types', () => {
  const outbox = make()
  outbox.offer(ev('open-org', 1))
  outbox.drain()
  assert.equal(outbox.offer(ev('open-org', 2)), true, 'a listener exists now, so it is sent')
  assert.equal(outbox.offer(ev('notification-click', 3)), true)
  assert.equal(outbox.pending(), 0)
})

test('LISTENER ORDER: a listener that arrives before any event changes nothing', () => {
  // The ordinary case, and the one that must not be special: a renderer that
  // is already listening simply receives everything live.
  const outbox = make()
  assert.deepEqual(outbox.drain(), [], 'draining an empty queue is legitimate')
  assert.equal(outbox.offer(ev('open-org', 1)), true)
  assert.equal(outbox.offer(ev('restore-skipped', 2)), true)
  assert.equal(outbox.pending(), 0)
})

test('LISTENER ORDER: events before, during and after the drain each go exactly once', () => {
  const outbox = make()
  outbox.offer(ev('open-org', 'before'))
  const held = outbox.drain()
  assert.deepEqual(held.map(e => e.data), ['before'])
  assert.equal(outbox.offer(ev('open-org', 'after')), true)
  // 'before' was returned once and is gone; 'after' was never queued
  assert.equal(outbox.pending(), 0)
  assert.deepEqual(outbox.drain(), [])
})

test('the bound drops the OLDEST and says how many, rather than pretending the newest was seen', () => {
  const outbox = make(3)
  for (let i = 1; i <= 6; i++) outbox.offer(ev('open-org', i))
  assert.equal(outbox.pending(), 3)
  assert.deepEqual(outbox.drain().map(e => e.data), [4, 5, 6],
    'a superseded navigation is the one worth losing')
  assert.equal(outbox.dropped(), 3, 'and the loss is reported rather than silent')
})

test('the bound counts only held events, so live traffic cannot evict them', () => {
  const outbox = make(2)
  outbox.offer(ev('open-org', 1))
  for (let i = 0; i < 50; i++) outbox.offer(ev('window-state', i))
  outbox.offer(ev('notification-click', 2))
  assert.deepEqual(outbox.drain().map(e => e.data), [1, 2])
  assert.equal(outbox.dropped(), 0)
})

test('arrival order is preserved across the whole queue', () => {
  const outbox = make()
  const order = ['open-org', 'window-identity', 'notification-click', 'restore-skipped', 'open-org']
  order.forEach((type, i) => outbox.offer(ev(type, i)))
  assert.deepEqual(outbox.drain().map(e => e.data), [0, 1, 2, 3, 4])
})

// ------------------------------------------------- evidence is per-document

test('NEGATIVE CONTROL (f4): a navigation re-arms, because the listener it proved is gone', () => {
  // The proof that somebody is listening IS a listener, and a listener belongs
  // to a document. Navigate the window and the document, its preload instance
  // and its listener are all destroyed and rebuilt — but this queue lives on
  // the WINDOW and outlives all of them. Treating one-time evidence as
  // permanent sends the next document's events live into a webContents with
  // no listener: lost, and counted as delivered.
  const outbox = make()
  outbox.offer(ev('open-org', 'first-document'))
  assert.deepEqual(outbox.drain().map(e => e.data), ['first-document'])
  assert.equal(outbox.offer(ev('open-org', 'live')), true, 'live while that document is showing')

  outbox.rearm()                                  // the window navigated
  assert.equal(outbox.holding(), true)
  assert.equal(outbox.offer(ev('notification-click', 'mid-flight')), false,
    'an event arriving during the load is held, not sent into the gap')
  // the new document attaches its own listener and acknowledges
  assert.deepEqual(outbox.drain().map(e => e.data), ['mid-flight'])
  assert.equal(outbox.offer(ev('open-org', 'live-again')), true)
})

test('a reload suspends delivery before commit and needs a replacement listener afterwards', () => {
  const outbox = make()
  outbox.drain()
  outbox.suspend()
  assert.equal(outbox.offer(ev('notification-click', 'reveal-for-acme')), false)
  assert.deepEqual(outbox.drain(), [], 'old listener cannot take during navigation')
  outbox.rearm()
  assert.deepEqual(outbox.resume(), [], 'commit does not invent a new listener')
  assert.deepEqual(outbox.drain().map(e => e.data), ['reveal-for-acme'])
})

test('f4: re-arming is idempotent and never resurrects what was already handed over', () => {
  const outbox = make()
  outbox.offer(ev('open-org', 1))
  assert.deepEqual(outbox.drain().map(e => e.data), [1])
  outbox.rearm()
  outbox.rearm()
  assert.equal(outbox.holding(), true)
  assert.deepEqual(outbox.drain(), [], 'a delivered event does not come back on the next document')
})

test('f4: many navigations with nothing in flight cost nothing', () => {
  const outbox = make()
  for (let i = 0; i < 20; i++) { outbox.rearm(); outbox.drain() }
  assert.equal(outbox.pending(), 0)
  assert.equal(outbox.dropped(), 0)
  assert.equal(outbox.offer(ev('open-org', 1)), true, 'and the last drain still counts')
})
