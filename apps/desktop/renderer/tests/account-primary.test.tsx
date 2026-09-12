import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { NodeConfig } from '../src/canvas/modals'
import type { CanvasNode } from '../src/canvas/shared'
import type { TreePayload } from '../src/types'

for (const registered of [true, false]) {
test(`operator selects primary ${registered ? 'from a secondary' : 'with an empty registry'}`, async () => {
  const posted: { path: string; body: Record<string, unknown> }[] = []
  const saved: string[] = []
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const path = new URL(String(url), 'http://localhost').pathname
    const body = init?.body ? JSON.parse(String(init.body)) : {}
    if (init?.method && init.method !== 'GET') posted.push({ path, body })
    const result = path === '/api/accounts' ? { accounts: registered ? [
      { id: 'claude-4', provider: 'claude', name: 'claude-4', label: 'old alias', standing: { state: 'ready' } },
    ] : [] } : path.endsWith('/account') ? {
      account: body.account, billing_mode: 'ambient', standing: { state: 'unobserved' },
      session_boundary: false, cache_namespace_changed: true,
    } : { servers: [], turns: [], warnings: [] }
    return { ok: true, status: 200, headers: new Headers(), json: async () => result }
  }) as typeof fetch
  const node = { id: 'agent', title: 'agent', state: 'live', tier: 'haiku', model_id: 'haiku',
    parent: 'USER', children: [], seat: 1, grant: 10, free: 10,
    account: registered ? 'claude-4' : 'missing:claude',
    scope: { permission_mode: 'acceptEdits', add_dirs: [], tools: {
      bash: true, web: true, edit: true, subagents: true, mcp: [],
    }, org_visibility: 'team' }, charter: '', team_charter: '', turns: [], audiences_held: [],
  } as CanvasNode
  const tree = { slug: 'org', dirs: [], tiers: { haiku: 1, sonnet: 2, opus: 5, fable: 10 },
    max_top_grant: 100, default_effort: '', effort_default: 'high', cascade_hire: true,
    sandboxed: false } as unknown as TreePayload
  const view = await mountView(<NodeConfig node={node} map={new Map([[node.id, node]])}
    tree={tree} slug="org" op={async () => ({})} toast={(lines) => saved.push(...lines)} close={() => {}} />,
    el => el)
  try {
    await inAct(async () => { await flush(8) })
    const select = view.el.querySelector<HTMLSelectElement>('select[aria-label="Account"]')!
    assert.ok(select)
    const primary = [...select.options].find(o => o.value === 'claude/primary')
    assert.equal(primary?.textContent, 'default · email unavailable')
    if (registered) assert.equal(select.value, 'claude-4')
    assert.ok(!select.textContent?.includes('old alias'))
    await inAct(async () => {
      if (registered) {
        assert.equal(select.disabled, false)
        select.value = primary!.value
        select.dispatchEvent(new Event('change', { bubbles: true }))
      } else {
        assert.equal(select.disabled, true)
        const repair = [...view.el.querySelectorAll<HTMLButtonElement>('button')]
          .find(b => b.textContent === 'Use default · email unavailable')!
        assert.ok(repair, 'missing binding has an explicit recovery action')
        repair.click()
      }
    })
    const save = [...view.el.querySelectorAll<HTMLButtonElement>('button')]
      .find(b => b.textContent?.trim() === 'save')!
    await inAct(async () => { save.click(); await flush(8) })
    const assignments = posted.filter(p => p.path.endsWith('/account'))
    assert.deepEqual(assignments, [{ path: '/api/orgs/org/nodes/agent/account',
      body: { account: 'claude/primary' } }])
    assert.ok(saved.some(line => line.includes('claude/primary')))
  } finally { await view.unmount() }
})
}
