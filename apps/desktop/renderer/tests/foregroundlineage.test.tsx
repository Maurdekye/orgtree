import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { useNodeDetail } from '../src/nodedetail'
import { NodeDetailGate } from '../src/canvas/nodedetailgate'
import { forgetNodeDetail } from '../src/archived'
import type { TreeNode } from '../src/types'

const live = (patch = {}): TreeNode => ({ id: 'active', generation: 2, state: 'live', busy: true,
  charter: 'current charter', children: [], lineage_loaded: false, lineage_revision: 'c1',
  lineage_count: 1, ...patch } as unknown as TreeNode)
function Probe({ node, lineage = false, org = 'org' }: { node: TreeNode; lineage?: boolean; org?: string }) {
  const value = useNodeDetail(org, node, lineage)
  return <div>{value.ready ? JSON.stringify({ id: value.node.id, charter: value.node.charter,
    busy: value.node.busy, lineage: value.node.lineage?.map(n => n.id) }) : 'waiting'}</div>
}
const reply = (id: string) => new Response(JSON.stringify({ lineage: [{ id }], busy: false, charter: 'obsolete detail charter' }), { status: 200 })

test('live foreground panels fetch lineage only when requested and preserve current live fields', async () => {
  forgetNodeDetail()
  const original = globalThis.fetch
  let calls = 0, predecessor = 'active@1'
  globalThis.fetch = async () => { calls++; return reply(predecessor) }
  const view = await mountView(<Probe node={live()} />, el => el.textContent)
  try {
    assert.equal(calls, 0, 'ordinary live panel remains immediate')
    await view.render(<Probe node={live()} lineage />)
    await flush(4)
    assert.equal(calls, 1)
    assert.deepEqual(JSON.parse(view.last()!), { id: 'active', charter: 'current charter', busy: true, lineage: ['active@1'] })
    await view.render(<Probe node={live()} lineage />)
    assert.equal(calls, 1, 'same catalog reuses lineage')
    predecessor = 'active@0'
    await view.render(<Probe node={live({ lineage_revision: 'c2' })} lineage />)
    await flush(4)
    assert.equal(calls, 2, 'remote catalog change reaches the mounted lineage reader')
    assert.deepEqual(JSON.parse(view.last()!).lineage, ['active@0'])
  } finally { await view.unmount(); globalThis.fetch = original; forgetNodeDetail() }
})

test('live lineage gate waits for actual rows rather than interpreting omission as an empty lineage', async () => {
  forgetNodeDetail()
  const original = globalThis.fetch
  let resolve!: (value: Response) => void
  globalThis.fetch = () => new Promise<Response>(r => { resolve = r })
  const view = await mountView(<NodeDetailGate slug="org" node={live()} lineage>
    {node => <div>{node.lineage.map(n => n.id).join(',')}</div>}
  </NodeDetailGate>, el => el.textContent)
  try {
    assert.match(view.last()!, /Loading agent/)
    await inAct(() => resolve(reply('active@1')))
    await flush(4)
    assert.equal(view.last(), 'active@1')
  } finally { await view.unmount(); globalThis.fetch = original; forgetNodeDetail() }
})

test('changing org or generation never exposes the previous identity lineage during a pending fetch', async () => {
  forgetNodeDetail()
  const original = globalThis.fetch
  let slow = false, resolve!: (value: Response) => void
  globalThis.fetch = () => slow ? new Promise<Response>(r => { resolve = r }) : Promise.resolve(reply('old@1'))
  const view = await mountView(<Probe node={live()} lineage />, el => el.textContent)
  try {
    await flush(4)
    assert.match(view.last()!, /old@1/)
    slow = true
    await view.render(<Probe org="other" node={live({ generation: 3 })} lineage />)
    assert.equal(view.last(), 'waiting', 'old identity is not a temporary answer for the new org/generation')
    await inAct(() => resolve(reply('new@2')))
    await flush(4)
    assert.deepEqual(JSON.parse(view.last()!).lineage, ['new@2'])
  } finally { await view.unmount(); globalThis.fetch = original; forgetNodeDetail() }
})
