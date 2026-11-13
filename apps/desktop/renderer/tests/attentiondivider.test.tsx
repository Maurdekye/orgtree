// attentiondivider.test.tsx — THE ATTENTION DIVIDER HIDES A PANEL AND SWAPS THEM.
//
// USER 2026-11-13 m525fd3e66e99: "let me drag the divider for one of the
// attention panels all the way to the side. in doing so, hide the panel that's
// shrunk to zero, and add a little button on the divider that when clicked,
// swaps the two windows visibly." The eight points below are the ones the user
// approved on 2026-11-13 (m2672b93c2df8, "Yes to all"):
//
//   1  with one panel hidden, Swap trades places: the hidden one shows, the
//      visible one hides, the divider stays; a second click goes back
//   2  with both shown, Swap trades places and the divider stays where it is
//   3  the button is always shown on the divider, "Swap panels"; the
//      right-click entry stays
//   4  a drag stops at a panel's 20% minimum; on past half of that (within 10%
//      of the edge) the panel snaps hidden; dragging back restores it at its
//      minimum. Arrow keys go past the minimum to hide; Home/End hide
//      left/right
//   5  hidden and swapped are saved per organization
//   6  a slide of about 150 ms on swap, none while dragging, none under
//      reduced motion
//   8  the empty slot of a pinned or popped-out panel can be hidden the same way
//
// The hidden side is stored as a SIDE of the stage ('left' | 'right'), which is
// what makes point 1 one field flipping: the divider does not move, the panels
// trade places across it.
//
// Run:  node apps/desktop/renderer/tests/run.mjs attentiondivider

import './harness'
import { compatibilityWorkFixture } from './workcompat.fixture'
import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import type { CanvasNode, OpFn } from '../src/canvas/shared'
import { USER } from '../src/canvas/shared'
import type { TreePayload } from '../src/types'
import { forgetModalPins, pinModal, unpinModal } from '../src/canvas/modalpin'
import { CurrentOrg } from '../src/popout'
import { registerWindow } from '../src/windowlife'
import {
  ATTENTION_LAYOUT_KEY, attentionLayout, forgetAttentionMode, setAttentionLayout, setOrgView,
} from '../src/attention/mode'
import { AttentionView, DESK_KIND, QUEUE_KIND } from '../src/attention/AttentionView'

const SLUG = 'org1'

const tree = (): TreePayload => ({
  slug: SLUG, name: 'Org 1', epoch: 1, rev: 1, roots: [],
  work_items_summary: { attention: 0, active: 0 },
  user_inbox_count: 0, user_inbox_urgent_count: 0, asks: [], asks_open: 0,
} as unknown as TreePayload)

const emptyMap = (): Map<string, CanvasNode> => new Map([[USER, {
  id: USER, parent: null, tier: null, state: 'user', children: [],
} as unknown as CanvasNode]])

const op: OpFn = () => Promise.resolve({ ok: true } as never)
const toast = () => {}

function installQuietServer() {
  ;(globalThis as unknown as { fetch: unknown }).fetch = compatibilityWorkFixture(((url: string) => {
    const path = new URL(String(url), 'http://localhost').pathname
    const body = /\/work-items(?:-view)?$/.test(path)
      ? { items: [], attention: [], active: [], archived: [], backlogged: [],
          counts: { attention: 0, active: 0, archived: 0, backlogged: 0 } }
      : /\/inbox$/.test(path)
        ? { pending: [], delivered: [], sent: [] }
        : { ok: true }
    return Promise.resolve({
      ok: true, status: 200, headers: new Headers(),
      json: () => Promise.resolve(body),
    })
  }) as never)
}

const reset = () => {
  localStorage.clear()
  forgetAttentionMode()
  forgetModalPins()
  installQuietServer()
}

const view = () => <CurrentOrg.Provider value={SLUG}>
  <AttentionView slug={SLUG} tree={tree()} op={op} toast={toast} map={emptyMap()}
    attentionDeskActiveAgentsOnly={false} />
