import test from 'node:test'
import assert from 'node:assert/strict'
import { mountView, inAct } from './harness'
import { WatchdogLink } from '../src/canvas/watchdoglink'
import { WatchdogSatellite } from '../src/canvas/watchdogchip'
import { dogClick } from '../src/canvas/userdogroute'
import type { Watchdog } from '../src/types'

// a ninth user registration is in the paged watchdog list, not in the canvas's eight-dog preview
const ninth = { id: 'user/u9', owner: 'user', name: 'user-listener', kind: 'project_listener', target: 'test-project', state: 'armed',
  interval_s: 60, fired: 0, once: false, spent: false, at: '2026-11-09T00:00:00Z', events: [] } as unknown as Watchdog

test('a paged-list row and a canvas chip hand their own dog to the opener, so a dog outside the preview still routes', async t => {
  const opened: Array<[string, Watchdog | undefined]> = []
  const v = await mountView(<>
    <WatchdogLink dog={ninth} onOpen={(id, dog) => opened.push([id, dog])} />
    <WatchdogSatellite dog={ninth} dogs={[]} org="demo" onOpen={(id, dog) => opened.push([id, dog])} />
  </>, el => el)
  t.after(() => v.unmount())
  for (const b of v.el.querySelectorAll('button')) await inAct(() => (b as HTMLElement).click())
  assert.equal(opened.length, 2)
  for (const [id, dog] of opened) {
    assert.equal(id, 'user/u9')
    assert.equal(dog, ninth, 'the dog the row shows is passed along')
    assert.deepEqual(dogClick(dog, p => p === 'test-project'), { to: 'listeners', project: 'test-project' }, 'it routes to the project surface, not the gone toast')
  }
})
