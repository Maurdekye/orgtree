import { FakeServer, advance, inAct, installFetch, mountView, realClock, useFakeClock } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { useState } from 'react'
import { OrgCanvas } from '../src/canvas/OrgCanvas'
import { updatePinSurface, removePinSurface, pinSurfaceKey } from '../src/canvas/pinspace'
import { resetConvos } from '../src/convo'
import type { TreePayload } from '../src/types'

const rect = { x: 18, y: 72, width: 1348, height: 775, top: 72, left: 18, right: 1366, bottom: 847, toJSON() {} }
function fixture(inbox: boolean): TreePayload {
  const node = (id: string, children: any[] = []) => ({ id, title: id, state: 'live', tier: 'haiku', generation: 0,
    children, seat: 1, grant: 0, free: 0, turns: [], scope: { tools: {}, add_dirs: [] } })
  return { slug: 'fit-fixture', name: 'fit', roots: [node('planner', [node('builder'), node('reviewer')])], tiers: { haiku: 1 },
    audit: { live_nodes: 3, top_level_holds: 3, no_overdraft: true, problems: [] }, dirs: [], audiences: [],
    audience_requests: [], credit_requests: [], max_top_grant: 1000, default_top_grant: 10, compact_at: 0,
    user_inbox_count: 0, org_inbox: inbox ? { visible: true, count: 0, entries: [] } : null, net: null,
  } as unknown as TreePayload
}
function positions(el: HTMLElement) {
  const transform = el.querySelector<HTMLElement>('.space')!.style.transform
  const camera = transform.match(/translate\(([-\d.]+)px, ([-\d.]+)px\) scale\(([-\d.]+)\)/)!
  assert.ok(camera, transform)
  const x = Number(camera[1]), y = Number(camera[2]), z = Number(camera[3])
  return [...el.querySelectorAll<HTMLElement>('.sq')].map(card => {
    const position = card.style.transform.match(/translate\(([-\d.]+)px, ([-\d.]+)px\)/)!
    assert.ok(position, card.style.transform)
    const left = x + Number(position[1]) * z, top = y + Number(position[2]) * z
    return { name: card.querySelector('.name')?.textContent ?? card.className, left, top,
      right: left + parseFloat(card.style.width) * z, bottom: top + parseFloat(card.style.height) * z }
  })
}

test('fit whole org includes the latest inbox headroom and every child after the graph changes', async () => {
  localStorage.clear(); resetConvos(); useFakeClock(); installFetch(new FakeServer())
  const original = window.HTMLElement.prototype.getBoundingClientRect
  window.HTMLElement.prototype.getBoundingClientRect = function () { return this.classList.contains('viewport') ? rect : original.call(this) }
  let showInbox: (visible?: boolean) => void = () => {}
  function View() {
    const [inbox, setInbox] = useState(false); showInbox = (visible = true) => setInbox(visible)
    return <OrgCanvas tree={fixture(inbox)} slug="fit-fixture" op={async () => ({})} toast={() => {}} mailEvt={null} />
  }
  const v = await mountView(<View />, el => el)
  try {
    await advance(2500)
    await inAct(() => { showInbox() })
    await advance(2500)
    for (const card of positions(v.el)) assert.ok(card.bottom <= rect.height, 'startup layout update stays fitted: ' + JSON.stringify(card))
    const fit = v.el.querySelector<HTMLButtonElement>('button[title="fit the whole org"]')!
    assert.ok(fit)
    await inAct(() => { fit.click() })
    await advance(2500)
    const cards = positions(v.el)
    assert.equal(cards.length, 5, 'positive control: eye, inbox, parent and two children all exist')
    for (const card of cards) {
      assert.ok(card.left >= 0 && card.right <= rect.width && card.top >= 0 && card.bottom <= rect.height,
        JSON.stringify(card))
    }
    await inAct(() => { v.el.querySelector<HTMLButtonElement>('button[title="zoom in"]')!.click() })
    await advance(600)
    const chosen = v.el.querySelector<HTMLElement>('.space')!.style.transform
    await inAct(() => { showInbox(false) })
    await advance(1000)
    assert.equal(v.el.querySelector<HTMLElement>('.space')!.style.transform, chosen, 'a user-selected zoom is never replaced by a later automatic fit')
  } finally { await v.unmount(); window.HTMLElement.prototype.getBoundingClientRect = original; resetConvos(); realClock() }
})


test('opening fit follows restored pin geometry but preserves a manually chosen camera', async () => {
  localStorage.clear(); resetConvos(); useFakeClock(); installFetch(new FakeServer())
  const original = window.HTMLElement.prototype.getBoundingClientRect
  window.HTMLElement.prototype.getBoundingClientRect = function () { return this.classList.contains('viewport') ? rect : original.call(this) }
  const key = pinSurfaceKey('fit-fixture', 'docket', true)
  const v = await mountView(<OrgCanvas tree={fixture(true)} slug="fit-fixture" op={async () => ({})} toast={() => {}} mailEvt={null} />, el => el)
  try {
    await advance(2500)
    const initial = v.el.querySelector<HTMLElement>('.space')!.style.transform
    await inAct(() => updatePinSurface(key, 'fit-fixture', {x: 750, y: 0, w: 598, h: 775}, true))
    await advance(1000)
    assert.notEqual(v.el.querySelector<HTMLElement>('.space')!.style.transform, initial, 'late restored pin changes the opening fit')
    const cards = positions(v.el)
    assert.equal(cards.length, 5)
    for (const card of cards) assert.ok(card.left >= 0 && card.right <= 750 && card.top >= 0 && card.bottom <= rect.height, JSON.stringify(card))
    await inAct(() => v.el.querySelector<HTMLButtonElement>('button[title="zoom in"]')!.click())
    await advance(600)
    const chosen = v.el.querySelector<HTMLElement>('.space')!.style.transform
    await inAct(() => removePinSurface(key))
    await advance(1000)
    assert.equal(v.el.querySelector<HTMLElement>('.space')!.style.transform, chosen, 'manual camera is not refitted when a pin closes')
  } finally { await v.unmount(); removePinSurface(key); window.HTMLElement.prototype.getBoundingClientRect = original; resetConvos(); realClock() }
})
