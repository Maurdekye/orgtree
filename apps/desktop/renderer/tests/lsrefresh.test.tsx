import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import rows from '../../../../tests/fixtures/langserver-context.json'
import { startWindow } from '../src/canvas/lsmodels'
import { langServerDoc, LanguageServerSection } from '../src/canvas/langserver'
import type { LangServerProbeModel } from '../src/types'

test('lsrefresh_ shared context fixtures: uncapped, fallback, validity and Ollama precedence', () => {
  for (const row of rows) assert.equal(startWindow(row as LangServerProbeModel, 1000000), row.expected, row.id)
  assert.equal(startWindow({ id: 'trained', max_context: 262144 }, 65536), 262144, 'a stale default never caps a report')
  assert.equal(langServerDoc({})?.default_context, 1000000)
})

test('lsrefresh_ last_probe seeds the card before mount finishes; mount and arrow still probe', async () => {
  const g = globalThis as unknown as { fetch: typeof fetch }
  const savedFetch = g.fetch
  let probes = 0
  let finish: (() => void) | undefined
  const models = [{ id: 'trained', max_context: 262144 }, { id: 'unknown' }]
  const server = { id: 'demo', preset: 'custom', label: 'Demo', address: 'http://synthetic.invalid',
    base_path: 'v1', base_url: 'http://synthetic.invalid/v1', harness: 'codex-cli', enabled: true,
    max_agents: 1, seat: 1, key_set: false, models: {},
    last_probe: { at: '2026-11-09T08:00:00Z', reachable: true, models, error: null } }
  const response = (data: unknown) => ({ ok: true, status: 200, headers: new Headers(), json: async () => data }) as Response
  g.fetch = (async (url: string | URL | Request) => {
    if (String(url).endsWith('/api/langservers/probe')) {
      probes++
      if (probes === 1) await new Promise<void>((resolve) => { finish = resolve })
      return response({ reachable: true, models })
    }
    return response({ servers: [server], presets: [], min_context: 65536, default_context: 1000000 })
  }) as typeof fetch
  const view = await mountView(<LanguageServerSection toast={() => {}} />, (el) => el)
  try {
    await inAct(async () => { await flush(12) })
    assert.equal(probes, 1, 'the existing mount probe still runs')
    assert.equal(view.el.textContent?.includes('trained'), true, 'cached chip before HTTP response')
    assert.equal(view.el.textContent?.includes('unknown'), true, 'cached model with no context metadata')
    await inAct(async () => { finish?.(); await flush(12) })
    const arrow = view.el.querySelector<HTMLButtonElement>('button[title^="Ask the server whether"]')
    assert.ok(arrow)
    await inAct(async () => { arrow.click(); await flush(12) })
    assert.equal(probes, 2, 'manual arrow still asks the server')
  } finally { finish?.(); await view.unmount(); g.fetch = savedFetch }
})
