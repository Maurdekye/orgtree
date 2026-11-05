import './harness'
import { inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { EventCard } from '../src/events/card'
import { EventHeadlineSetting } from '../src/canvas/eventheadlinesetting'
import { eventHeadlineOn, setEventHeadlineOn } from '../src/events/cardheadline'

// USER 2026-11-05 m2f08b7c44dcc / m2edcc8040105: the card headline is an optional Display toggle, off by default.
const KEY = 'orgtree-event-card-headline'
const chat = JSON.stringify({ kind: 'chat.message', text: 'hello from chat', viewer: { name: 'viewer_one' }, flags: [] }, null, 2)
const line = '2026-11-05T14:30:00.000Z  120 bytes\n' + chat.split('\n').map(l => '    │ ' + l).join('\n')
const ev = { v: 1, variant: 'monitor.watchdog_fired', actor: { kind: 'watchdog', id: 'ws' }, engine_authored: false,
  object: { kind: 'watchdog', org: 'org', id: 'ws', name: 'ws', owner: 'coordinator' },
  prefix: 'WEBSOCKET —', lines: [line], count: 1, once: false, source: 'websocket' }

test('off by default, only "1" turns it on; the Display toggle flips every open card live and persists', async t => {
  localStorage.clear()
  assert.equal(eventHeadlineOn(), false, 'default off')
  localStorage.setItem(KEY, 'invalid'); assert.equal(eventHeadlineOn(), false, 'junk reads as off')
  localStorage.clear()
  const v = await mountView(<><EventHeadlineSetting /><EventCard org="org" profile="operator" row={{ ev, body: 'mail text' }} /></>, el => el)
  t.after(async () => { await v.unmount(); localStorage.clear() })
  const toggle = v.el.querySelector<HTMLInputElement>('input[role="switch"]')!
  assert.ok(toggle && !toggle.checked, 'the switch starts off')
  assert.match(v.el.textContent ?? '', /Show event message text as the card headline/)
  assert.ok(!v.el.querySelector('.event-headline'), 'off: no headline')
  await inAct(() => toggle.click())
  assert.equal(localStorage.getItem(KEY), '1', 'persisted')
  assert.ok(toggle.checked)
  assert.ok(v.el.querySelector('.event-headline'), 'on: the open card changes at once, no remount')
  await inAct(() => toggle.click())
  assert.equal(localStorage.getItem(KEY), '0')
  assert.ok(!v.el.querySelector('.event-headline'), 'off again: back to the plain view')
  await inAct(() => { setEventHeadlineOn(true) })
  assert.ok(v.el.querySelector('.event-headline'), 'another window writing the same preference also flips it')
})
