import './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { agentTooltipInfo } from '../src/canvas/OrgCanvas'

const providers = (displayName = 'Claude Opus 5.5') => [{
  id: 'claude', tiers: [{ tier: 'opus', display_name: displayName }],
}]
const accounts = (ids: string[]) => ({
  accounts: [
    ...(ids.includes('claude/primary') ? [{ id: 'claude/primary', provider: 'claude', ambient: true }] : []),
    ...ids.filter(id => id !== 'claude/primary').map(id => ({ id, provider: 'claude', ambient: false })),
  ],
})
const node = (extra: Record<string, unknown> = {}) => ({
  id: 'worker', state: 'live', tier: 'opus', model_id: 'claude-opus-5-5',
  effort_effective: 'max', scope: {}, ...extra,
})

test('tooltip uses catalog display name/version and omits account for a single configured account', () => {
  assert.deepEqual(agentTooltipInfo(node(), providers(), accounts(['claude/primary']) as never), {
    title: 'Claude Opus 5.5 · max',
  })
})

test('tooltip shows a bound account name when its provider has multiple accounts', () => {
  assert.deepEqual(agentTooltipInfo(node({ account: 'claude-1', account_label: 'claude-1' }),
    providers(), accounts(['claude/primary', 'claude-1']) as never), {
    title: 'Claude Opus 5.5 · max · claude-1',
  })
})

test('tooltip labels the effective default account when unbound and provider has multiple accounts', () => {
  assert.deepEqual(agentTooltipInfo(node(), providers(),
    accounts(['claude/primary', 'claude-1']) as never), {
    title: 'Claude Opus 5.5 · max · default',
  })
})

test('tooltip falls back to the tree model id when the provider catalog has no matching tier', () => {
  assert.deepEqual(agentTooltipInfo(node({ tier: 'new-tier', model_id: 'vendor-model-6.1' }),
    providers(), accounts(['claude/primary']) as never), {
    title: 'vendor-model-6.1 · max',
  })
})

test('tooltip omits a missing model value while keeping known effort', () => {
  assert.deepEqual(agentTooltipInfo(node({ tier: null, model_id: null }),
    providers(), accounts(['claude/primary']) as never), {
    title: 'max',
  })
})

test('pinned model version is resolved from provider catalog display data', () => {
  const catalog = [{ id: 'openai', tiers: [{ tier: 'sol', display_name: 'ChatGPT Sol 6.1', display_versions: { '6': 'ChatGPT Sol 6', '6.1': 'ChatGPT Sol 6.1' } }] }]
  assert.deepEqual(agentTooltipInfo(node({ tier: 'sol', model_id: 'gpt-6-sol', scope: { model_version: '6' }, effort_effective: 'high' }),
    catalog as never, accounts(['openai/primary']) as never), {
    title: 'ChatGPT Sol 6 · high',
  })
})

test('an unrecognized pinned version falls back to the tree model id, not the catalog default', () => {
  const catalog = [{ id: 'openai', tiers: [{ tier: 'sol', display_name: 'ChatGPT Sol 6.1', display_versions: { '6': 'ChatGPT Sol 6', '6.1': 'ChatGPT Sol 6.1' } }] }]
  assert.deepEqual(agentTooltipInfo(node({ tier: 'sol', model_id: 'gpt-5.6-sol', scope: { model_version: '5.6' } }),
    catalog as never, accounts(['openai/primary']) as never), {
    title: 'gpt-5.6-sol · max',
  })
})
