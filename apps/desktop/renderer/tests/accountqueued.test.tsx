import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { NodeConfig } from '../src/canvas/modals'
import type { CanvasNode } from '../src/canvas/shared'
import type { TreePayload } from '../src/types'

test('a mid-turn account change is queued: the save shows no error and still saves the scope', async () => {
  const posted: { path: string; body: Record<string, unknown> }[] = []
  const saved: string[] = []
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const path = new URL(String(url), 'http://localhost').pathname
    const body = init?.body ? JSON.parse(String(init.body)) : {}
    if (init?.method && init.method !== 'GET') posted.push({ path, body })
    const result = path === '/api/accounts' ? { accounts: [
      { id: 'claude-4', provider: 'claude', name: 'claude-4', label: 'old alias', standing: { state: 'ready' } },
    ] } : path.endsWith('/account') ? {
      account: 'claude/primary', label: 'claude/primary', previous_account: 'claude-4',
      queued: true, pending_account: body.account, replaced: null,
      cache_namespace_changed: true, session_boundary: false,
    } : { servers: [], turns: [], warnings: [] }
    return { ok: true, status: 200, headers: new Headers(), json: async () => result }
  }) as typeof fetch
  const node = { id: 'agent', title: 'agent', state: 'live', tier: 'haiku', model_id: 'haiku',
    parent: 'USER', children: [], seat: 1, grant: 10, free: 10,
    account: 'claude-4',
    scope: { permission_mode: 'acceptEdits', add_dirs: [], tools: {
      bash: true, web: true, edit: true, subagents: true, mcp: [],
    }, org_visibility: 'team' }, charter: '', team_charter: '', turns: [], audiences_held: [],
  } as CanvasNode
  const tree = { slug: 'org', dirs: [], tiers: { haiku: 1, sonnet: 2, opus: 5, fable: 10 },
    max_top_grant: 100, default_effort: '', effort_default: 'high', cascade_hire: true } as unknown as TreePayload
  const view = await mountView(<NodeConfig node={node} map={new Map([[node.id, node]])}
    tree={tree} slug="org" op={async () => ({})} toast={(lines) => saved.push(...lines)} close={() => {}} />,
    el => el)
  try {
    await inAct(async () => { await flush(8) })
    const select = view.el.querySelector<HTMLSelectElement>('select[aria-label="Account"]')!
    assert.ok(select)
    const primary = [...select.options].find(o => o.value === 'claude/primary')
    assert.equal(primary?.textContent, 'default · email unavailable')
    await inAct(async () => {
      select.value = primary!.value
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    const save = [...view.el.querySelectorAll<HTMLButtonElement>('button')]
      .find(b => b.textContent?.trim() === 'save')!
    await inAct(async () => { save.click(); await flush(8) })
    const assignments = posted.filter(p => p.path.endsWith('/account'))
    assert.deepEqual(assignments, [{ path: '/api/orgs/org/nodes/agent/account',
      body: { account: 'claude/primary' } }])
    assert.ok(saved.some(line => /queued/.test(line)), 'says the change is queued: ' + saved.join(' | '))
    assert.ok(!saved.some(line => /error|undefined/i.test(line)), 'no error toast: ' + saved.join(' | '))
    assert.ok(posted.some(p => p.path.endsWith('/scope')), 'the rest of the save still ran')
  } finally { await view.unmount() }
})
