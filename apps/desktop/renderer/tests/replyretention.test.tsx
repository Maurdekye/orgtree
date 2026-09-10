import { FakeServer, flush, inAct, installFetch, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { NodeConfig } from '../src/canvas/modals'
import { USER } from '../src/canvas/shared'
import type { CanvasNode } from '../src/canvas/shared'
import type { TreePayload } from '../src/types'

test('retained quote removal requires confirmation, targets the shown agent, and reports errors', async () => {
  const original = globalThis.fetch
  installFetch(new FakeServer())
  const fallback = globalThis.fetch
  const calls: { url: string; method: string | undefined }[] = []
  let fail = true
  let count = 3
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith('/reply-events')) {
      if (!init?.method || init.method === 'GET') return { ok: true, headers: new Headers(), json: async () => ({ count }) } as Response
      calls.push({ url: String(url), method: init?.method })
      if (fail) throw new Error('refused')
      count = 0
      return { ok: true, headers: new Headers(), json: async () => ({ removed: 3 }) } as Response
    }
    return fallback(url, init)
  }
  const messages: string[] = []
  const node: CanvasNode = { id: 'agent', title: 'agent', state: 'live', tier: 'haiku', parent: USER,
    children: [], seat: 1, grant: 10, free: 10, generation: 2, turns: [], charter: '', team_charter: '',
    scope: { permission_mode: 'acceptEdits', add_dirs: [], tools: { mcp: [] }, org_visibility: 'team' } }
  const tree = { slug: 'org', dirs: [], tiers: { haiku: 1 }, max_top_grant: 100 } as unknown as TreePayload
  const v = await mountView(<NodeConfig node={node} map={new Map([[node.id, node]])} tree={tree} slug="org"
    op={async () => ({})} toast={lines => { messages.push(...lines) }} close={() => {}} />, el => el)
  const launch = () => [...v.el.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === 'Remove retained reply quotes')!
  try {
    assert.ok(launch(), 'real node settings action exists')
    assert.doesNotMatch(v.el.textContent!, /remote control|claude.ai \/ mobile/i)
    await inAct(() => { launch().click() })
    assert.equal(calls.length, 0, 'opening confirmation never deletes')
    assert.match(document.body.textContent!, /for agent\?/)
    assert.match(document.body.textContent!, /Transcripts and sent mail are kept/)
    const dialog = document.querySelector<HTMLElement>('.confirm-box')!
    assert.ok(dialog, 'confirmation dialog is mounted')
    const cancel = [...dialog.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === 'cancel')!
    await inAct(() => { cancel.click() })
    assert.equal(calls.length, 0, 'cancel never deletes')
    assert.equal(document.querySelector('.confirm-box'), null, 'cancel closes the actual dialog')
    await inAct(() => { launch().click() })
    const confirm = [...document.querySelectorAll<HTMLButtonElement>('button')].filter(b => b.textContent === 'Remove retained reply quotes').at(-1)!
    await inAct(async () => { confirm.click(); await flush(10) })
    assert.match(messages.at(-1)!, /refused/)
    assert.equal(launch().disabled, false, 'failure preserves the action for retry')
    fail = false
    await inAct(() => { launch().click() })
    await inAct(async () => { [...document.querySelectorAll<HTMLButtonElement>('button')].filter(b => b.textContent === 'Remove retained reply quotes').at(-1)!.click(); await flush(10) })
    assert.equal(calls.length, 2)
    assert.ok(calls.every(c => c.method === 'DELETE' && c.url === '/api/orgs/org/nodes/agent/reply-events'))
    assert.match(messages.at(-1)!, /Removed 3 retained reply quotes for agent/)
    assert.equal(launch(), undefined, 'empty retained quotes hides the removal button immediately')
  } finally { await v.unmount(); globalThis.fetch = original }
})
