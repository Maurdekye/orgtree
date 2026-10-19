// quickchat-narrow.test.tsx — when Quick chat is squeezed, its hire options
// (model, superior, effort, attachments) collapse into one dropdown button
// that lists them on click, and the row returns when there is room again
// (user 2026-10-19 13:33Z). The switch is a function of the box's measured
// width and the row's measured natural width, with hysteresis, so it cannot
// oscillate (shell/equalsides.ts is the model: measure the controls, not the
// space they were squeezed into).
//
// Run:  cd apps/desktop/renderer && node tests/run.mjs quickchat-narrow

import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { QuickChat } from '../src/QuickChatBox'
import * as QB from '../src/QuickChatBox'
import { resetStaffingOptionsForTests } from '../src/canvas/staffingoptions'
import { legacyAppBackend } from './appfeed-fixture'
import type { TreePayload } from '../src/types'

const tree = { slug: 'narrow', roots: [], default_top_grant: 50 } as unknown as TreePayload
const ONE = 60                       // each measured control is this wide
const NEED = 5 * ONE                 // four hire options + send
const q = QB as unknown as {
  quickCompact: (compact: boolean, width: number, need: number) => boolean
  QUICK_INPUT_MIN: number
  QUICK_HYSTERESIS: number
}
const ROOM = NEED + q.QUICK_INPUT_MIN
// the room the mounted row really claims (its controls plus the box's own gaps and padding)
const roomOf = (view: { el: HTMLElement }) =>
  (QB as unknown as { rowNeed: (root: HTMLElement) => number }).rowNeed(view.el.querySelector('.quickchat') as HTMLElement) + q.QUICK_INPUT_MIN

test('§1 quickCompact: collapses below the room the row needs, returns only with hysteresis to spare', () => {
  assert.equal(q.quickCompact(false, ROOM, NEED), false, 'exactly enough room keeps the row')
  assert.equal(q.quickCompact(false, ROOM - 1, NEED), true)
  assert.equal(q.quickCompact(true, ROOM, NEED), true, 'back at the collapse width it stays collapsed')
  assert.equal(q.quickCompact(true, ROOM + q.QUICK_HYSTERESIS - 1, NEED), true)
  assert.equal(q.quickCompact(true, ROOM + q.QUICK_HYSTERESIS, NEED), false)
  // unmeasured (no layout): leave the state alone
  assert.equal(q.quickCompact(false, 0, NEED), false)
  assert.equal(q.quickCompact(true, 0, NEED), true)
  assert.equal(q.quickCompact(false, 300, 0), false, 'no measured row yet: nothing to collapse')
})

test('§1b a sweep of widths flips once per direction (no oscillation)', () => {
  let compact = false
  let flips = 0
  const sweep = (from: number, to: number) => {
    const step = from < to ? 1 : -1
    for (let w = from; w !== to; w += step) {
      const next = q.quickCompact(compact, w, NEED)
      if (next !== compact) flips++
      compact = next
    }
  }
  sweep(900, 200); sweep(200, 900); sweep(900, 200)
  assert.equal(flips, 3, 'down, up, down: one flip each')
  // jitter inside the hysteresis band never flips it
  compact = false; flips = 0
  for (let i = 0; i < 200; i++) {
    const next = q.quickCompact(compact, ROOM + 2 + (i % 2 ? 6 : 0), NEED)
    if (next !== compact) flips++
    compact = next
  }
  assert.equal(flips, 0, 'a row inside the band stays a row')
})

