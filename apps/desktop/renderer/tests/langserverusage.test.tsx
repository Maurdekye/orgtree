// langserverusage.test.tsx — the Usage modal shows the windows a language-model
// server reports from its /usage route (docket
// `opencode-go-show-usage-limits-5h-weekly-monthly-i`; USER 2026-11-09
// m6b2875a1cd9a, m479c1c4f5fcc). A server with no usage feature keeps its
// "local · no usage limit" line; a server that worked and then failed reads
// unavailable, never 0%.
import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { legacyAppBackend } from './appfeed-fixture'
import { UsageModal } from '../src/App'

const g = globalThis as unknown as Record<string, unknown>

const srv = (id: string, label: string) => ({
  id, preset: 'custom', label, address: 'http://127.0.0.1:9931', harness: 'opencode', api: 'chat_completions',
  base_path: '', base_url: 'http://127.0.0.1:9931', max_agents: 2, seat: 1, enabled: true, key_set: false,
  created_at: '2026-11-09T08:00:00Z', models: {},
})

const DOC = { servers: [srv('go', 'OpenCode Go'), srv('plain', 'Plain server'), srv('broken', 'Broken server')],
  presets: [], default_seat: 1, max_seat: 100, min_context: 65536, default_context: 65536, user_enabled: true }

const READINGS = {
  go: { available: true, provider: 'LM server', label: 'OpenCode Go', limits: [
    { kind: 'session', group: 'session', percent: 12, severity: 'normal', resets_at: '2099-01-01T00:00:00.000Z', is_active: false, model: null, label: '5 h' },
    { kind: 'weekly_all', group: 'weekly_all', percent: 40, severity: 'normal', resets_at: '2099-01-01T00:00:00.000Z', is_active: false, model: null, label: 'weekly' },
    { kind: 'monthly', group: 'monthly', percent: 71, severity: 'normal', resets_at: '2099-01-01T00:00:00.000Z', is_active: false, model: null, label: 'monthly' },
  ] },
  broken: { available: false, provider: 'LM server', label: 'Broken server', error: 'usage check failed (HTTP 500)' },
}

function stub() {
  g.fetch = legacyAppBackend(((url: string) => {
    const path = new URL(String(url), 'http://localhost').pathname
    const body = path === '/api/langservers' ? DOC : path === '/api/langservers/usage' ? READINGS : null
    if (!body) return Promise.reject(new Error(`unexpected fetch: ${path}`))
    return Promise.resolve({ ok: true, status: 200, headers: new Headers(), json: () => Promise.resolve(body) })
  }) as typeof fetch)
  return () => { delete g.fetch }
}

const card = (el: HTMLElement, lane: string) => el.querySelector(`[data-account="langserver:${lane}"], .usage-acct[data-lane="langserver:${lane}"]`)
  ?? [...el.querySelectorAll('.usage-acct')].find((c) => c.textContent?.includes(lane === 'go' ? 'OpenCode Go' : lane === 'plain' ? 'Plain server' : 'Broken server'))

test('a server that reports usage shows its windows; one that does not keeps the local line; a failed one reads unavailable', async () => {
  const restore = stub()
  try {
    const view = await mountView(<UsageModal close={() => {}} />, (el) => el)
    await inAct(async () => { await flush(8) })
    const go = card(view.el, 'go')!.textContent ?? ''
    for (const w of ['5 h', 'weekly', 'monthly', '12%', '40%', '71%']) assert.ok(go.includes(w), `${w} in: ${go}`)
    assert.ok(!go.includes('no usage limit'), go)
    const plain = card(view.el, 'plain')!.textContent ?? ''
    assert.match(plain, /local · no usage limit/)
    assert.doesNotMatch(plain, /%/)
    const broken = card(view.el, 'broken')!.textContent ?? ''
    assert.match(broken, /HTTP 500/)
    assert.doesNotMatch(broken, /0%/, 'never 0%')
  } finally { restore() }
})
