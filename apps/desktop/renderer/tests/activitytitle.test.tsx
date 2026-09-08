import { mountView, realClock, useFakeClock } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { ActiveAgentSummary, activeOrgTitle } from '../src/App'
import type { TreePayload } from '../src/types'

test('activeOrgTitle lists every currently active organization and omits inactive rows', () => {
  assert.equal(
    activeOrgTitle([
      { name: 'Alpha', working: 2 },
      { name: 'Idle', working: 0 },
      { name: 'Beta', working: 1 },
      { name: 'Unknown public row' },
    ]),
    'active agents by organization — Alpha: 2 · Beta: 1',
  )
})

test('activeOrgTitle reports no active organizations when current data has none', () => {
  assert.equal(activeOrgTitle([{ name: 'Idle', working: 0 }, { name: 'Public row' }]),
    'active agents by organization — none')
})

test('activeOrgTitle does not turn missing working counts into a false zero', () => {
  assert.equal(activeOrgTitle([{ name: 'Public row' }]),
    'active agents by organization — unavailable')
})

test('the activity chip exposes the same tooltip through keyboard focus', async (t) => {
  useFakeClock()
  const view = await mountView(
    <ActiveAgentSummary tree={{ roots: [], tiers: {} } as TreePayload}
      orgs={[{ name: 'Alpha', working: 2 }, { name: 'Idle', working: 0 }]} />,
    (el) => el,
  )
  t.after(async () => { await view.unmount(); realClock() })
  const chip = view.el.querySelector('.agents') as HTMLElement | null
  assert.ok(chip)
  assert.equal(chip?.getAttribute('role'), 'img')
  assert.equal(chip?.getAttribute('tabindex'), '0')
  assert.equal(chip?.getAttribute('title'), 'active agents by organization — Alpha: 2')
  assert.equal(chip?.getAttribute('aria-label'), chip?.getAttribute('title'))
})