</CurrentOrg.Provider>

const q = (sel: string) => document.querySelector(sel) as HTMLElement | null
const slotHidden = (sel: string) => {
  const el = q(sel)
  return !!el && el.classList.contains('attn-slot-hidden') && el.hasAttribute('inert')
}
/** what the user can see of the two panels, and what is remembered */
const seen = () => ({
  queue: !slotHidden('.attn-slot-queue'),
  desk: !slotHidden('.attn-slot-desk'),
  hidden: (attentionLayout(SLUG) as unknown as { hidden?: unknown }).hidden ?? null,
  swapped: attentionLayout(SLUG).swapped,
  split: attentionLayout(SLUG).split,
})
const near = (a: number, b: number) => Math.abs(a - b) < 1e-9

/** a mounted view whose stage is 1000px wide, with a pointer on its divider */
async function mounted(t: { after: (fn: () => void | Promise<void>) => void }) {
  setOrgView(SLUG, 'attention')
  const v = await mountView(view(), () => null)
  t.after(() => v.unmount())
  await inAct(() => flush())
  const stage = q('.attn-stage')!
  stage.getBoundingClientRect = () => ({
    left: 0, top: 0, right: 1000, bottom: 800, width: 1000, height: 800, x: 0, y: 0,
    toJSON: () => ({}),
  }) as DOMRect
  const point = (type: string, clientX: number, selector = '.attn-divider') => inAct(() => {
    const divider = q(selector)!
    divider.setPointerCapture = () => {}
    divider.releasePointerCapture = () => {}
    const e = new window.MouseEvent(type, { bubbles: true, clientX, button: 0 })
    Object.defineProperty(e, 'pointerId', { value: 1 })
    divider.dispatchEvent(e)
  })
  const drag = async (from: number, to: number) => {
    await point('pointerdown', from); await point('pointermove', to); await point('pointerup', to)
  }
  const press = (key: string, shiftKey = false) => inAct(() => {
    q('.attn-divider')!.dispatchEvent(new window.KeyboardEvent('keydown', { key, shiftKey, bubbles: true }))
  })
  const swap = () => inAct(() => { q('button.attn-swap')!.click() })
  return { v, point, drag, press, swap }
}

// --------------------------------------------------------------- 4: dragging
test('a drag stops at the 20% minimum, and on past 10% of the edge the panel snaps hidden', async (t) => {
  reset()
  const { point } = await mounted(t)
  await point('pointerdown', 380)
  await point('pointermove', 150)
  assert.deepEqual([seen().queue, seen().desk], [true, true],
    'between 10% and 20% the panel is still there, at its minimum')
  assert.equal(q('.attn-slot-queue')!.style.flexBasis, '20.00%')

  await point('pointermove', 60)
  assert.equal(seen().queue, false, 'within 10% of the edge the left panel is hidden while the drag is live')
  assert.equal(seen().desk, true)
  assert.equal(seen().hidden, null, 'nothing is stored mid-drag')

  await point('pointerup', 60)
  assert.equal(seen().hidden, 'left', 'and the hidden side is what is remembered')
  assert.equal(seen().queue, false)
  assert.ok(near(seen().split, 0.2), 'kept at its minimum for when it comes back')
  assert.ok(q('.attn-divider'), 'the divider is still there to bring it back')
  assert.ok(q('.attn-panel-queue'), 'the hidden panel stays mounted')
})

test('dragging to the right edge hides the right panel and the left one takes the stage', async (t) => {
  reset()
  const { drag } = await mounted(t)
  await drag(380, 960)
  assert.deepEqual([seen().queue, seen().desk, seen().hidden], [true, false, 'right'])
  assert.ok(near(seen().split, 0.8))
  assert.equal(q('.attn-slot-queue')!.style.flexGrow, '1', 'the remaining panel fills the stage')
  const divider = q('.attn-divider')!
  assert.equal(Number(divider.getAttribute('aria-valuenow')), 100)
  assert.equal(divider.getAttribute('aria-valuetext'), 'Agent desk hidden')
})

