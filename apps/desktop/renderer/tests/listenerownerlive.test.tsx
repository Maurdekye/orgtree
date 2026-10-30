// listenerownerlive.test.tsx - the listener helpers behind
// retiredlisteners.test.tsx (docket project-listeners-list-shows-retired-agents-
// paus; USER 2026-10-30 08:37:43Z m401e6ff93d21 "retired listeners should not
// show up in this list"): `listenersLive` and the optional `live` argument of the
// state builders, so a retired agent's dog is not a project's listener, a card
// count or an answer to "does anyone listen?". Without the argument nothing
// changes, which keeps every caller that has no node map exactly as it was.
//
// Run:  cd apps/desktop/renderer && node tests/run.mjs listenerownerlive

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  deadLetterListeners, listenerCards, mailListenerState, mailQueueCard, listenersLive, projectListenerState,
} from '../src/canvas/listeners'
import { inboxListened } from '../src/canvas/inboxwarning'
import { projectHeaderFacts } from '../src/canvas/projectheaderfacts'
import type { CanvasNode } from '../src/canvas/shared'
import type { Watchdog } from '../src/types'

const agent = (id: string, state = 'live', parent = 'sync'): CanvasNode =>
  ({ id, state, tier: 'haiku', children: [], parent } as unknown as CanvasNode)
const map = new Map<string, CanvasNode>([
  ['sync', { id: 'sync', state: 'live', kind: 'project', tier: 'project', children: [] } as unknown as CanvasNode],
  ['live', agent('live')], ['old', agent('old', 'archived')], ['lost', agent('lost', 'unrecoverable')],
])
const live = listenersLive(map)

const dog = (kind: Watchdog['kind'], owner: string, name: string, extra: Partial<Watchdog> = {}): Watchdog =>
  ({ id: owner + '/' + name, owner, name, kind, target: 'sync', interval_s: 5, state: 'armed',
    at: '2026-10-19T07:00:00.000Z', fired: 0, once: false, spent: false, ...extra } as Watchdog)

const w = (owner: string, state: Watchdog['state'] = 'paused') => ({ owner, state })
test('listenersLive: live agents and the user; not archived, unrecoverable or absent ones', () => {
  assert.equal(live(w('live')), true)
  assert.equal(live(w('live', 'armed')), true)
  assert.equal(live(w('user')), true, 'the user is no tree node and always listens')
  assert.equal(live(w('old')), false, 'retired, still in the map')
  assert.equal(live(w('old', 'armed')), false, 'whatever the dog\'s state')
  assert.equal(live(w('lost')), false)
  assert.equal(live(w('gone')), false, 'retired and no longer in the tree at all: its dog is paused')
  assert.equal(live(w('fresh', 'armed')), true, 'an ARMED dog of an owner the map has not caught up with is a new hire, not a retirement')
})

test('projectListenerState: a retired owner\'s listeners and watches are not the project\'s', () => {
  const dogs = [
    dog('project_listener', 'live', 'a'), dog('project_listener', 'live', 'b', { state: 'paused' }),
    dog('project_listener', 'old', 'c', { state: 'paused' }), dog('project_listener', 'gone', 'd', { state: 'paused' }),
    dog('listener_watch', 'live', 'w', { count: 1 }), dog('listener_watch', 'old', 'x', { count: 1, state: 'paused' }),
  ]
  const s = projectListenerState('sync', dogs, live)
  assert.deepEqual(s.listeners.map(w => w.name), ['a', 'b'])
  assert.deepEqual(s.watches.map(w => w.name), ['w'])
  assert.equal(projectListenerState('sync', dogs).listeners.length, 4, 'no predicate, no change')
})

test('mailListenerState and the queue card: a retired owner is not listed, and an armed one is not counted', () => {
  const dogs = [
    dog('fair_queue', 'live', 'q1'), dog('fair_queue', 'live', 'q2', { state: 'paused' }),
    // the pause at retirement is a transaction later than the retire in some paths: even armed, it is not a listener
    dog('fair_queue', 'old', 'q3'), dog('fair_queue', 'gone', 'q4', { state: 'paused' }), dog('fair_queue', 'fresh', 'q5'),
  ]
  const s = mailListenerState('sync', dogs, live)
  assert.deepEqual(s.listeners.map(w => w.name), ['q1', 'q2', 'q5'], 'q5\'s owner is armed and not in the map yet: shown')
  assert.deepEqual(s.armed.map(w => w.name), ['q1', 'q5'])
  assert.equal(mailQueueCard('sync', 0, 0, false, dogs, live)?.text, '2 listeners')
  assert.equal(mailQueueCard('sync', 0, 0, false, dogs)?.text, '3 listeners', 'no predicate, no change')
  assert.equal(inboxListened('sync', [dog('fair_queue', 'old', 'q3', { state: 'paused' })], live), false)
  assert.equal(inboxListened('sync', [dog('fair_queue', 'live', 'q2', { state: 'paused' })], live), true, 'a live agent\'s paused one is attached')
  assert.equal(inboxListened('sync', [dog('fair_queue', 'user', 'mine')], live), true)
})

test('the header facts read the same rule', () => {
  const node = map.get('sync')!
  const dogs = [dog('project_listener', 'old', 'e'), dog('fair_queue', 'old', 'q')]
  const bare = projectHeaderFacts(node, { watchdogs: dogs, slot_leases: [] })
  assert.equal(bare.listenerBadges.length, 1, 'without the rule an armed retired dog is a badge')
  const facts = projectHeaderFacts(node, { watchdogs: dogs, slot_leases: [] }, live)
  assert.equal(facts.listenerBadges.length, 0)
  assert.equal(facts.queue, null)
  assert.deepEqual(listenerCards('sync', projectListenerState('sync', dogs, live)), [])
})

test('the dead-letter line drops a retired owner too', () => {
  const dl = (owner: string) => dog('event', owner, 'dead', { target: 'project.dead_letter', state: 'paused' })
  const m = new Map(map)
  m.set('sync', { ...map.get('sync')!, parent: 'boss', children: [] } as CanvasNode)
  m.set('boss', { id: 'boss', state: 'live', tier: 'opus', children: [] } as unknown as CanvasNode)
  m.set('old', { ...map.get('old')!, parent: 'sync' } as CanvasNode)
  assert.deepEqual(deadLetterListeners('sync', [dl('live'), dl('old')], m).map(w => w.owner), ['live'])
})
