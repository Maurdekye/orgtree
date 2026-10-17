import { advance, mountView, realClock, useFakeClock } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { WatchdogPanel } from '../src/canvas/modals'
import { watchdogCountdownText } from '../src/canvas/watchdogcountdown'
import type { Watchdog } from '../src/types'

const noop = () => {}
const base: Watchdog = {
  id: 'wd-test', owner: 'boss', name: 'activity', kind: 'activity', target: 'child',
  state: 'armed', interval_s: 60, fired: 0, once: false, spent: false,
  at: '2026-10-02T18:00:00.000Z', events: [],
}

test('activity silence panel explains target, matching timer and repeated resets', async (t) => {
  const view = await mountView(<WatchdogPanel slug="test" dog={{ ...base,
    fire_mode: 'silence', quiet_period_s: 600, pattern: '^tool_call' }}
    toast={noop} close={noop} />, host => host)
  t.after(() => view.unmount())
  assert.match(view.el.textContent ?? '', /watched agent/)
  assert.match(view.el.textContent ?? '', /child/)
  assert.match(view.el.textContent ?? '', /600s without a matching event/)
  assert.match(view.el.textContent ?? '', /resets after each match and fire/)
  assert.match(view.el.textContent ?? '', /events that reset the silence timer/)
})

test('legacy panel defaults to event mode', async (t) => {
  const view = await mountView(<WatchdogPanel slug="test" dog={base}
    toast={noop} close={noop} />, host => host)
  t.after(() => view.unmount())
  assert.match(view.el.textContent ?? '', /on a matching event/)
  assert.doesNotMatch(view.el.textContent ?? '', /on silence/)
})

test('periodic watchdog detail shows next-check countdown from last_check', async (t) => {
  const now = Date.parse('2026-10-17T12:00:17.000Z')
  t.mock.method(Date, 'now', () => now)
  const view = await mountView(<WatchdogPanel slug="test" dog={{ ...base,
    kind: 'file', target: 'watch.log', interval_s: 60,
    last_check: '2026-10-17T12:00:00.000Z' }}
    toast={noop} close={noop} />, host => host)
  t.after(() => view.unmount())
  assert.match(view.el.textContent ?? '', /next check in 0:43/)
})

test('watchdog countdown is omitted for non-periodic, paused and unknown schedules', async (t) => {
  const cases: Array<[string, Partial<Watchdog>]> = [
    ['event', { kind: 'event', last_check: '2026-10-17T12:00:00.000Z' }],
    ['stream', { kind: 'stream', last_check: '2026-10-17T12:00:00.000Z' }],
    ['activity', { kind: 'activity', last_check: '2026-10-17T12:00:00.000Z' }],
    ['paused', { kind: 'file', state: 'paused', last_check: '2026-10-17T12:00:00.000Z' }],
    ['unknown', { kind: 'file' }],
  ]
  for (const [name, patch] of cases) {
    const view = await mountView(<WatchdogPanel slug="test" dog={{ ...base, ...patch }}
      toast={noop} close={noop} />, host => host)
    assert.doesNotMatch(view.el.textContent ?? '', /next check in|checking…/, name)
    await view.unmount()
  }
})

test('watchdog countdown ticks locally without a refreshed row', async (t) => {
  useFakeClock()
  const checkedAt = new Date(Date.now()).toISOString()
  const dog = { ...base, kind: 'file' as const, interval_s: 60, last_check: checkedAt }
  const view = await mountView(<WatchdogPanel slug="test" dog={dog}
    toast={noop} close={noop} />, host => host.textContent ?? '')
  t.after(async () => { await view.unmount(); realClock() })
  assert.match(view.el.textContent ?? '', /next check in 1:00/)
  await advance(1_000)
  assert.match(view.el.textContent ?? '', /next check in 0:59/)
})

test('overdue polling shows a short checking grace, then rolls to the next interval', () => {
  const dog: Watchdog = { ...base, kind: 'command', interval_s: 60,
    last_check: '2026-10-17T12:00:00.000Z' }
  assert.equal(watchdogCountdownText(dog, Date.parse('2026-10-17T12:01:02.000Z')), 'checking…')
  assert.equal(watchdogCountdownText(dog, Date.parse('2026-10-17T12:01:04.000Z')), 'next check in 0:56')
})

test('silence deadline may shorten the next periodic check', () => {
  const dog: Watchdog = { ...base, kind: 'process', interval_s: 60, fire_mode: 'silence',
    quiet_period_s: 20, silence_since: '2026-10-17T12:00:30.000Z',
    last_check: '2026-10-17T12:00:00.000Z' }
  assert.equal(watchdogCountdownText(dog, Date.parse('2026-10-17T12:00:17.000Z')), 'next check in 0:33')
})
