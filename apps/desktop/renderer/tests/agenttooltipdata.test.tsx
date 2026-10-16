import './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { agentTooltipInfo } from '../src/canvas/OrgCanvas'

test('agent tooltip projection follows live, archived, draft, and missing identity data', () => {
  const live = agentTooltipInfo({
    id: 'worker', state: 'live', tier: 'haiku', account: 'claude/primary',
    account_label: 'Primary Claude', effort_effective: 'high',
  } as never)
  assert.deepEqual(live, {
    name: 'worker', provider: 'Claude', model: 'haiku', effort: 'high', account: 'Primary Claude',
  })

  const archived = agentTooltipInfo({
    id: 'retired', state: 'archived', tier: 'haiku', account: 'claude/primary',
  } as never)
  assert.deepEqual(archived, {
    name: 'retired', provider: 'Claude', model: 'haiku (retired)', effort: 'Unknown',
    account: 'claude/primary',
  })

  const draft = agentTooltipInfo({
    id: 'draft-worker', state: 'draft', tier: 'haiku', account_label: 'Default account',
    scope: { effort: 'medium' },
  } as never)
  assert.deepEqual(draft, {
    name: 'draft-worker', provider: 'Claude', model: 'haiku', effort: '(not started)',
    account: 'Default account',
  })

  const uninitialized = agentTooltipInfo({
    id: 'uninitialized', state: 'live', tier: null, account: null,
  } as never)
  assert.deepEqual(uninitialized, {
    name: 'uninitialized', provider: 'Unknown', model: 'Unknown', effort: 'Unknown', account: 'Unknown',
  })
})
