import test from 'node:test'
import assert from 'node:assert/strict'
import { flush, inAct, mountView } from './harness'
import { LanguageServerSection } from '../src/canvas/langserver'
import { PROVIDER_LABEL } from '../src/canvas/shared'
import { HarnessesSection } from '../src/canvas/harnesses'
import { OrgAccountsTab } from '../src/orgaccounts'

const doc = { servers: [], presets: [{ id: 'ollama', label: 'Ollama', address: 'http://127.0.0.1:11434',
  harnesses: [{ id: 'claude-code', label: 'Claude Code', available: true }], note: '' }],
  default_seat: 1, max_seat: 100, min_context: 65536, default_context: 65536, user_enabled: true }

test('local model settings and add dialog use the unambiguous name through the existing API', async () => {
  const paths: string[] = []
  globalThis.fetch = async (url) => {
    paths.push(String(url))
    return new Response(JSON.stringify(doc), { headers: { 'Content-Type': 'application/json' } })
  }
  const view = await mountView(<LanguageServerSection provider={undefined} toast={() => {}} />, e => e)
  try {
    await inAct(async () => { await flush(8) })
    assert.ok(view.el.querySelector('.acct-provider-head')?.textContent?.includes('Language model servers'), 'settings heading')
    const add = view.el.querySelector<HTMLButtonElement>('.ls-section .acct-secondary-btn')!
    await inAct(async () => { add.click(); await flush(4) })
    assert.ok(document.querySelector('[role="dialog"][aria-label="Add language model server"]'), 'add dialog name')
    assert.ok(paths.some(p => p.endsWith('/api/langservers')), 'compatible route is preserved')
  } finally { await view.unmount() }
})

test('hire-family label names model servers without changing its provider id', () => {
  assert.equal(PROVIDER_LABEL.langserver, 'Language model servers')
})

test('harness compatibility names language model servers', async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({ harnesses: [{ id: 'claude-code', name: 'Claude Code',
    installed: true, selectable: true, version: 'synthetic', providers: [{ id: 'langserver' }] }] }),
  { headers: { 'Content-Type': 'application/json' } })
  const view = await mountView(<HarnessesSection active />, e => e)
  try {
    await inAct(async () => { await flush(8) })
    assert.equal(view.el.querySelector('.harness-tag')?.textContent, 'Language model server')
  } finally { await view.unmount() }
})

test('account feedback uses the LM server label while writes keep the saved lane id', async () => {
  const writes: unknown[] = [], toasts: string[][] = []
  globalThis.fetch = async (_url, init) => {
    if (init?.method === 'POST') writes.push(JSON.parse(String(init.body)))
    return new Response(JSON.stringify(init?.method === 'POST' ? { warnings: [] } : { accounts: [{
      id: 'langserver:llamacpp', provider: 'langserver', label: 'LM server: llama.cpp', enabled: true, allowed: true,
    }] }), { headers: { 'Content-Type': 'application/json' } })
  }
  const view = await mountView(<OrgAccountsTab slug="synthetic" toast={t => toasts.push(t)} />, e => e)
  try {
    await inAct(async () => { await flush(8) })
    assert.equal(view.el.querySelector('.field-label')?.textContent, 'Language model servers')
    await inAct(async () => { view.el.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click(); await flush(8) })
    assert.deepEqual(writes, [{ disabled_accounts: ['langserver:llamacpp'] }])
    assert.equal(toasts[0]?.[0], 'LM server: llama.cpp is no longer used by this org')
  } finally { await view.unmount() }
})
