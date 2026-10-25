import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { CreditGrant, CreditGrantControl } from '../src/canvas/creditgrant'
import type { CanvasNode } from '../src/canvas/shared'
import type { TreePayload } from '../src/types'

const tree = { max_top_grant: 20, cascade_alloc: true } as TreePayload

async function edit(slider: Element, target: number) {
  const current = Number(slider.getAttribute('aria-valuenow'))
  const key = target > current ? 'ArrowRight' : 'ArrowLeft'
  await inAct(async () => {
    for (let n = 0; n < Math.abs(target - current); n++)
      slider.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
    slider.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true }))
    await flush(3)
  })
}

for (const accepted of [10, 9]) {
  test(`live grant edits use accepted ${accepted} before a stale tree refresh`, async t => {
    const node = { id: 'live', parent: null, tier: 'sol', seat: 2, grant: 5, free: 5, children: [] } as CanvasNode
    const deltas: number[] = []
    let actual = 5
    const view = await mountView(<CreditGrant node={node} map={new Map([[node.id, node]])} tree={tree}
      op={async body => {
        const delta = Number(body.delta); deltas.push(delta)
        actual = deltas.length === 1 ? accepted : actual + delta
        return { grant: actual }
      }} />, el => el)
    t.after(() => view.unmount())
    const slider = view.el.querySelector('[role="slider"]')!
    await edit(slider, 10)
    assert.equal(slider.getAttribute('aria-valuenow'), String(accepted), 'successful server result is displayed')
    assert.equal(node.grant, 5, 'tree deliberately remains stale between edits')
    await edit(slider, 12)
    assert.deepEqual(deltas, [5, 12 - accepted], 'second edit sends only the change from the accepted grant')
    assert.equal(actual, 12, 'backend reaches the requested total without excess allocation')
    assert.equal(slider.getAttribute('aria-valuenow'), '12')
  })
}

test('a refused live edit leaves the previous grant as the next delta baseline', async t => {
  const node = { id: 'live', parent: null, tier: 'sol', seat: 2, grant: 5, free: 5, children: [] } as CanvasNode
  const deltas: number[] = []
  const view = await mountView(<CreditGrant node={node} map={new Map([[node.id, node]])} tree={tree}
    op={async body => {
      deltas.push(Number(body.delta))
      if (deltas.length === 1) throw new Error('Synthetic capacity refusal')
      return { grant: 8 }
    }} />, el => el)
  t.after(() => view.unmount())
  const slider = view.el.querySelector('[role="slider"]')!
  await edit(slider, 10)
  assert.equal(slider.getAttribute('aria-valuenow'), '5')
  assert.match(view.el.querySelector('[role="alert"]')?.textContent ?? '', /capacity refusal/)
  await edit(slider, 8)
  assert.deepEqual(deltas, [5, 3])
  assert.equal(slider.getAttribute('aria-valuenow'), '8')
})

test('draft grant commits remain absolute across sequential staged edits', async t => {
  const staged: number[] = []
  const view = await mountView(<CreditGrantControl value={5} limits={{ min: 0, max: 20 }} seat={2}
    onCommit={next => { staged.push(next) }} />, el => el)
  t.after(() => view.unmount())
  const slider = view.el.querySelector('[role="slider"]')!
  await edit(slider, 10)
  await edit(slider, 12)
  assert.deepEqual(staged, [10, 12])
  assert.equal(slider.getAttribute('aria-valuenow'), '12')
})
