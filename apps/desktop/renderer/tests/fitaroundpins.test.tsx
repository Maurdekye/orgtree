// "FIT THE VIEW AROUND PINNED WINDOWS" (USER 2026-11-27 13:30:10Z m56eddd849c57 "add a new display option that stops
// re-fitting the active view to what's visible behind pinned windows when disabled. enabled by default"; 13:31:21Z
// mc5532e448c3b "Ignore pinned windows entirely"). Off: a pinned window or modal neither re-fits the camera when it
// opens, moves or closes, nor narrows what Fit and Focus aim at; toggling alone moves nothing.
import { FakeServer, advance, inAct, installFetch, mountView, realClock, useFakeClock } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { HUD_FIT, OrgCanvas } from '../src/canvas/OrgCanvas'
import { orgNavigationTooltip } from '../src/shell/orgnavigationbindings'
import { updatePinSurface, removePinSurface, pinSurfaceKey } from '../src/canvas/pinspace'
import { resetConvos } from '../src/convo'
import type { TreePayload } from '../src/types'

const KEY = 'orgtree-fit-around-pins'
const rect = { x: 18, y: 72, width: 1348, height: 775, top: 72, left: 18, right: 1366, bottom: 847, toJSON() {} }
const PIN = { x: 750, y: 0, w: 598, h: 775 }
function fixture(): TreePayload {
  const node = (id: string, children: any[] = []) => ({ id, title: id, state: 'live', tier: 'haiku', generation: 0,
    children, seat: 1, grant: 0, free: 0, turns: [], scope: { tools: {}, add_dirs: [] } })
  return { slug: 'fit-fixture', name: 'fit', roots: [node('planner', [node('builder'), node('reviewer')])], tiers: { haiku: 1 },
    audit: { live_nodes: 3, top_level_holds: 3, no_overdraft: true, problems: [] }, dirs: [], audiences: [],
    audience_requests: [], credit_requests: [], max_top_grant: 1000, default_top_grant: 10, compact_at: 0,
    user_inbox_count: 0, org_inbox: { visible: true, count: 0, entries: [] }, net: null,
  } as unknown as TreePayload
}
function cards(el: HTMLElement) {
  const camera = el.querySelector<HTMLElement>('.space')!.style.transform.match(/translate\(([-\d.]+)px, ([-\d.]+)px\) scale\(([-\d.]+)\)/)!
  const x = Number(camera[1]), y = Number(camera[2]), z = Number(camera[3])
  return [...el.querySelectorAll<HTMLElement>('.sq')].map(card => {
    const p = card.style.transform.match(/translate\(([-\d.]+)px, ([-\d.]+)px\)/)!
    const left = x + Number(p[1]) * z, top = y + Number(p[2]) * z
    return { left, top, right: left + parseFloat(card.style.width) * z, bottom: top + parseFloat(card.style.height) * z }
  })
}
const camera = (el: HTMLElement) => el.querySelector<HTMLElement>('.space')!.style.transform
const setPref = (enabled: boolean) => {
  localStorage.setItem(KEY, JSON.stringify({ enabled }))
  window.dispatchEvent(new window.StorageEvent('storage', { key: KEY }))
}

async function world(t: { after: (fn: () => void | Promise<void>) => void }, pref: boolean | null) {
  localStorage.clear(); resetConvos(); useFakeClock(); installFetch(new FakeServer())
  if (pref !== null) localStorage.setItem(KEY, JSON.stringify({ enabled: pref }))
  // the store caches its reading: a storage event (as from another window) makes it read again
  window.dispatchEvent(new window.StorageEvent('storage', { key: KEY }))
  const original = window.HTMLElement.prototype.getBoundingClientRect
  window.HTMLElement.prototype.getBoundingClientRect = function () { return this.classList.contains('viewport') ? rect : original.call(this) }
  const key = pinSurfaceKey('fit-fixture', 'docket', true)
  const v = await mountView(<OrgCanvas tree={fixture()} slug="fit-fixture" op={async () => ({})} toast={() => {}} mailEvt={null} />, el => el)
  t.after(async () => {
    await v.unmount(); removePinSurface(key); window.HTMLElement.prototype.getBoundingClientRect = original
    localStorage.clear(); window.dispatchEvent(new window.StorageEvent('storage', { key: KEY })); resetConvos(); realClock()
  })
  const fit = async () => {
    await inAct(() => v.el.querySelector<HTMLButtonElement>(`button[title="${orgNavigationTooltip(HUD_FIT, 'fitOrg')}"]`)!.click())
    await advance(2500)
  }
  return { el: v.el, key, fit }
}

test('ON (the default): a pinned window re-fits the view into the space beside it (positive control, today’s behaviour)', async (t) => {
  const w = await world(t, null)
  await advance(2500)
  const before = camera(w.el)
  await inAct(() => updatePinSurface(w.key, 'fit-fixture', PIN, true))
  await advance(1500)
  assert.notEqual(camera(w.el), before, 'the pin re-fits the view')
  for (const c of cards(w.el)) assert.ok(c.right <= PIN.x, `every card is left of the pin: ${JSON.stringify(c)}`)
})

test('OFF: a pinned window opening, moving or closing never moves the camera', async (t) => {
  const w = await world(t, false)
  await advance(2500)
  const before = camera(w.el)
  await inAct(() => updatePinSurface(w.key, 'fit-fixture', PIN, true))
  await advance(1500)
  assert.equal(camera(w.el), before, 'opening a pin leaves the view where it was')
  await inAct(() => updatePinSurface(w.key, 'fit-fixture', { ...PIN, x: 500, w: 848 }, true))
  await advance(1500)
  assert.equal(camera(w.el), before, 'moving or resizing it too')
  await inAct(() => removePinSurface(w.key))
  await advance(1500)
  assert.equal(camera(w.el), before, 'and closing it')
})

test('OFF: Fit uses the whole canvas, as if no window were pinned', async (t) => {
  const w = await world(t, false)
  await advance(2500)
  await w.fit()
  const bare = camera(w.el)
  await inAct(() => updatePinSurface(w.key, 'fit-fixture', PIN, true))
  await advance(1500)
  await w.fit()
  assert.equal(camera(w.el), bare, 'the fit with a pinned window is the fit without one')
  const all = cards(w.el)
  assert.equal(all.length, 5, 'POSITIVE CONTROL: eye, inbox, parent and two children')
  for (const c of all) assert.ok(c.left >= 0 && c.right <= rect.width && c.top >= 0 && c.bottom <= rect.height, JSON.stringify(c))
  assert.ok(all.some(c => c.right > PIN.x), 'the fit reaches under the pinned window')
})

test('toggling the option alone moves nothing; the next Fit follows it', async (t) => {
  const w = await world(t, null)
  await advance(2500)
  await inAct(() => updatePinSurface(w.key, 'fit-fixture', PIN, true))
  await advance(1500)
  const beside = camera(w.el)
  for (const c of cards(w.el)) assert.ok(c.right <= PIN.x, 'POSITIVE CONTROL: on, the view sits beside the pin')
  await inAct(() => setPref(false))
  await advance(1500)
  assert.equal(camera(w.el), beside, 'turning it off does not move the view')
  await w.fit()
  assert.ok(cards(w.el).some(c => c.right > PIN.x), 'the next Fit uses the whole canvas')
  const whole = camera(w.el)
  await inAct(() => setPref(true))
  await advance(1500)
  assert.equal(camera(w.el), whole, 'turning it back on does not move the view either')
  await w.fit()
  for (const c of cards(w.el)) assert.ok(c.right <= PIN.x, 'and the next Fit is beside the pin again')
})
