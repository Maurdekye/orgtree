// userlinks.test.tsx — the user's registrations in the canvas's derived
// state (docket let-the-user-manually-hold-a-number-of-a-project; the engine
// names the user "user", a reserved word; the user is no node of the tree).
//
// WHAT THIS FILE HOLDS THE CODE TO:
//   §1 the count the cards and watches read includes the user's listeners
//      and mail listeners (an armed user dog counts as one), and the cards
//      name them
//   §2 the user DOES draw canvas lines, from the switchboard (USER
//      2026-10-21 22:18Z, replacing the earlier "no line" rule): the slot,
//      listener and fair-queue helpers keep their rows, owner "user"
//      (the mounted lines are held to userlines.test.tsx)
//
// Run:  cd apps/desktop/renderer && node tests/run.mjs userlinks

import test from 'node:test'
import assert from 'node:assert/strict'
import { listenerCards, listenerLinks, mailListenerState, mailQueueCard, projectListenerState } from '../src/canvas/listeners'
import { heldSlotCount, projectSlotState, slotLinks } from '../src/canvas/slots'
import { fairQueueLinks } from '../src/canvas/shared'
import type { Watchdog } from '../src/types'

const dog = (kind: Watchdog['kind'], owner: string, name: string, extra: Partial<Watchdog> = {}): Watchdog =>
  ({ id: owner + '/' + name, owner, name, kind, target: 'sync', interval_s: 5, state: 'armed',
    at: '2026-10-20T07:00:00.000Z', fired: 0, once: false, spent: false, ...extra } as Watchdog)
const isProject = (p: string) => p === 'sync'

test('§1 the user\'s listeners count toward the cards and the watches\' count', () => {
  const dogs = [dog('project_listener', 'sa', 'a'), dog('project_listener', 'user', 'u1'),
    dog('listener_watch', 'boss', 'w', { count: 3 })]
  const state = projectListenerState('sync', dogs)
  assert.equal(state.armed.length, 2, 'the user\'s armed listener is one of them')
  const [card] = listenerCards('sync', state)
  assert.equal(card!.text, 'listeners 2/3')
  assert.match(card!.title, /sa, user/, 'the card names the user as the engine does')
  const mail = mailQueueCard('sync', 1, 0, false, [dog('fair_queue', 'sa', 'q'), dog('fair_queue', 'user', 'uq')])
  assert.equal(mail!.listeners, 2)
  assert.match(mail!.text, /2 listeners/)
  assert.equal(mailListenerState('sync', [dog('fair_queue', 'user', 'uq')]).armed.length, 1)
})

test('§1 the user\'s held slots count and the user waits in the same line', () => {
  const leases = [{ project: 'sync', agent: 'user', slot: 1, slots: 2, lease: 'sU', since: '2026-10-20T09:00:00Z' },
    { project: 'sync', agent: 'dev', slot: 2, slots: 1, lease: 'sD', since: '2026-10-20T09:00:00Z' }]
  const waiting = [dog('slot', 'user', 'uh', { queued_at: '2026-10-20T09:10:00Z', slots: 1 }),
    dog('slot', 'qa', 'w', { queued_at: '2026-10-20T09:11:00Z' })]
  const state = projectSlotState('sync', 3, leases, waiting)
  assert.equal(heldSlotCount(state), 3, 'the user\'s two slots count against the three')
  assert.deepEqual(state.line.map((w) => w.agent), ['user', 'qa'], 'first come first served, the user among the agents')
})

test('§2 the user rows come through the line helpers', () => {
  const dogs = [dog('slot', 'user', 'uh', { queued_at: '2026-10-20T09:10:00Z' }), dog('slot', 'qa', 'w', { queued_at: '2026-10-20T09:11:00Z' }),
    dog('project_listener', 'user', 'u1'), dog('project_listener', 'sa', 'a'), dog('fair_queue', 'user', 'uq'), dog('fair_queue', 'sa', 'q')]
  const leases = [{ project: 'sync', agent: 'user', slot: 1, lease: 'sU', since: '2026-10-20T09:00:00Z' },
    { project: 'sync', agent: 'dev', slot: 2, lease: 'sD', since: '2026-10-20T09:00:00Z' }]
  assert.deepEqual(slotLinks(dogs, leases, isProject).map((l) => l.owner).sort(), ['dev', 'qa', 'user', 'user'])
  assert.deepEqual(listenerLinks(dogs, isProject).map((l) => l.owner).sort(), ['sa', 'user'])
  assert.deepEqual(fairQueueLinks(dogs, isProject).map((l) => l.owner).sort(), ['sa', 'user'])
})
