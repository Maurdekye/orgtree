import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { HarnessesSection } from '../src/canvas/harnesses'
import type { HarnessInfo } from '../src/types'

const g = globalThis as unknown as Record<string, unknown>
const both = [{ id: 'openrouter', label: 'OpenRouter' }, { id: 'langserver', label: 'Language servers' }]
const row = (id: string, extra: Partial<HarnessInfo> = {}): HarnessInfo => ({
  id, name: id, installed: true, version: '1.2.3', selectable: true, providers: both,
  what: 'Technical caveat not for this tab.', install: 'Long install instructions.',
  install_url: `https://example.test/${id}`, ...extra,
})
const rows = [row('claude-code', { name: 'Claude Code' }), row('codex-cli', { name: 'Codex', version: null }),
  row('opencode', { name: 'OpenCode (ACP)', installed: false }),
  row('antigravity', { name: 'Antigravity', selectable: false, providers: [{ id: 'google', label: 'Google' }] }),
  row('muse', { name: 'Muse Code', installed: false, selectable: false, providers: [] }),
  row('future', { name: 'Future harness', version: undefined, providers: [{ id: 'langserver', label: 'Unrelated display copy' }] })]

async function mount(harnesses: HarnessInfo[] = rows) {
  g.fetch = async () => ({ ok: true, status: 200, headers: new Headers(), json: async () => ({ harnesses }) })
  const view = await mountView(<HarnessesSection active />, (el) => el)
  await inAct(async () => { await flush(10) })
  return view
}
test('compact registry rows show only name, state, cached version and compatibility tags', async () => {
  const view = await mount()
  try {
    assert.equal(view.el.querySelectorAll('[role="listitem"]').length, rows.length)
    const text = view.el.textContent ?? ''
    assert.doesNotMatch(text, /Technical caveat|Long install|Runs agents on|A harness is the command-line/)
    for (const h of rows) {
      const el = view.el.querySelector(`[data-harness="${h.id}"]`)!
      assert.ok(el, h.id)
      assert.ok(el.textContent?.includes(h.name))
      assert.match(el.textContent ?? '', h.installed ? / · installed/ : / · not installed/)
      assert.equal(el.querySelector('.harness-version')?.textContent ?? null,
        h.installed ? h.version || 'version unknown' : null)
    }
  } finally { await view.unmount(); delete g.fetch }
})
test('only missing harnesses have a single How to install link', async () => {
  const view = await mount()
  try {
    assert.equal(view.el.querySelectorAll('a').length, 2)
    for (const h of rows) {
      const links = view.el.querySelectorAll(`[data-harness="${h.id}"] a`)
      assert.equal(links.length, h.installed ? 0 : 1)
      if (!h.installed) {
        assert.equal(links[0]!.textContent, 'How to install')
        assert.equal(links[0]!.getAttribute('href'), h.install_url)
      }
    }
  } finally { await view.unmount(); delete g.fetch }
})
test('compatibility tags follow selectable registry provider IDs, including future harnesses', async () => {
  const view = await mount()
  try {
    for (const h of rows) {
      const tags = [...view.el.querySelectorAll(`[data-harness="${h.id}"] .harness-tag`)].map((e) => e.textContent)
      assert.deepEqual(tags, ['claude-code', 'codex-cli', 'opencode'].includes(h.id)
        ? ['OpenRouter', 'Language server'] : h.id === 'future' ? ['Language server'] : [])
    }
  } finally { await view.unmount(); delete g.fetch }
})
test('blank or absent versions stay unknown and absent install URLs add no dead link', async () => {
  const view = await mount([row('blank', { version: '  ' }), row('absent', { installed: false, install_url: null })])
  try {
    assert.equal(view.el.querySelector('.harness-version')?.textContent, 'version unknown')
    assert.equal(view.el.querySelectorAll('a').length, 0)
  } finally { await view.unmount(); delete g.fetch }
})
