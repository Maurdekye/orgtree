import './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { agentTooltipInfo } from '../src/canvas/OrgCanvas'
import type { CanvasNode } from '../src/canvas/shared'

const providers = (displayName = 'Claude Opus 5.5') => [{
  id: 'claude', label: 'Claude', cli: 'claude',
  status: { installed: true }, hire_enabled: true, reason: null,
  tiers: [{ tier: 'opus', provider: 'claude', seat: 0, model: 'claude-opus-5-5',
    letter: 'O', display_name: displayName }],
}]
const accounts = (ids: string[]) => ({
  accounts: [
    ...(ids.includes('claude/primary') ? [{ id: 'claude/primary', provider: 'claude', ambient: true }] : []),
    ...ids.filter(id => id !== 'claude/primary').map(id => ({ id, provider: 'claude', ambient: false })),
  ],
})
const node = (extra: Record<string, unknown> = {}) => ({
  id: 'worker', state: 'live', tier: 'opus', model_id: 'claude-opus-5-5',
  effort_effective: 'max', scope: {}, children: [], ...extra,
} as unknown as CanvasNode)

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

test('tooltip formats Muse, Antigravity, OpenRouter and llama.cpp model names with their provider', () => {
  const catalog = [
    { id: 'muse', tiers: [{ tier: 'wonder-full', display_name: 'Muse Wonder Full 1.0' }] },
    { id: 'google', tiers: [
      { tier: 'agy-opus', display_name: 'Opus 5.5' },
      { tier: 'argon', display_name: 'Gemini Argon 4' },
    ] },
    { id: 'openrouter', tiers: [{ tier: 'or-xiaomi-mimo-v2-6-pro', name: 'Xiaomi MiMo V2.6 Pro' }] },
    { id: 'langserver', tiers: [{ tier: 'ls-llamacpp-qwen3-8-27b-iq3xxs', name: 'Qwen3.8 27B IQ3_XXS' }] },
  ]
  const format = (tier: string, model: string) => agentTooltipInfo(node({
    tier, model_id: model, effort_effective: 'high', scope: {},
  }), catalog as never)?.title

  assert.equal(format('wonder-full', 'muse-wonder-full-1.0'), 'Muse Wonder Full 1.0 · high')
  assert.equal(format('agy-opus', 'claude-opus-5-5-high'), 'Opus 5.5 (Antigravity) · high')
  assert.equal(format('argon', 'gemini-4-argon'), 'Gemini Argon 4 · high')
  assert.equal(format('or-xiaomi-mimo-v2-6-pro', 'mimo-v2.6-pro'),
    'OpenRouter Xiaomi MiMo V2.6 Pro · high')
  assert.equal(format('ls-llamacpp-qwen3-8-27b-iq3xxs', 'qwen3.8-27b-iq3xxs'),
    'llama.cpp Qwen3.8 27B IQ3_XXS · high')
})

test('OpenRouter account labels never masquerade as effort or model name', () => {
  const providerRows = [{ id: 'openrouter', tiers: [{
    tier: 'or-xiaomi-mimo-v2-6-pro', name: 'Xiaomi MiMo V2.6 Pro',
  }] }]
  const registry = { accounts: [{ id: 'openrouter-1', provider: 'openrouter', ambient: false }] }
  assert.deepEqual(agentTooltipInfo(node({ tier: 'or-xiaomi-mimo-v2-6-pro',
    model_id: 'mimo-v2.6-pro', effort_effective: 'Daily', account: 'openrouter-1',
    account_label: 'Daily', scope: {} }), providerRows as never, registry as never, 'high'), {
    title: 'OpenRouter Xiaomi MiMo V2.6 Pro · high',
  })
})

test('tooltip shows the resolved org default when the agent has no effort setting', () => {
  assert.deepEqual(agentTooltipInfo(node({ effort_effective: undefined, scope: {} }),
    providers(), accounts(['claude/primary']) as never, 'medium'), {
    title: 'Claude Opus 5.5 · medium',
  })
})
