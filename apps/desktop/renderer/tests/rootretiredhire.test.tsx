import { advance, mountView, realClock, useFakeClock } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { OrgCanvas } from '../src/canvas/OrgCanvas'
import { bunchTree, agent } from './projectbunch-fixture'
import { HIDE_RETIRED_KEY } from '../src/canvas/shared'

test('root retired list stays above resting cards but below the eye hire controls', async () => {
  useFakeClock()
  localStorage.clear()
  localStorage.setItem(HIDE_RETIRED_KEY, '1')
  const before = HTMLElement.prototype.getBoundingClientRect
  HTMLElement.prototype.getBoundingClientRect = () => ({ left: 0, top: 0, right: 1000, bottom: 700,
    x: 0, y: 0, width: 1000, height: 700, toJSON: () => ({}) }) as DOMRect
  const tree = { ...bunchTree([agent('worker')]), foreground: { hidden_retired_roots: 8 } }
  const view = await mountView(<OrgCanvas tree={tree} op={async () => ({} as never)}
    slug="root-hire-fixture" toast={() => {}} mailEvt={null} />, el => el)
  try {
    await advance(2600)
    const list = view.el.querySelector<HTMLElement>('.root-retired-list')
    assert.equal(!!list, true, 'the actual root list is mounted')
    assert.equal(list!.textContent, '8 retired')
    assert.equal(!!view.el.querySelector('.sq.user > .hsof'), true, 'the actual eye hire strip is mounted')
    const layer = Number(list!.style.zIndex)
    assert.ok(layer > 1 && layer < 5,
      `root satellite ${layer} must clear resting cards (1), while focused eye (5) and hover (6) clear it`)
  } finally {
    await view.unmount()
    HTMLElement.prototype.getBoundingClientRect = before
    localStorage.clear()
    realClock()
  }
})
