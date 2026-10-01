import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'

test('agents drawer reclaims the rail for names while preserving hierarchy and controls in Edge', () => {
  const run = spawnSync('python', ['tests/agentdrawerwidth_probe.py',
    process.env.AGENT_DRAWER_ARTIFACT || '../../../artifacts/agentdrawerwidth-node'],
    { encoding: 'utf8', timeout: 120000 })
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}\n${run.error || ''}`)
})