// jsdom does no layout: stand in for it. `box.width` is the Quick chat's width, every
// measured control is ONE wide, and the observer's callbacks are run by hand.
const box = { width: 900 }
const observers = new Set<() => void>()
const stubLayout = () => {
  const g = globalThis as unknown as Record<string, unknown>
  const proto = (window as unknown as { Element: { prototype: object } }).Element.prototype as unknown as { getBoundingClientRect: () => DOMRect }
  const was = { rect: proto.getBoundingClientRect, ro: g.ResizeObserver }
  proto.getBoundingClientRect = function (this: Element) {
    const width = this.matches('.quickchat') ? box.width
      : this.matches('.quickchat-model, .quickchat-superior, .effort-bar, .quickchat-attach, .quickchat-send') ? ONE : 0
    return { width, height: 22, top: 0, left: 0, right: width, bottom: 22, x: 0, y: 0, toJSON() {} } as DOMRect
  }
  g.ResizeObserver = class {
    cb: () => void
    constructor(cb: () => void) { this.cb = cb; observers.add(cb) }
    observe() {}
    unobserve() {}
    disconnect() { observers.delete(this.cb) }
  }
  return () => { proto.getBoundingClientRect = was.rect; g.ResizeObserver = was.ro; observers.clear() }
}
const resize = async (w: number) => {
  box.width = w
  await inAct(async () => { observers.forEach(cb => cb()); await flush(4) })
}
const quick = async () => {
  localStorage.clear(); resetStaffingOptionsForTests()
  const previous = globalThis.fetch
  globalThis.fetch = legacyAppBackend((async (input: RequestInfo | URL) => {
    const path = new URL(String(input), 'http://localhost').pathname
    return path.endsWith('/staffing-options') ? new Response(JSON.stringify({}), { status: 200 })
      : new Response(JSON.stringify({ providers: [] }), { headers: { 'content-type': 'application/json' } })
  }) as typeof fetch)
  const restoreLayout = stubLayout()
  const view = await mountView(<QuickChat slug="narrow" tree={tree} op={async () => ({})}
    toast={() => {}} onHired={() => {}} />, element => element)
  await inAct(async () => { await flush(12) })
  return {
    view,
    done: async () => {
      await view.unmount(); restoreLayout(); globalThis.fetch = previous
      localStorage.clear(); resetStaffingOptionsForTests()
    },
  }
}
const has = (el: HTMLElement, sel: string) => el.querySelector(sel) !== null
const ROW = ['.quickchat-model', '.quickchat-superior', '.effort-bar', '.quickchat-attach']

test('§2 wide: the row of hire options shows and there is no dropdown', async () => {
  box.width = 900
  const { view, done } = await quick()
  try {
    for (const sel of ROW) assert.equal(has(view.el, sel), true, `${sel} in the row`)
    assert.equal(has(view.el, '.quickchat-options'), false, 'no dropdown button')
    assert.equal(has(view.el, '.quickchat-send'), true)
  } finally { await done() }
})

test('§3 narrow: the options collapse into one dropdown button; the input and send stay', async () => {
  box.width = 900
  const { view, done } = await quick()
  try {
    await resize(roomOf(view) - 20)
    for (const sel of ROW) assert.equal(has(view.el, sel), false, `${sel} left the row`)
    const btn = view.el.querySelector('.quickchat-options') as HTMLButtonElement | null
    assert.ok(btn, 'one dropdown button')
    assert.equal(btn!.getAttribute('aria-expanded'), 'false')
    assert.ok(btn!.title && btn!.getAttribute('aria-label'), 'it names what it holds')
    assert.equal(has(view.el, '.quickchat-input') && has(view.el, '.quickchat-send'), true)
  } finally { await done() }
})

test('§4 clicking the dropdown lists every hire option; the model option still opens the model picker', async () => {
  box.width = 900
  const { view, done } = await quick()
  try {
    await resize(roomOf(view) - 20)
    const btn = view.el.querySelector('.quickchat-options') as HTMLButtonElement
    await inAct(async () => { btn.click(); await flush(4) })
    assert.equal(btn.getAttribute('aria-expanded'), 'true')
    const pop = document.body.querySelector('.quickchat-pop-options') as HTMLElement | null
    assert.ok(pop, 'the options pop-over opens')
    for (const sel of ROW) assert.equal(pop!.querySelector(sel) !== null, true, `${sel} listed in the dropdown`)
    const modelBtn = pop!.querySelector('.quickchat-model') as HTMLButtonElement
    assert.equal(modelBtn.title, 'no model is available to hire', 'same tooltip as the row')
    await inAct(async () => { modelBtn.click(); await flush(4) })
    assert.equal(document.body.querySelector('.quickchat-pop-options') === null, true, 'the list gives way to the model picker')
    assert.equal(document.body.querySelector('.quickchat-pop-model') !== null, true, 'the model picker is open')
  } finally { await done() }
})

test('§5 the row returns once there is room, with hysteresis, and never flips inside the band', async () => {
  box.width = 900
  const { view, done } = await quick()
  const row = () => has(view.el, '.quickchat-model')
  const ROOM = roomOf(view)
  try {
    await resize(ROOM - 1); assert.equal(row(), false, 'collapsed below the room')
    await resize(ROOM + 1); assert.equal(row(), false, 'still collapsed just above it')
    await resize(ROOM + q.QUICK_HYSTERESIS - 1); assert.equal(row(), false, 'still collapsed inside the band')
    await resize(ROOM + q.QUICK_HYSTERESIS); assert.equal(row(), true, 'the row is back with room to spare')
    assert.equal(has(view.el, '.quickchat-options'), false)
    await resize(ROOM + 1); assert.equal(row(), true, 'inside the band it stays a row')
    await resize(ROOM - 1); assert.equal(row(), false)
  } finally { await done() }
})
