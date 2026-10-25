import { FakeServer, flush, inAct, installFetch, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { NodeConfig } from '../src/canvas/modals'
import { USER } from '../src/canvas/shared'
import type { CanvasNode } from '../src/canvas/shared'
import type { TreePayload } from '../src/types'

test('agent settings never offer to remove retained reply quotes, even when some are retained', async () => {
  const original = globalThis.fetch
  installFetch(new FakeServer())
  const fallback = globalThis.fetch
  const quoteCalls: string[] = []
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith('/reply-events')) {
      quoteCalls.push(`${init?.method ?? 'GET'} ${String(url)}`)
      return { ok: true, headers: new Headers(), json: async () => ({ count: 3 }) } as Response
    }
    return fallback(url, init)
  }
  const node: CanvasNode = { id: 'agent', title: 'agent', state: 'live', tier: 'haiku', parent: USER,
    children: [], seat: 1, grant: 10, free: 10, generation: 2, turns: [], charter: '', team_charter: '',
    scope: { permission_mode: 'acceptEdits', add_dirs: [], tools: { mcp: [] }, org_visibility: 'team' } }
  const tree = { slug: 'org', dirs: [], tiers: { haiku: 1 }, max_top_grant: 100 } as unknown as TreePayload
  const v = await mountView(<NodeConfig node={node} map={new Map([[node.id, node]])} tree={tree} slug="org"
    op={async () => ({})} toast={() => {}} close={() => {}} />, el => el)
  try {
    await flush(10)
    const labels = [...v.el.querySelectorAll<HTMLButtonElement>('button')].map(b => b.textContent ?? '')
    assert.ok(labels.some(l => /Delete permanently/.test(l)), 'control: the settings panel did render its buttons')
    assert.ok(!labels.some(l => /retained reply quotes/i.test(l)), 'no retained-reply-quotes button')
    assert.equal(quoteCalls.length, 0, 'the panel no longer asks the server how many quotes are retained')
  } finally { await v.unmount(); globalThis.fetch = original }
})
