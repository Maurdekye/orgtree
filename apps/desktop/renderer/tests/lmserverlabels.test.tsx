import test from 'node:test'
import assert from 'node:assert/strict'
import { flush, inAct, mountView } from './harness'
import { LanguageServerSection } from '../src/canvas/langserver'
import { PROVIDER_LABEL } from '../src/canvas/shared'
import { HarnessesSection } from '../src/canvas/harnesses'

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