test('dragging back in from the edge restores the hidden panel at its minimum', async (t) => {
  reset()
  const { drag, point } = await mounted(t)
  await drag(380, 20)
  assert.equal(seen().hidden, 'left')
  assert.equal(q('.attn-divider')!.getAttribute('aria-valuetext'), 'Needs attention hidden')
  assert.equal(Number(q('.attn-divider')!.getAttribute('aria-valuenow')), 0)

  await point('pointerdown', 3)
  await point('pointermove', 40)
  assert.equal(seen().queue, false, 'still within 10% of the edge: still hidden')
  await point('pointermove', 130)
  assert.equal(seen().queue, true, 'past 10% it is back while the drag is live')
  await point('pointerup', 130)
  assert.deepEqual([seen().hidden, seen().queue, seen().desk], [null, true, true])
  assert.ok(near(seen().split, 0.2), 'at its 20% minimum')
  assert.equal(q('.attn-divider')!.getAttribute('aria-valuetext'), null)
})

test('a press on the divider without a move changes nothing', async (t) => {
  reset()
  setAttentionLayout(SLUG, { split: 0.2, hidden: 'left' } as never)
  const { point } = await mounted(t)
  await point('pointerdown', 3)
  await point('pointerup', 3)
  assert.equal(seen().hidden, 'left')
})

// USER 2026-11-13 mb445dc041229: a drag starting on Swap panels resizes.
test('dragging from the Swap panels button moves the divider without swapping', async (t) => {
  reset()
  const { point, swap } = await mounted(t)
  await point('pointerdown', 380, '.attn-swap')
  await point('pointermove', 300, '.attn-swap')
  await point('pointerup', 300, '.attn-swap')
  await swap() // the browser's click following pointerup must be suppressed
  assert.equal(Number(q('.attn-divider')!.getAttribute('aria-valuenow')), 30)
  assert.ok(near(seen().split, 0.3))
  assert.equal(seen().swapped, false)
})

test('dragging from the Swap panels button within 10% of the edge hides the left panel', async (t) => {
  reset()
  const { point, swap } = await mounted(t)
  await point('pointerdown', 380, '.attn-swap')
  await point('pointermove', 60, '.attn-swap')
  await point('pointerup', 60, '.attn-swap')
  await swap()
  assert.deepEqual([seen().hidden, seen().queue, seen().desk], ['left', false, true])
  assert.equal(Number(q('.attn-divider')!.getAttribute('aria-valuenow')), 0)
  assert.equal(seen().swapped, false)
})

test('a 2px move on the Swap panels button still clicks without moving the divider', async (t) => {
  reset()
  const { point, swap } = await mounted(t)
  await point('pointerdown', 380, '.attn-swap')
  await point('pointermove', 382, '.attn-swap')
  await point('pointerup', 382, '.attn-swap')
  await swap()
  assert.equal(seen().swapped, true)
  assert.equal(Number(q('.attn-divider')!.getAttribute('aria-valuenow')), 62)
  assert.ok(near(seen().split, 0.62), 'swap preserves the physical divider position')
})

// --------------------------------------------------------------- 4: keyboard
test('arrow keys go past the minimum to hide, and come back at the minimum', async (t) => {
  reset()
  setAttentionLayout(SLUG, { split: 0.21 })
  const { press } = await mounted(t)
  await press('ArrowLeft')
  assert.ok(near(seen().split, 0.2), 'first the minimum')
  assert.equal(seen().hidden, null)
  await press('ArrowLeft')
  assert.deepEqual([seen().hidden, seen().queue], ['left', false], 'then hidden')
  await press('ArrowLeft')
  assert.equal(seen().hidden, 'left', 'and nothing further that way')
  await press('ArrowRight')
  assert.deepEqual([seen().hidden, seen().queue], [null, true], 'the other arrow brings it back')
  assert.ok(near(seen().split, 0.2), 'at its minimum')
})

