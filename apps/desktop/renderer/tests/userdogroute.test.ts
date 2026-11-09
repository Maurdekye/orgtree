import test from 'node:test'
import assert from 'node:assert/strict'
import { dogClick, withRoutedDogs } from '../src/canvas/userdogroute'
import type { Watchdog } from '../src/types'

const dog = (over: Partial<Watchdog>): Watchdog => ({ id: 'user/u1', owner: 'user', name: 'user-listener', kind: 'project_listener',
  target: 'test-project', state: 'armed', interval_s: 60, fired: 0, once: false, spent: false, at: '2026-11-09T00:00:00Z', events: [], ...over } as Watchdog)
const has = (id: string) => id === 'test-project'

test("a user-owned listener or watch chip opens the project's listeners panel, never the dead dialog", () => {
  assert.deepEqual(dogClick(dog({}), has), { to: 'listeners', project: 'test-project' })
  assert.deepEqual(dogClick(dog({ kind: 'listener_watch' }), has), { to: 'listeners', project: 'test-project' })
  assert.deepEqual(dogClick(dog({ target: '@test-project' }), has), { to: 'listeners', project: 'test-project' }, 'an @ target is the same project')
})

test("a user-owned slot chip opens the slots panel; a queue place opens the project desk", () => {
  assert.deepEqual(dogClick(dog({ kind: 'slot' }), has), { to: 'slots', project: 'test-project' })
  assert.deepEqual(dogClick(dog({ kind: 'fair_queue' }), has), { to: 'desk', project: 'test-project' })
})

test('any other user-owned kind falls back to the project desk', () => {
  assert.deepEqual(dogClick(dog({ kind: 'event' }), has), { to: 'desk', project: 'test-project' })
})

test('a user dog whose project is gone, or a dog that is gone, says so', () => {
  assert.deepEqual(dogClick(dog({ target: 'retired-project' }), has), { to: 'gone' })
  assert.deepEqual(dogClick(undefined, has), { to: 'gone' })
})

test('an agent-owned dog still opens the detail dialog', () => {
  assert.deepEqual(dogClick(dog({ id: 'worker/w', owner: 'worker', kind: 'file', target: 'build.log' }), has), { to: 'dialog' })
  assert.deepEqual(dogClick(dog({ id: 'worker/p', owner: 'worker' }), has), { to: 'dialog' }, 'an agent-owned listener too')
})

test("a dog opened from the paged list is added to the panel's dogs, so its own row shows", () => {
  const preview = [dog({ id: 'user/u1' })]
  const ninth = dog({ id: 'user/u9', name: 'ninth' })
  assert.deepEqual(withRoutedDogs(preview, [ninth]).map(w => w.id), ['user/u1', 'user/u9'])
  assert.equal(withRoutedDogs(preview, [dog({ id: 'user/u1', name: 'stale copy' })]), preview, 'a dog the preview has is not duplicated, and its copy wins')
  assert.equal(withRoutedDogs(preview, []), preview)
})
