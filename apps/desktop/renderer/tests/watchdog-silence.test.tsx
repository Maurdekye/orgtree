import { mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { WatchdogPanel } from '../src/canvas/modals'
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
