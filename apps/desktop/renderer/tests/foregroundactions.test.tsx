import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { DeleteNodeConfirm, PilePicker } from '../src/canvas/modals'
import { invalidateTreeCache } from '../src/api'
import type { CanvasNode, Pile } from '../src/canvas/shared'
import type { TreePayload } from '../src/types'

const node = (id: string, children: CanvasNode[] = []): CanvasNode => ({
  id, children, generation: 1, lineage: [], state: 'archived', tier: 'haiku',
} as unknown as CanvasNode)
const partial = { slug: 'org', roots: [node('parent')], foreground: {
  catalog_revision: 'c1', present: ['parent'], missing: [],
} } as unknown as TreePayload
const buttons = (el: HTMLElement) => [...el.querySelectorAll('button')]

test('a partial retired pile exposes loading feedback but no pick or delete action until complete', async () => {
  let deleted = 0, picked = 0
  const pile: Pile = { key: 'p|a', parent: 'p', kind: 'a', list: ['one'], front: 'one', total: 200 }
  const map = new Map([['one', node('one')]])
  const props = { pile, map, close: () => {}, onPick: () => { picked++ }, op: async () => { deleted++; return {} } }
  const view = await mountView(<PilePicker {...props} ready={false} />, el => el)
  try {
    assert.match(view.last().textContent!, /200 agents/)
    assert.match(view.last().textContent!, /Loading retired agents/)
    assert.equal(view.last().querySelectorAll('.pile-row').length, 0)
    assert.equal(buttons(view.last()).some(b => b.textContent?.includes('delete all')), false)
    await view.render(<PilePicker {...props} ready />)
    await inAct(() => buttons(view.last()).find(b => b.textContent?.includes('delete all'))!.click())
    assert.match(view.last().textContent!, /permanently delete all/)
    await view.render(<PilePicker {...props} ready={false} />)
    assert.doesNotMatch(view.last().textContent!, /permanently delete all/)
    assert.equal(deleted, 0)
    assert.equal(picked, 0)
  } finally { await view.unmount() }
})

test('delete confirmation waits for full descendant counts and never enables deletion on read failure', async () => {
  invalidateTreeCache()
  const original = globalThis.fetch
  let resolve!: (response: Response) => void, deleted = 0
  globalThis.fetch = () => new Promise<Response>(r => { resolve = r })
  const props = { node: node('parent'), tree: partial, slug: 'org', close: () => {}, onConfirm: () => { deleted++ } }
  const view = await mountView(<DeleteNodeConfirm {...props} />, el => el)
  try {
    assert.match(view.last().textContent!, /Loading full deletion scope/)
    assert.equal(buttons(view.last()).some(b => b.textContent === 'delete permanently'), false)
    await inAct(() => resolve(new Response(JSON.stringify({ slug: 'org', roots: [node('parent', [node('child', [node('grandchild')])])] }))))
    await flush(4)
    assert.match(view.last().textContent!, /plus 2 descendant/)
    assert.ok(buttons(view.last()).some(b => b.textContent === 'delete permanently'))
    await view.render(<DeleteNodeConfirm {...props} tree={{ ...partial, foreground: { ...partial.foreground!, catalog_revision: 'c2' } }} />)
    assert.equal(buttons(view.last()).some(b => b.textContent === 'delete permanently'), false)
    await inAct(() => resolve(new Response('unavailable', { status: 503 })))
    await flush(4)
    assert.ok(view.last().querySelector('[role="alert"]'))
    assert.equal(buttons(view.last()).some(b => b.textContent === 'delete permanently'), false)
    assert.equal(deleted, 0)
  } finally { await view.unmount(); globalThis.fetch = original; invalidateTreeCache() }
})

test('a late deletion-scope read cannot authorize a different identity or generation', async () => {
  invalidateTreeCache()
  const original = globalThis.fetch
  const pending: ((r: Response) => void)[] = []
  globalThis.fetch = () => new Promise<Response>(resolve => pending.push(resolve))
  const props = { tree: partial, slug: 'org', close: () => {}, onConfirm: () => {} }
  const view = await mountView(<DeleteNodeConfirm {...props} node={node('parent')} />, el => el)
  try {
    await view.render(<DeleteNodeConfirm {...props} node={{ ...node('other'), generation: 2 }} />)
    await inAct(() => pending[0]!(new Response(JSON.stringify({ roots: [node('parent')] }))))
    await flush(4)
    assert.equal(buttons(view.last()).some(b => b.textContent === 'delete permanently'), false)
    await inAct(() => pending[1]!(new Response(JSON.stringify({ roots: [node('other')] }))))
    await flush(4)
    assert.match(view.last().textContent!, /agent changed/)
    assert.equal(buttons(view.last()).some(b => b.textContent === 'delete permanently'), false)
  } finally { await view.unmount(); globalThis.fetch = original; invalidateTreeCache() }
})
