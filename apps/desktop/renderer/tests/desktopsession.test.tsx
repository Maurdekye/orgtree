import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { NodeConfig } from '../src/canvas/modals'
import type { CanvasNode } from '../src/canvas/shared'
import type { TreePayload } from '../src/types'

// Docket let-agents-query-machine-sign-in-state-and-which (the user,
// 2026-10-16 12:08Z, 12:12Z and 12:13Z): an agent's preference over the
// user's own Windows sessions, shown and editable in Agent settings; the
// default is any signed-in session, Session 0 the fallback.

async function mount(session?: unknown) {
  const posted: { path: string; body: Record<string, unknown> }[] = []
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const path = new URL(String(url), 'http://localhost').pathname
    const body = init?.body ? JSON.parse(String(init.body)) : {}
    if (init?.method && init.method !== 'GET') posted.push({ path, body })
    const result = path === '/api/accounts' ? { accounts: [] } : { servers: [], turns: [], warnings: [] }
    return { ok: true, status: 200, headers: new Headers(), json: async () => result }
  }) as typeof fetch
  const node = { id: 'agent', title: 'agent', state: 'live', tier: 'haiku', model_id: 'haiku',
    parent: 'USER', children: [], seat: 1, grant: 10, free: 10,
    scope: { permission_mode: 'acceptEdits', add_dirs: [], tools: {
      bash: true, web: true, edit: true, subagents: true, mcp: [],
    }, org_visibility: 'team', ...(session === undefined ? {} : { session }) },
    charter: '', team_charter: '', turns: [], audiences_held: [],
  } as unknown as CanvasNode
  const tree = { slug: 'org', dirs: [], tiers: { haiku: 1, sonnet: 2, opus: 5, fable: 10 },
    max_top_grant: 100, default_effort: '', effort_default: 'high', cascade_hire: true } as unknown as TreePayload
  const view = await mountView(<NodeConfig node={node} map={new Map([[node.id, node]])}
    tree={tree} slug="org" op={async () => ({})} toast={() => {}} close={() => {}} />, el => el)
  await inAct(async () => { await flush(8) })
  return { view, posted }
}

const save = async (el: HTMLElement) => {
  const button = [...el.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent?.trim() === 'save')!
  await inAct(async () => { button.click(); await flush(8) })
}

test('Agent settings show the desktop session preference, signed-in by default, and save a change', async () => {
  const { view, posted } = await mount()
  try {
    const select = view.el.querySelector<HTMLSelectElement>('select[aria-label="Desktop session"]')
    assert.ok(select, 'no "Desktop session" setting')
    assert.equal(select!.value, 'signed-in')
    assert.deepEqual([...select!.options].map(o => o.value), ['signed-in', 'console', 'remote', 'session0'])
    await inAct(async () => {
      select!.value = 'session0'
      select!.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await save(view.el)
    const scope = posted.find(p => p.path.endsWith('/scope'))
    assert.equal(scope?.body.session, 'session0', JSON.stringify(posted))
  } finally { await view.unmount() }
})

test('an ordered list set through orgtree_session is shown as it is and not sent back unedited', async () => {
  const { view, posted } = await mount(['remote', 'console'])
  try {
    const select = view.el.querySelector<HTMLSelectElement>('select[aria-label="Desktop session"]')
    assert.ok(select, 'no "Desktop session" setting')
    assert.equal(select!.selectedOptions[0]?.textContent, 'Remote, then console session')
    await save(view.el)
    const scope = posted.find(p => p.path.endsWith('/scope'))
    assert.equal(scope !== undefined && 'session' in scope.body, false, JSON.stringify(scope))
  } finally { await view.unmount() }
})
