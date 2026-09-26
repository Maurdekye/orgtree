import './harness'
import { FakeServer, flush, inAct, installFetch, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { clearNodeMetadata, publishNodeMetadata, replaceNodeMetadata, useNodeMetadata } from '../src/nodemetadata'
import { newSync, onBase, onFrame } from '../src/treesync'
import { DeskChat } from '../src/canvas/desk'
import type { CanvasNode } from '../src/canvas/shared'
import type { CacheForecast, TreeNode } from '../src/types'
import type { WsEvent } from '../src/api'

const node = (id: string, generation = 1): TreeNode => ({ id, generation,
  state: 'live', tier: 'haiku', children: [], parent: null, seat: 1, grant: 0, free: 0,
  scope: { tools: { mcp: ['alpha'] }, add_dirs: [] },
  mcp_tool_count: 2, last_turn_mcp_tool_count: null, mcp_tool_count_provider: 'claude',
  mcp_tool_count_source: null, mcp_tool_count_reason: null,
} as unknown as TreeNode)
const frame = (id: string, count: number | null, rev = 1): Extract<WsEvent, { type: 'node_stream' }> =>
  ({ type: 'node_stream', node: id, kind: 'mcp_tool_count', count, rev })

test('metadata updates only their subscriber; later subscribers receive the latest value', async t => {
  const org = 'metadata-subscriptions', a = node('a'), b = node('b')
  replaceNodeMetadata(org, [a, b])
  let aRenders = 0, bRenders = 0
  function Probe({ original }: { original: TreeNode }) {
    const current = useNodeMetadata(org, original)
    if (original.id === 'a') aRenders++; else bRenders++
    return <span data-node={original.id}>{String(current.mcp_tool_count)}</span>
  }
  const view = await mountView(<><Probe original={a} /><Probe original={b} /></>, el => el)
  t.after(async () => { await view.unmount(); clearNodeMetadata(org) })
  assert.ok(aRenders > 0 && bRenders > 0, 'both controls mounted')
  const aBefore = aRenders, bBefore = bRenders
  await inAct(() => publishNodeMetadata(org, frame('a', 9)))
  assert.ok(aRenders > aBefore)
  assert.equal(bRenders, bBefore, 'unchanged sibling did not render')
  assert.equal(view.el.querySelector('[data-node="a"]')?.textContent, '9')
  const after = aRenders
  await inAct(() => publishNodeMetadata(org, frame('a', 9)))
  assert.equal(aRenders, after, 'identical metadata does not notify')
  await view.render(<Probe original={b} />)
  await inAct(() => publishNodeMetadata(org, frame('a', 12)))
  await view.render(<Probe original={a} />)
  assert.equal(view.el.textContent, '12', 'reopening a desk catches up without a tree refresh')
})

test('an older base replays newer frames atomically, and later generations and removals replace cached facts', async t => {
  const org = 'metadata-base', a = node('a'), sync = newSync()
  replaceNodeMetadata(org, [a])
  const seen: (number | null)[] = []
  function Probe({ original }: { original: TreeNode }) {
    const current = useNodeMetadata(org, original)
    seen.push(current.mcp_tool_count)
    return <span>{String(current.mcp_tool_count)}</span>
  }
  const view = await mountView(<Probe original={a} />, el => el)
  t.after(async () => { await view.unmount(); clearNodeMetadata(org) })
  for (const event of [frame('a', 5, 10), frame('a', 9, 11)]) {
    onFrame(sync, event)
    await inAct(() => publishNodeMetadata(org, event))
  }
  seen.length = 0
  await inAct(() => replaceNodeMetadata(org, [a], onBase(sync, 9) as ReturnType<typeof frame>[]))
  assert.equal(view.el.textContent, '9', 'older body cannot undo the live patch')
  assert.ok(seen.every(value => value === 9), 'no transient rollback was published')
  const newer = { ...node('a', 2), mcp_tool_count: 4 }
  await inAct(() => replaceNodeMetadata(org, [newer]))
  assert.equal(view.el.textContent, '2', 'new generation metadata is not applied to old generation props')
  await view.render(<Probe original={newer} />)
  assert.equal(view.el.textContent, '4')
  await inAct(() => { replaceNodeMetadata(org, []); publishNodeMetadata(org, frame('a', 99)) })
  await view.render(<Probe original={node('a', 2)} />)
  assert.equal(view.el.textContent, '2', 'removed identity retained no overlay and ignores late frames')
  await inAct(() => { replaceNodeMetadata(org, [a]); publishNodeMetadata(org, frame('a', 8)); clearNodeMetadata(org) })
  assert.equal(view.el.textContent, '2', 'org disposal removes cached metadata')
})

test('real desk displays live count/reset and readiness without new node props', async t => {
  const org = 'metadata-desk', a = node('agent') as CanvasNode
  installFetch(new FakeServer())
  replaceNodeMetadata(org, [a as TreeNode])
  const view = await mountView(<DeskChat node={a} map={new Map([[a.id, a]])}
    op={async () => ({})} slug={org} toast={() => {}} bare />, el => el)
  t.after(async () => { await view.unmount(); clearNodeMetadata(org) })
  await flush()
  const label = () => view.el.querySelector('.mcp-tool-count')?.getAttribute('aria-label')
  assert.match(label() ?? '', /2 callable MCP tools/)
  await inAct(() => publishNodeMetadata(org, frame(a.id, 9)))
  assert.match(label() ?? '', /9 callable MCP tools/)
  await inAct(() => publishNodeMetadata(org, { ...frame(a.id, null), last_turn_count: 9 }))
  assert.match(label() ?? '', /9 .*last turn/)
  await inAct(() => publishNodeMetadata(org, { type: 'node_stream', node: a.id, kind: 'mcp_readiness',
    waiting: true, state: 'waiting', reason: 'missing alpha' }))
  assert.match(label() ?? '', /waiting: missing alpha/)
  await inAct(() => publishNodeMetadata(org, { type: 'node_stream', node: a.id, kind: 'mcp_readiness',
    waiting: false, state: 'ready', reason: null }))
  assert.doesNotMatch(label() ?? '', /missing alpha/)
})

test('cache forecasts reset to null and never cross organization boundaries', async t => {
  const a = node('same-id'), left = 'metadata-left', right = 'metadata-right'
  replaceNodeMetadata(left, [a]); replaceNodeMetadata(right, [a])
  function Forecast({ org }: { org: string }) {
    const current = useNodeMetadata(org, a)
    return <span data-org={org}>{current.cache_forecast?.reason ?? 'none'}</span>
  }
  const view = await mountView(<><Forecast org={left} /><Forecast org={right} /></>, el => el)
  t.after(async () => { await view.unmount(); clearNodeMetadata(left); clearNodeMetadata(right) })
  const text = (org: string) => view.el.querySelector(`[data-org="${org}"]`)?.textContent
  const forecast = { generation: 'process-one', reason: 'prefix changed' } as CacheForecast
  await inAct(() => publishNodeMetadata(left, { type: 'node_stream', node: a.id, kind: 'cache_forecast', forecast }))
  assert.equal(text(left), 'prefix changed')
  assert.equal(text(right), 'none')
  await inAct(() => publishNodeMetadata(left, { type: 'node_stream', node: a.id, kind: 'cache_forecast', forecast: null }))
  assert.equal(text(left), 'none', 'explicit null clears the previous forecast')
})