test('Home hides the left panel and End hides the right one, whichever panel is there', async (t) => {
  reset()
  const { press } = await mounted(t)
  await press('End')
  assert.deepEqual([seen().hidden, seen().queue, seen().desk], ['right', true, false])
  await press('ArrowRight')
  assert.equal(seen().hidden, 'right', 'nothing further that way')
  await press('ArrowLeft')
  assert.deepEqual([seen().hidden, seen().desk], [null, true])
  assert.ok(near(seen().split, 0.8), 'back at its 20% minimum')
  await press('Home')
  assert.deepEqual([seen().hidden, seen().queue, seen().desk], ['left', false, true])

  // swapped: Home still means the LEFT side, which now holds the Agent desk
  await inAct(() => { setAttentionLayout(SLUG, { hidden: null, swapped: true, split: 0.5 } as never) })
  await press('Home')
  assert.deepEqual([seen().hidden, seen().queue, seen().desk], ['left', true, false])
})

// ------------------------------------------------------------- 3: the button
test('the divider carries a Swap panels button, outside the separator itself', async (t) => {
  reset()
  await mounted(t)
  const button = q('button.attn-swap')
  assert.ok(button, 'the button is shown with both panels in view')
  assert.equal(button!.getAttribute('aria-label'), 'Swap panels')
  assert.equal(button!.getAttribute('title'), 'Swap panels')
  assert.equal(button!.closest('[role="separator"]'), null,
    'a separator hides its children from assistive technology, so the button is not inside it')
  assert.ok(button!.querySelector('svg'), 'drawn with an icon, not a letter')
})

test('with both panels shown, the button trades their places and the divider stays put', async (t) => {
  reset()
  setAttentionLayout(SLUG, { split: 0.3 })
  const { swap } = await mounted(t)
  assert.equal(q('.attn-slot-queue')!.style.flexBasis, '30.00%')
  await swap()
  assert.deepEqual([seen().swapped, seen().hidden], [true, null])
  assert.ok(near(seen().split, 0.7), 'the queue now has the right-hand share')
  assert.equal(q('.attn-slot-desk')!.style.flexBasis, '30.00%', 'the left area is as wide as before')
  assert.equal(q('.attn-slot-desk')!.style.order, '1', 'and the Agent desk is now in it')
  await swap()
  assert.deepEqual([seen().swapped, near(seen().split, 0.3)], [false, true], 'a second click goes back')
})

// ------------------------------------------------------ 1: swap while hidden
test('with one panel hidden, the button shows the hidden one and hides the other; again goes back', async (t) => {
  reset()
  const { drag, swap } = await mounted(t)
  await drag(380, 20)
  assert.deepEqual([seen().queue, seen().desk], [false, true])
  await swap()
  assert.deepEqual([seen().queue, seen().desk], [true, false], 'the hidden panel is now the one in view')
  assert.equal(seen().hidden, 'left', 'the divider did not change sides')
  assert.equal(seen().swapped, true)
  assert.ok(q('button.attn-swap'), 'and the button is still there')
  await swap()
  assert.deepEqual([seen().queue, seen().desk, seen().swapped], [false, true, false])
})

test('the right-click Swap panels entry does the same as the button', async (t) => {
  reset()
  const { drag } = await mounted(t)
  await drag(380, 990)
  assert.deepEqual([seen().queue, seen().desk], [true, false])
  await inAct(() => { q('.attn-divider')!.dispatchEvent(new window.MouseEvent('contextmenu',
    { bubbles: true, cancelable: true, button: 2, clientX: 40, clientY: 30 })) })
  await inAct(() => flush(3))
  const entries = [...document.querySelectorAll<HTMLElement>('.ctxmenu button')]
  assert.deepEqual(entries.map((b) => b.textContent?.trim()), ['Swap panels'])
  await inAct(() => { entries[0]!.click() })
  await inAct(() => flush(3))
  assert.deepEqual([seen().queue, seen().desk, seen().hidden], [false, true, 'right'])
})

