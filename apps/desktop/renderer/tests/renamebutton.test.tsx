import { FakeServer, flush, inAct, installFetch, mountView, realClock, useFakeClock } from './harness'
import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { NodeConfig } from '../src/canvas/modals'
import { USER } from '../src/canvas/shared'
import type { CanvasNode } from '../src/canvas/shared'
import type { OpRequest, OpResult, ProviderInfo, TreePayload } from '../src/types'

// USER 2026-10-27 ma5cdb4296475: "make the rename button always visible, just disabled
// unless the name is changed"; mf059ecf9c6ea: "same for agent / project renaming". The
// panel Name row mirrors these (customapps-settings-split.test.tsx).

const agent = {
  id: 'worker', title: 'worker', state: 'live', tier: 'haiku', model_id: 'haiku',
  parent: USER, children: [], seat: 1, grant: 10, free: 10,
  scope: { permission_mode: 'acceptEdits', add_dirs: [], tools: { bash: true, web: true, edit: true, subagents: true, mcp: [] }, org_visibility: 'team' },
  charter: 'Build it.', team_charter: '', turns: [], audiences_held: [],
} as unknown as CanvasNode
const project = {
  id: 'website', title: 'website', kind: 'project', state: 'live', tier: 'project', model_id: '',
  seat: 0, grant: 0, free: 0, scope: { tools: {}, add_dirs: [] }, parent: USER, charter: 'Ship the site.',
  children: [], lineage: [], turns: [], audiences_held: [], mail_pending: 0,
  last_status: null, occupancy: 0, context_window: 0, busy: false, activity: null,
} as unknown as CanvasNode
const tree = {
  slug: 'org', roots: [], dirs: [], tiers: { haiku: 1, sonnet: 2, opus: 5 }, max_top_grant: 100,
  default_effort: '', effort_default: 'high', cascade_hire: true,
} as unknown as TreePayload
const codexProvider = {
  id: 'openai', label: 'Codex', cli: 'Codex CLI', tiers: [],
  status: { installed: true, connected: true, kind: 'chatgpt' }, hire_enabled: true, reason: null,
} as unknown as ProviderInfo

async function nameRow(t: TestContext, node: CanvasNode, label: string) {
  useFakeClock(); installFetch(new FakeServer())
  // the generic FakeServer fallback is {ok:true}, not an inbox answer (as in projectdesk.test.tsx)
  const inner = globalThis.fetch
  globalThis.fetch = ((url: RequestInfo | URL, init?: RequestInit) =>
    (init?.method ?? 'GET') === 'GET' && /\/nodes\/[^/]+\/inbox$/.test(new URL(String(url), 'http://fixture.invalid').pathname)
      ? Promise.resolve(new Response(JSON.stringify({ pending: [], delivered: [], sent: [], next_cursor: null }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
      : inner(url, init)) as typeof fetch
  const ops: OpRequest[] = [], toasts: string[][] = []
  const view = await mountView(<NodeConfig node={node} map={new Map([[node.id, node]])} tree={tree} slug="org"
    op={(x) => { ops.push(x); return Promise.resolve({ node: String((x as { name?: unknown }).name) } as unknown as OpResult) }}
    toast={(lines) => { toasts.push(lines ?? []) }} codexProvider={codexProvider} close={() => {}} />, el => el)
  t.after(async () => { await view.unmount(); realClock() })
  await inAct(async () => { await flush(4) })
  const input = view.el.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!
  assert.ok(input, `${label} field`)
  const rename = () => [...view.el.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent?.trim() === 'Rename')
  const type = (value: string) => inAct(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new window.Event('input', { bubbles: true }))
    await flush(2)
  })
  return { ops, toasts, rename, type }
}

for (const [what, node, label] of [['agent', agent, 'Agent name'], ['project', project, 'Project name']] as const) {
  test(`the ${what} Name row always shows Rename, enabled only for a different, non-empty name`, async t => {
    const row = await nameRow(t, node, label)
    assert.ok(row.rename(), 'Rename is always shown')
    assert.equal(row.rename()!.disabled, true, 'disabled while the name is unchanged')
    for (const same of ['', '   ', `  ${node.id} `]) {
      await row.type(same)
      assert.ok(row.rename(), `still shown for ${JSON.stringify(same)}`)
      assert.equal(row.rename()!.disabled, true, `disabled for ${JSON.stringify(same)}: blank, or the current name once trimmed`)
    }
    await inAct(async () => { row.rename()!.click(); await flush(2) })
    assert.equal(row.ops.length, 0, 'a disabled Rename sends nothing')
    await row.type(` ${node.id}-2  `)
    assert.equal(row.rename()!.disabled, false, 'enabled once the trimmed name differs')
    await inAct(async () => { row.rename()!.click(); await flush(4) })
    assert.deepEqual(row.ops, [{ op: 'rename', node: node.id, name: `${node.id}-2` }], 'the trimmed name is sent')
    assert.match(row.toasts.at(-1)?.[0] ?? '', new RegExp(`^renamed ${node.id} → ${node.id}-2`))
  })
}
