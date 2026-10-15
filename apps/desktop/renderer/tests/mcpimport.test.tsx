import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { SettingsPanel } from '../src/App'
import type { TreePayload } from '../src/types'

const g = globalThis as unknown as Record<string, unknown>
async function setup(fail: boolean | string = false) {
  const requests: { path: string; method: string }[] = []
  g.fetch = async (url: string, init?: RequestInit) => {
    const path = new URL(String(url), 'http://localhost').pathname
    requests.push({ path, method: init?.method ?? 'GET' })
    if (path.endsWith('/refresh') && (fail === true || fail === path)) throw new Error('fixture refresh failure')
    const fresh = path === '/api/mcp-servers/refresh'
    const payload = path.startsWith('/api/mcp-servers')
      ? { servers: fresh ? ['added'] : ['old'], details: [{ name: fresh ? 'added' : 'old', sources: fresh ? ['opencode'] : ['codex-cli', 'muse'], transport: fresh ? 'http' : 'stdio' }] }
      : path === '/api/skills/refresh' ? { skills: [{ name: 'fixture', sources: ['orgtree'] }], digest: 'fixture' }
      : path === '/api/global-instructions/refresh' ? { files: 2, refreshed: true }
      : path === '/api/accounts' ? { accounts: [] } : path.endsWith('/accounts') ? { accounts: [] } : {}
    return { ok: true, status: 200, headers: new Headers(), json: async () => payload }
  }
  const tree = { slug: 'acme', name: 'Acme', nodes: [], edges: [], max_top_grant: 1000, default_top_grant: 50,
    compact_at: 0.8, default_effort: '', net: { hubs: [] }, default_tools: { mcp: [] } } as unknown as TreePayload
  const view = await mountView(<SettingsPanel tree={tree} toast={() => {}} close={() => {}} />, el => el)
  await inAct(async () => {
    const tab = [...view.el.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(b => b.textContent?.includes('Hire defaults'))
    assert.ok(tab); tab.click(); await flush(15)
  })
  return { view, requests }
}

test('MCP list labels source and transport', async () => {
  const { view } = await setup()
  try { assert.match(view.el.textContent ?? '', /Codex, Muse.*stdio/) }
  finally { await view.unmount(); delete g.fetch }
})

test('MCP Refresh replaces discovered names without writing grants or restarting agents', async () => {
  const { view, requests } = await setup()
  try {
    const refresh = view.el.querySelector<HTMLButtonElement>('[aria-label="Refresh MCP servers, skills and instructions"]')
    assert.ok(refresh)
    requests.length = 0
    await inAct(async () => { refresh.click(); await flush(15) })
    assert.match(view.el.textContent ?? '', /added.*OpenCode.*http/)
    assert.equal((view.el.textContent ?? '').includes('Codex, Muse'), false)
    assert.deepEqual(requests.filter(r => r.method === 'POST'), ['/api/mcp-servers/refresh', '/api/skills/refresh', '/api/global-instructions/refresh'].map(path => ({ path, method: 'POST' })))
    assert.match(view.el.textContent ?? '', /Running agents keep their current setup until their next turn/)
    assert.match(view.el.textContent ?? '', /1 shared skills found/)
  } finally { await view.unmount(); delete g.fetch }
})

test('failed MCP Refresh retains current list and reports failure', async () => {
  const { view } = await setup(true)
  try {
    const refresh = view.el.querySelector<HTMLButtonElement>('[aria-label="Refresh MCP servers, skills and instructions"]')
    assert.ok(refresh)
    await inAct(async () => { refresh.click(); await flush(15) })
    assert.match(view.el.textContent ?? '', /Codex, Muse.*stdio/)
    assert.match(view.el.querySelector('[role="alert"]')?.textContent ?? '', /Could not refresh/)
    assert.equal(refresh.disabled, false)
  } finally { await view.unmount(); delete g.fetch }
})

test('shared Refresh reports partial failure while retaining successful imports', async () => {
  const { view, requests } = await setup('/api/global-instructions/refresh')
  try {
    const refresh = view.el.querySelector<HTMLButtonElement>('[aria-label="Refresh MCP servers, skills and instructions"]')
    assert.ok(refresh)
    requests.length = 0
    await inAct(async () => { refresh.click(); await flush(15) })
    assert.equal(requests.filter(r => r.method === 'POST').length, 3)
    assert.match(view.el.textContent ?? '', /added.*OpenCode.*http/)
    assert.match(view.el.textContent ?? '', /1 shared skills found/)
    assert.match(view.el.querySelector('[role="alert"]')?.textContent ?? '', /Could not refresh instructions/)
    assert.equal(refresh.disabled, false)
  } finally { await view.unmount(); delete g.fetch }
})