// ------------------------------------------------------------ 5: persistence
test('hidden and swapped are remembered per organization and survive a reload', async (t) => {
  reset()
  const { drag, swap, v } = await mounted(t)
  await drag(380, 20)
  await swap()
  const stored = JSON.parse(localStorage.getItem(ATTENTION_LAYOUT_KEY) ?? '{}')
  assert.equal(stored[SLUG].hidden, 'left')
  assert.equal(stored[SLUG].swapped, true)
  assert.equal((attentionLayout('other-org') as unknown as { hidden?: unknown }).hidden ?? null, null,
    'another organization is untouched')

  await v.unmount()
  forgetAttentionMode()                      // a fresh read from storage, as after a restart
  const again = await mountView(view(), () => null)
  t.after(() => again.unmount())
  await inAct(() => flush())
  assert.deepEqual([seen().queue, seen().desk, seen().hidden, seen().swapped], [true, false, 'left', true])

  // garbage in storage reads as nothing hidden
  localStorage.setItem(ATTENTION_LAYOUT_KEY, JSON.stringify({ [SLUG]: { split: 0.4, hidden: 'top' } }))
  await inAct(() => { forgetAttentionMode() })
  assert.deepEqual([seen().queue, seen().desk, seen().hidden], [true, true, null])
})

// -------------------------------------------------------------- 6: the slide
test('a swap slides for about 150 ms; a drag does not; reduced motion gets none', async (t) => {
  reset()
  const { drag, swap } = await mounted(t)
  const calls: Array<{ slot: string; ms: number }> = []
  const slots = () => calls.map((c) => c.slot).sort()
  const times = () => calls.map((c) => c.ms)
  const proto = window.HTMLElement.prototype as unknown as { animate?: unknown }
  const oldAnimate = proto.animate
  const oldRect = window.HTMLElement.prototype.getBoundingClientRect
  const oldMedia = window.matchMedia
  t.after(() => {
    proto.animate = oldAnimate
    window.HTMLElement.prototype.getBoundingClientRect = oldRect
    ;(window as unknown as { matchMedia: unknown }).matchMedia = oldMedia
  })
  proto.animate = function (this: HTMLElement, _frames: unknown, options: { duration?: number } | number) {
    calls.push({
      slot: this.classList.contains('attn-slot-queue') ? 'queue' : this.classList.contains('attn-slot-desk') ? 'desk' : '?',
      ms: typeof options === 'number' ? options : options.duration ?? 0,
    })
    return {}
  }
  // jsdom lays nothing out: place each slot by its flex order, so the two
  // really do change places when they swap
  window.HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
    if (!this.classList.contains('attn-slot')) return oldRect.call(this)
    const left = this.style.order === '1' ? 0 : 400
    return { left, top: 0, right: left + 400, bottom: 800, width: 400, height: 800, x: left, y: 0,
      toJSON: () => ({}) } as DOMRect
  }
  const reduced = { on: false }
  ;(window as unknown as { matchMedia: unknown }).matchMedia = (query: string) => ({
    matches: reduced.on && /prefers-reduced-motion/.test(query), media: query,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
  })

  await drag(380, 600)
  assert.deepEqual(slots(), [], 'a drag is direct manipulation: nothing slides')

  await swap()
  assert.deepEqual(slots(), ['desk', 'queue'], 'both panels slide to their new places')
  assert.ok(times().every((ms) => ms >= 120 && ms <= 200), 'for about 150 ms')

  calls.length = 0
  await drag(600, 20)                          // hide one, then swap: the slide still runs
  await swap()
  assert.deepEqual(slots(), ['desk', 'queue'])

  calls.length = 0
  reduced.on = true
  await swap()
  assert.deepEqual(slots(), [], 'reduced motion: the panels just change places')
})

