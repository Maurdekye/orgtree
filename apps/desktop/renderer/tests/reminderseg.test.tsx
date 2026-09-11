// show-automatic-docket-reminders-in-transcripts — the desk half.
//
// An automatic wake (the idle-docket reminder, the working checkup) now reaches
// the transcript as a machine-context `state` segment carrying its typed event.
// This mounts the REAL SegmentList and asserts three things about it:
//
//   1. the wake draws a labelled Reminder card naming its items and statuses;
//   2. the machine-state segments beside it (org state, provider usage, the
//      mail-pointer nudge) still draw NOTHING — the disposition gate is a gate,
//      not a rubber stamp, and that is what keeps the turn envelope off screen;
//   3. the card's body rides the collapsible preview, so a twenty-item
//      reminder cannot out-shout the turn it explains.
//
// §2 is the positive control for §1: if `humanSegmentEvent` stopped hiding
// anything, §1 would pass for the wrong reason.
import './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { mountView } from './harness'
import { SegmentList } from '../src/events/segments'
import type { Event, Segment } from '../src/generated/events'

declare const __SRC_DIR__: string
const fixture = (name: string) => JSON.parse(readFileSync(
  path.resolve(__SRC_DIR__, '../tests/fixtures/events/' + name + '.json'), 'utf8'))

const REMINDER = fixture('reminder.idle_docket')
const CHECKUP = fixture('reminder.working_checkup')
const ORG_STATE = fixture('context.org_state')
const NUDGE = fixture('context.drive_mail_pointer')

/** the composition a reminder wake actually produces: hidden machine state,
 *  the visible wake, and the hidden nudge that drove the turn */
const wakeSegments = (event: Event, text: string): Segment[] => [
  { kind: 'state', event: ORG_STATE.private as Event, text: '[ORG STATE #1 …]' },
  { kind: 'state', event: event, text },
  { kind: 'drive', event: NUDGE.private as Event, text: '(orgtree) you have new mail' },
]

const view = (segments: Segment[]) => mountView(
  <SegmentList segments={segments} profile="operator" slug="orgtree" nid="agent" />,
  el => el)

test('an idle-docket wake draws a labelled reminder card with its items', async () => {
  const mounted = await view(wakeSegments(REMINDER.private as Event, REMINDER.body))
  const cards = [...mounted.el.querySelectorAll('[data-event-variant]')]
    .map(n => n.getAttribute('data-event-variant'))
  assert.deepEqual(cards, ['reminder.idle_docket'],
    'exactly the wake is drawn, and the envelope around it is not')
  const card = mounted.el.querySelector('[data-event-variant="reminder.idle_docket"]')!
  assert.match(card.className, /event-reminder/, 'the Reminder family treatment')
  assert.match(card.textContent ?? '', /Docket reminder/, 'the card is labelled')
  assert.match(card.textContent ?? '',
    new RegExp(REMINDER.private.items[0].slug.replace(/[.·[\]]/g, '\\$&')),
    'the item it names is on screen')
  assert.match(card.textContent ?? '',
    new RegExp(REMINDER.private.items[0].status.replace(/[.·[\]]/g, '\\$&')),
    'and its status')
  await mounted.unmount()
})

test('the machine-state envelope around the wake still draws nothing', async () => {
  // the control: the SAME composition minus the wake must render no card at all
  const mounted = await view([
    { kind: 'state', event: ORG_STATE.private as Event, text: '[ORG STATE #1 …]' },
    { kind: 'drive', event: NUDGE.private as Event, text: '(orgtree) you have new mail' },
  ])
  assert.equal(mounted.el.querySelectorAll('[data-event-variant]').length, 0)
  assert.equal((mounted.el.textContent ?? '').trim(), '',
    'a hidden segment must leave no heading, no stub and no raw block text')
  await mounted.unmount()
})

test('a working checkup wake draws its own card by the same rule', async () => {
  const mounted = await view(wakeSegments(CHECKUP.private as Event, CHECKUP.body))
  const card = mounted.el.querySelector('[data-event-variant="reminder.working_checkup"]')
  assert.ok(card, 'the other automatic wake draws nothing')
  assert.match(card!.textContent ?? '', /Progress checkup/)
  await mounted.unmount()
})

test('the wake card body rides the collapsible preview', async () => {
  const mounted = await view(wakeSegments(REMINDER.private as Event, REMINDER.body))
  const card = mounted.el.querySelector('[data-event-variant="reminder.idle_docket"]')!
  assert.ok(card.querySelector('.turn-mail-preview'),
    'the body is not foldable: a long reminder would out-shout its turn')
  await mounted.unmount()
})
