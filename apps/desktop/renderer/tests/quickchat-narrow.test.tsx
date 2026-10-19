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
const dropdown = { left: 700, right: 890, top: 400, bottom: 520 }
const SUBW = 360
const observers = new Set<() => void>()
const stubLayout = () => {
  const g = globalThis as unknown as Record<string, unknown>
  const proto = (window as unknown as { Element: { prototype: object } }).Element.prototype as unknown as { getBoundingClientRect: () => DOMRect }
  const was = { rect: proto.getBoundingClientRect, ro: g.ResizeObserver }
  proto.getBoundingClientRect = function (this: Element) {
    if (this.matches('.quickchat-pop-options, .quickchat-options')) {
      const d = dropdown
      return { width: d.right - d.left, height: d.bottom - d.top, top: d.top, left: d.left, right: d.right, bottom: d.bottom,
        x: d.left, y: d.top, toJSON() {} } as DOMRect
    }
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
const quick = async (inFooter = false) => {
  localStorage.clear(); resetStaffingOptionsForTests()
  const previous = globalThis.fetch
  globalThis.fetch = legacyAppBackend((async (input: RequestInfo | URL) => {
    const path = new URL(String(input), 'http://localhost').pathname
    return path.endsWith('/staffing-options') ? new Response(JSON.stringify({}), { status: 200 })
      : new Response(JSON.stringify({ providers: [] }), { headers: { 'content-type': 'application/json' } })
  }) as typeof fetch)
  const restoreLayout = stubLayout()
  const chat = <QuickChat slug="narrow" tree={tree} op={async () => ({})} toast={() => {}} onHired={() => {}} />
  const view = await mountView(inFooter ? <footer>{chat}</footer> : chat, element => element)
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

test('§4 clicking the dropdown lists every hire option; the model option still opens the model picker (beside the list)', async () => {
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
    assert.equal(document.body.querySelector('.quickchat-pop-options') !== null, true, 'the list stays open beside the model picker')
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

// §6 (user 2026-10-19 16:57Z): a picker opened from the dropdown must not cover the
//    dropdown. It opens BESIDE it (left, else right, else stacked outward), the
//    dropdown stays, and closing the picker returns to the dropdown alone.
const viewport = (w: number, h: number) => {
  const win = window as unknown as Record<string, unknown>
  const was = { w: win.innerWidth, h: win.innerHeight }
  win.innerWidth = w; win.innerHeight = h
  const proto = (window as unknown as { HTMLElement: { prototype: object } }).HTMLElement.prototype
  Object.defineProperty(proto, 'offsetWidth', { configurable: true, get(this: HTMLElement) { return this.matches('.quickchat-pop') && !this.matches('.quickchat-pop-options') ? SUBW : 0 } })
  return () => { win.innerWidth = was.w; win.innerHeight = was.h; delete (proto as Record<string, unknown>).offsetWidth }
}
const pops = () => ({
  options: document.body.querySelector('.quickchat-pop-options') as HTMLElement | null,
  sup: document.body.querySelector('.quickchat-pop-superior') as HTMLElement | null,
  model: document.body.querySelector('.quickchat-pop-model') as HTMLElement | null,
})
const openDropdown = async (view: { el: HTMLElement }) => {
  await resize(roomOf(view) - 20)
  await inAct(async () => { (view.el.querySelector('.quickchat-options') as HTMLElement).click(); await flush(4) })
}
const clickIn = async (sel: string) => {
  await inAct(async () => { (document.body.querySelector(sel) as HTMLElement).click(); await flush(4) })
}
const key = async (k: string) => inAct(async () => {
  document.dispatchEvent(new window.KeyboardEvent('keydown', { key: k, bubbles: true })); await flush(4)
})
const pressOutside = async () => inAct(async () => {
  document.body.dispatchEvent(new window.MouseEvent('pointerdown', { bubbles: true })); await flush(4)
})
const setDropdown = (left: number, right: number, top = 400, bottom = 520) => Object.assign(dropdown, { left, right, top, bottom })

test('§6.1 the superior picker opens beside the dropdown (to its left when the right has no room), bottoms aligned, dropdown kept', async () => {
  box.width = 900; setDropdown(700, 890)
  const restoreView = viewport(1000, 700)
  const { view, done } = await quick(true)
  try {
    await openDropdown(view)
    await clickIn('.quickchat-pop-options .quickchat-superior')
    const p = pops()
    assert.ok(p.options, 'the dropdown stays open under the picker')
    assert.ok(p.sup, 'the agent picker is open')
    assert.equal(p.sup!.style.left, `${700 - 6 - SUBW}px`, 'left of the dropdown, 6px clear')
    assert.equal(p.sup!.style.bottom, `${700 - 520}px`, 'bottom edge level with the dropdown (it opens upward from the footer)')
    assert.ok(parseFloat(p.sup!.style.left) + SUBW <= 700, 'no overlap with the dropdown')
  } finally { await done(); restoreView() }
})

test('§6.2 with room on the right it opens to the right of the dropdown', async () => {
  box.width = 900; setDropdown(40, 230)
  const restoreView = viewport(1000, 700)
  const { view, done } = await quick(true)
  try {
    await openDropdown(view)
    await clickIn('.quickchat-pop-options .quickchat-superior')
    assert.equal(pops().sup!.style.left, `${230 + 6}px`)
  } finally { await done(); restoreView() }
})

test('§6.3 in a window too narrow for either side it stacks above the dropdown, inside the window', async () => {
  box.width = 900; setDropdown(100, 290)
  const restoreView = viewport(400, 700)
  const { view, done } = await quick(true)
  try {
    await openDropdown(view)
    await clickIn('.quickchat-pop-options .quickchat-superior')
    const s = pops().sup!.style
    assert.equal(s.left, `${400 - SUBW - 8}px`, 'clamped inside the window')
    assert.equal(s.bottom, `${700 - 400 + 6}px`, 'its bottom edge 6px above the dropdown top')
    assert.equal(s.maxHeight, `${400 - 6 - 8}px`, 'no taller than the space above the dropdown')
  } finally { await done(); restoreView() }
})

test('§6.4 the model picker is kept beside the dropdown too', async () => {
  box.width = 900; setDropdown(700, 890)
  const restoreView = viewport(1000, 700)
  const { view, done } = await quick(true)
  try {
    await openDropdown(view)
    await clickIn('.quickchat-pop-options .quickchat-model')
    const p = pops()
    assert.ok(p.options && p.model, 'dropdown and model chips both open')
    assert.equal(p.model!.style.left, `${700 - 6 - SUBW}px`)
  } finally { await done(); restoreView() }
})

test('§6.5 Escape closes the picker and returns to the dropdown; a second Escape closes the dropdown', async () => {
  box.width = 900; setDropdown(700, 890)
  const restoreView = viewport(1000, 700)
  const { view, done } = await quick(true)
  try {
    await openDropdown(view)
    await clickIn('.quickchat-pop-options .quickchat-superior')
    await key('Escape')
    assert.equal(pops().sup === null, true, 'the picker closed')
    assert.equal(pops().options !== null, true, 'the dropdown is back on its own')
    assert.equal(view.el.querySelector('.quickchat-options')!.getAttribute('aria-expanded'), 'true')
    await key('Escape')
    assert.equal(pops().options === null, true, 'the second Escape closes the dropdown')
  } finally { await done(); restoreView() }
})

test('§6.6 a press inside either pop-over keeps both; a press outside closes both', async () => {
  box.width = 900; setDropdown(700, 890)
  const restoreView = viewport(1000, 700)
  const { view, done } = await quick(true)
  try {
    await openDropdown(view)
    await clickIn('.quickchat-pop-options .quickchat-superior')
    await inAct(async () => {
      (document.body.querySelector('.quickchat-pop-options .quickchat-opt-cap') as HTMLElement)
        .dispatchEvent(new window.MouseEvent('pointerdown', { bubbles: true })); await flush(4)
    })
    assert.equal(pops().options !== null && pops().sup !== null, true, 'a press on the dropdown keeps both')
    await inAct(async () => {
      (document.body.querySelector('.quickchat-pop-superior input') as HTMLElement)
        .dispatchEvent(new window.MouseEvent('pointerdown', { bubbles: true })); await flush(4)
    })
    assert.equal(pops().options !== null && pops().sup !== null, true, 'a press in the picker keeps both')
    await pressOutside()
    assert.equal(pops().options === null && pops().sup === null, true, 'outside closes both')
  } finally { await done(); restoreView() }
})

test('§6.7 clicking the same option again drops the picker and leaves the dropdown', async () => {
  box.width = 900; setDropdown(700, 890)
  const restoreView = viewport(1000, 700)
  const { view, done } = await quick(true)
  try {
    await openDropdown(view)
    await clickIn('.quickchat-pop-options .quickchat-superior')
    await clickIn('.quickchat-pop-options .quickchat-superior')
    assert.equal(pops().sup === null && pops().options !== null, true)
  } finally { await done(); restoreView() }
})

test('§6.8 in the wide row nothing changes: the picker opens from its own button, no dropdown', async () => {
  box.width = 900
  const { view, done } = await quick(true)
  try {
    await inAct(async () => { (view.el.querySelector('.quickchat-superior') as HTMLElement).click(); await flush(4) })
    assert.equal(pops().sup !== null && pops().options === null, true)
    assert.equal(pops().sup!.style.left !== '', true)
  } finally { await done() }
})

// The empty-files action opens a native picker, not another pop-over. Its
// launching dropdown must remain mounted across blur, cancel and selection.
test('§7.1 empty files opens the picker and keeps the dropdown through blur and cancel', async () => {
  box.width = 900
  const { view, done } = await quick(true)
  try {
    await openDropdown(view)
    const input = view.el.querySelector<HTMLInputElement>('[data-testid="quickchat-files"]')!
    let picks = 0
    input.addEventListener('click', () => {
      picks++
      window.dispatchEvent(new window.Event('blur'))
    })
    await inAct(async () => {
      const attach = document.querySelector<HTMLElement>('.quickchat-pop-options .quickchat-attach')!
      attach.dispatchEvent(new window.MouseEvent('pointerdown', { bubbles: true }))
      attach.click(); await flush(4)
    })
    assert.equal(picks, 1, 'opens the existing file input once')
    assert.equal(pops().options !== null, true, 'native picker blur keeps the dropdown')
    await inAct(async () => {
      input.dispatchEvent(new window.Event('cancel', { bubbles: true }))
      window.dispatchEvent(new window.Event('focus')); await flush(4)
    })
    assert.equal(pops().options !== null, true, 'cancel returns to the same options')
    await key('Escape')
    assert.equal(pops().options === null, true, 'Escape still dismisses the dropdown')
  } finally { await done() }
})

test('§7.2 chosen files stay attached with dropdown open; adding more keeps both pop-overs', async () => {
  box.width = 900
  const { view, done } = await quick(true)
  try {
    await openDropdown(view)
    await clickIn('.quickchat-pop-options .quickchat-attach')
    const input = view.el.querySelector<HTMLInputElement>('[data-testid="quickchat-files"]')!
    const choose = async (name: string) => inAct(async () => {
      Object.defineProperty(input, 'files', { configurable: true,
        value: [new window.File(['synthetic'], name, { type: 'text/plain' })] })
      input.dispatchEvent(new window.Event('change', { bubbles: true })); await flush(4)
    })
    await choose('first.txt')
    assert.equal(pops().options !== null, true, 'selection keeps the options visible')
    assert.equal(document.querySelector('.quickchat-pop-options .quickchat-count')?.textContent, '1')
    await clickIn('.quickchat-pop-options .quickchat-attach')
    assert.equal(document.querySelector('.quickchat-file')?.textContent, 'first.txt')
    let picks = 0
    input.addEventListener('click', () => { picks++; window.dispatchEvent(new window.Event('blur')) })
    await clickIn('.quickchat-add')
    assert.equal(picks, 1, 'existing add-files action still opens the native picker')
    await choose('second.txt')
    assert.equal(pops().options !== null && document.querySelector('.quickchat-pop-files') !== null, true)
    assert.deepEqual([...document.querySelectorAll('.quickchat-file')].map(el => el.textContent), ['first.txt', 'second.txt'])
    await pressOutside()
    assert.equal(pops().options === null && document.querySelector('.quickchat-pop-files') === null, true)
    assert.equal(view.el.querySelector('.quickchat-options .quickchat-count')?.textContent, '2', 'dismissal preserves files')
  } finally { await done() }
})

test('§7.3 wide empty-files action opens the existing picker without creating a dropdown', async () => {
  box.width = 900
  const { view, done } = await quick(true)
  try {
    let picks = 0
    view.el.querySelector('[data-testid="quickchat-files"]')!.addEventListener('click', () => { picks++ })
    await clickIn('.quickchat-attach')
    assert.equal(picks, 1)
    assert.equal(pops().options === null, true)
  } finally { await done() }
})