// --------------------------------------------- the hidden desk and the registry
test('a hidden Agent desk is not a visible destination for the desk registry', async (t) => {
  reset()
  const { drag, swap } = await mounted(t)
  const eligible = () => q('.attn-desk')?.getAttribute('data-attn-desk-eligible') ?? null
  assert.equal(eligible(), 'yes')
  await drag(380, 990)
  assert.equal(seen().desk, false)
  assert.equal(eligible(), 'no', 'a desk nobody can see must not hold an agent away from a visible one')
  await swap()
  assert.equal(eligible(), 'yes', 'in view again, it is a destination again')
})

// ------------------------------------------------- asking for the hidden panel
test('choosing an agent brings a hidden Agent desk back, at its minimum', async (t) => {
  reset()
  const { drag } = await mounted(t)
  await drag(380, 990)
  assert.deepEqual([seen().desk, seen().hidden], [false, 'right'])
  // the one write every agent link, mention row and focus action ends in
  await inAct(() => { setAttentionLayout(SLUG, { agent: 'scout' }) })
  await inAct(() => flush())
  assert.deepEqual([seen().desk, seen().queue, seen().hidden], [true, true, null])
  assert.ok(near(seen().split, 0.8), 'the desk comes back at its 20% minimum')

  // a hidden Needs attention panel is not what an agent link asks for
  await drag(800, 10)
  assert.equal(seen().hidden, 'left')
  await inAct(() => { setAttentionLayout(SLUG, { agent: 'other' }) })
  await inAct(() => flush())
  assert.equal(seen().hidden, 'left', 'the desk is already in view; the queue stays hidden')
})

// ------------------------------------------- 8: pinned and popped-out panels
for (const away of ['pin', 'popout'] as const) {
  test(`the empty slot of a ${away === 'pin' ? 'pinned' : 'popped-out'} Agent desk can be hidden, and comes back with the panel`, async (t) => {
    reset()
    const { drag } = await mounted(t)
    let back: () => void = () => {}
    await inAct(() => {
      if (away === 'pin') {
        pinModal(DESK_KIND, { x: 20, y: 20, w: 400, h: 500 }, SLUG)
        back = () => unpinModal(DESK_KIND, SLUG)
      } else {
        back = registerWindow({ id: 'divider-desk', kind: DESK_KIND, org: SLUG,
          editable: false, window: globalThis.window, redock: () => {} })
      }
    })
    await inAct(() => flush())
    assert.ok(q('.attn-divider'), 'the queue is still embedded, so the divider is there')
    assert.ok(q('button.attn-swap'))

    await drag(380, 990)
    assert.deepEqual([seen().hidden, seen().queue, seen().desk], ['right', true, false])
    assert.equal(q('.attn-slot-queue')!.style.flexGrow, '1', 'the queue takes the whole stage')

    // choosing an agent goes to the window the desk lives in: the empty slot stays hidden
    await inAct(() => { setAttentionLayout(SLUG, { agent: 'scout' }) })
    await inAct(() => flush())
    assert.equal(seen().hidden, 'right')

    // the panel coming home is a request to see it here
    await inAct(() => { back() })
    await inAct(() => flush())
    assert.deepEqual([seen().hidden, seen().desk], [null, true],
      'a panel returned to a hidden slot would be invisible; the slot comes back with it')
  })
}

test('with both panels pinned there is no divider and no button; the hidden side is kept', async (t) => {
  reset()
  const { drag } = await mounted(t)
  await drag(380, 20)
  await inAct(() => {
    pinModal(QUEUE_KIND, { x: 20, y: 20, w: 400, h: 500 }, SLUG)
    pinModal(DESK_KIND, { x: 440, y: 20, w: 400, h: 500 }, SLUG)
  })
  await inAct(() => flush())
  assert.equal(q('.attn-divider'), null)
  assert.equal(q('button.attn-swap'), null)
  await inAct(() => { unpinModal(DESK_KIND, SLUG) })
  await inAct(() => flush())
  assert.equal(seen().hidden, 'left', 'the desk came back to the visible side: nothing to reveal')
  assert.deepEqual([seen().queue, seen().desk], [false, true])
})
