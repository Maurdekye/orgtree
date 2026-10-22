import { test } from 'node:test'
import assert from 'node:assert/strict'
import { replayUsageBoards, hasAccountData, excludesSwitchedAccount } from '../tools/rig/org-accounts-board.mjs'

const full = `[PROVIDER USAGE #1 — synthetic]
[ACCOUNTS] claude/primary · claude-1
account | window | used | amount | reset (countdown) | observed (age,freshness) | state
claude/primary | Current session | 10% | - | later | now | ok
claude-1* | Current session | 5% | - | later | now | ok
claude-1* | Current week (all models) | 20% | - | later | now | ok
Your turns run on claude-1 (tier haiku) and draw on its windows above.
[END PROVIDER USAGE]`
const delta = `[PROVIDER USAGE #2 DELTA — since #1; last full #1; turn account claude/primary, tier haiku]
[ACCOUNTS] claude/primary
Your turns run on claude/primary (tier haiku) and draw on its windows above.
Removed: claude-1|"session"|"session"|null|Current session
Removed: claude-1|"weekly_all"|"weekly_all"|null|Current week (all models)
[END PROVIDER USAGE]`

test('snapshot plus delta retains unchanged primary data and removes exactly the old account windows', () => {
  const board = replayUsageBoards([full, delta])
  assert.equal(board.valid, true, board.errors.join('; '))
  assert.deepEqual(board.accounts, ['claude/primary'])
  assert.equal(board.current, 'claude/primary')
  assert.equal(board.provider, 'claude')
  assert.equal(hasAccountData(board, 'claude/primary'), true)
  assert.equal(hasAccountData(board, 'claude-1'), false)
  assert.equal(board.removed.length, 2)
})
test('delta without its full snapshot is refused', () => assert.equal(replayUsageBoards([delta]).valid, false))
test('delta must reference the actual baseline', () => assert.equal(replayUsageBoards([full, delta.replace('last full #1', 'last full #9')]).valid, false))
test('absence of the active account window data is refused', () => assert.equal(replayUsageBoards([full.replace(/^claude\/primary \|.*\n/m, ''), delta]).valid, false))
test('a missing removal cannot silently leave an old account active', () => assert.equal(replayUsageBoards([full, delta.replace(/^Removed:.*Current session\n/m, '')]).valid, false))
test('a foreign removed-account identity is refused', () => assert.equal(replayUsageBoards([full, delta.replaceAll('Removed: claude-1|', 'Removed: openai-1|')]).valid, false))
test('unchanged references preserve the effective account and provider', () => {
  const board = replayUsageBoards([full, '[PROVIDER USAGE — unchanged since #1; last full #1; turn account claude-1, tier haiku]'])
  assert.equal(board.valid, true)
  assert.equal(board.current, 'claude-1')
  assert.equal(board.provider, 'claude')
  assert.equal(hasAccountData(board, 'claude-1'), true)
})
const expectedRemoved = ['claude-1|"session"|"session"|null|Current session', 'claude-1|"weekly_all"|"weekly_all"|null|Current week (all models)']
const initial = replayUsageBoards([full])
const excludes = (board, allowed = ['claude/primary', 'google/primary']) => excludesSwitchedAccount(initial, board, board.accounts, 'claude-1', allowed, expectedRemoved)
test('a newly cached allowed provider may arrive while B is removed', () => {
  const changed = delta.replace('[ACCOUNTS] claude/primary', '[ACCOUNTS] claude/primary · google/primary')
    .replace('Removed:', 'google/primary | usage | - | - | - | now | unavailable (synthetic)\nRemoved:')
  const board = replayUsageBoards([full, changed])
  assert.equal(excludes(board), true)
  assert.equal(excludes(board, ['claude/primary']), false)
  assert.equal(excludes({ ...board, rows: board.rows.filter(row => row.account !== 'claude/primary'), valid: false }), false)
})
test('current account/provider and exact removal identities remain required', () => {
  const board = replayUsageBoards([full, delta])
  assert.equal(excludes(board), true)
  for (const changed of [{ current: 'claude-1' }, { provider: 'openai' }, { removed: [expectedRemoved[0]] },
    { removed: expectedRemoved.map(label => label.replace('claude-1|', 'openai-1|')) }]) {
    assert.equal(excludes({ ...board, ...changed }), false)
  }
})
