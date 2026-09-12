// popoutaspect.test.tsx — a popped-out window should open roughly the shape
// of the surface it came from.
//
// User 2026-09-12: popouts opened at one fixed 900x760 whatever was inside
// them, so content laid out for a tall narrow panel or a wide one arrived
// into proportions it was never built for.
//
// TWO SEPARATE CLAIMS, TESTED SEPARATELY.
//   §1-§5  the ARITHMETIC (`popupSize`/`popupFeatures`): shape follows the
//          source, area does not, persistence still wins, the screen is a
//          hard limit, and fitting to it never distorts.
//   §6     the WIRING: a real PinFrame really hands its own panel's box to
//          the window opener - and a different panel produces a different
//          window, which is the part that would silently rot if the prop
//          were dropped.
//
// ⚠ WHAT jsdom CANNOT DO. It performs no layout, so every box here is one
// this file installs on purpose. That makes §6 a test of the WIRING, not of
// the real measured geometry: it shows the number the opener receives is the
// panel's, whatever the panel's number happens to be. The arithmetic that
// turns it into a window is §1-§5, which needs no layout at all.
//
// Run:  cd apps/desktop/renderer && node tests/run.mjs popoutaspect

import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import type { ReactNode } from 'react'
import { forgetModalOpenCache, forgetModalPins, isModalPinned, PinFrame } from '../src/canvas/modalpin'
import { CurrentOrg } from '../src/popout'
import { POPUP_DEFAULT, popupFeatures, popupSize, WINDOW_LAYOUT_KEY } from '../src/windowlayout'

const noop = () => {}
const AREA = POPUP_DEFAULT.width * POPUP_DEFAULT.height
const ROOM = { width: 10000, height: 10000 }   // never the binding constraint
const ratio = (s: { width: number; height: number }) => s.width / s.height

test('§1 the window takes the surface\'s shape, and keeps the old size', () => {
  const wide = popupSize({ w: 1200, h: 400 }, ROOM)      // 3:1
  const tall = popupSize({ w: 400, h: 1200 }, ROOM)      // 1:3
  const square = popupSize({ w: 500, h: 500 }, ROOM)

  assert.ok(Math.abs(ratio(wide) - 3) < 0.01, `a 3:1 surface must open 3:1, got ${ratio(wide)}`)
  assert.ok(Math.abs(ratio(tall) - 1 / 3) < 0.01, `a 1:3 surface must open 1:3, got ${ratio(tall)}`)
  assert.ok(Math.abs(ratio(square) - 1) < 0.01, `a square surface must open square, got ${ratio(square)}`)

  // …and none of them is bigger or smaller overall than the single fixed
  // size that used to be the only answer
  for (const [size, what] of [[wide, 'wide'], [tall, 'tall'], [square, 'square']] as const) {
    const area = size.width * size.height
    assert.ok(Math.abs(area - AREA) / AREA < 0.02,
      `the ${what} window must keep the old area (${area} vs ${AREA})`)
  }

  // the whole point, stated as one comparison: these are not the same window
  assert.notEqual(wide.width, tall.width)
  assert.ok(wide.width > tall.width && tall.height > wide.height)
})

test('§2 no usable source falls back to exactly what it always was', () => {
  for (const source of [null, undefined, { w: 0, h: 400 }, { w: 400, h: 0 },
    { w: -5, h: 10 }, { w: NaN, h: 10 }, { w: Infinity, h: 10 }]) {
    assert.deepEqual(popupSize(source as never, ROOM), POPUP_DEFAULT,
      `a source of ${JSON.stringify(source)} must not invent a shape`)
  }
})

test('§3 a window that has been opened before keeps where the user left it', () => {
  // PERSISTENCE MUST WIN. Matching the source is only for a first opening;
  // a saved rect is the user's own placement and outranks it.
  const key = JSON.stringify(['org', 'usage'])
  localStorage.setItem(WINDOW_LAYOUT_KEY, JSON.stringify([{ key, kind: 'usage', org: 'org',
    open: true, rect: { x: 11, y: 22, width: 333, height: 444 } }]))
  try {
    const features = popupFeatures(key, { w: 1200, h: 400 })
    assert.match(features, /left=11,top=22,width=333,height=444/,
      'the saved rect must be used unchanged, however differently shaped the surface is')
    // POSITIVE CONTROL: the same source, with nothing saved, does follow the shape
    const fresh = popupFeatures(JSON.stringify(['org', 'never-opened']), { w: 1200, h: 400 })
    assert.doesNotMatch(fresh, /width=900,height=760/,
      'and with nothing saved it must NOT fall back to the fixed default')
  } finally { localStorage.clear() }
})

test('§4 the screen is a hard limit, and fitting to it does not distort', () => {
  const small = { width: 800, height: 600 }
  const size = popupSize({ w: 1200, h: 400 }, small)
  assert.ok(size.width <= small.width && size.height <= small.height,
    `a window must fit the screen (${size.width}x${size.height} in ${small.width}x${small.height})`)
  assert.ok(Math.abs(ratio(size) - 3) < 0.01,
    `fitting must scale both sides equally, so the shape survives (${ratio(size)})`)
  // it really was the screen that bound it, not the area
  assert.ok(size.width * size.height < AREA, 'a screen-bound window is smaller than the budget')
})

test('§5 never smaller than a size that could be saved', () => {
  // `valid()` in windowlayout refuses to persist below 200x150, so opening
  // below it would produce a window that cannot survive a restart.
  const sliver = popupSize({ w: 4000, h: 1 }, { width: 1000, height: 800 })
  assert.ok(sliver.width >= 200 && sliver.height >= 150,
    `even an absurd source must stay openable (${sliver.width}x${sliver.height})`)
})

/** a real PinFrame, with the canvas boxes its pin clamp measures */
async function mountPanel(panelBox: { w: number; h: number },
  tail: { unmount: () => Promise<void> }[]) {
  const canvases = ['alpha'].map(o => {
    const el = document.createElement('div'); el.dataset.pinOrg = o
    el.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0,
      width: window.innerWidth, height: window.innerHeight,
      right: window.innerWidth, bottom: window.innerHeight, toJSON() {} }) as DOMRect
    document.body.appendChild(el); return el
  })
  const node: ReactNode = (
    <CurrentOrg.Provider value="alpha">
      <PinFrame kind="usage" title="usage limits" panel="settings usage-modal" close={noop}>
        <h3>usage limits</h3>
      </PinFrame>
    </CurrentOrg.Provider>
  )
  const v = await mountView(node, (el) => el)
  tail.push({ unmount: async () => { await v.unmount(); canvases.forEach(el => el.remove()) } })
  await flush()
  const panel = document.querySelector('.usage-modal') as HTMLElement | null
  assert.ok(panel, 'the panel must be on screen to be measured')
  // jsdom lays nothing out; this is the box under test, installed on purpose
  panel.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0,
    width: panelBox.w, height: panelBox.h, right: panelBox.w, bottom: panelBox.h,
    toJSON() {} }) as DOMRect
  return { panel }
}

test('§6 the opener really receives THIS panel\'s box, not a constant', async (t) => {
  const tail: { unmount: () => Promise<void> }[] = []
  const realOpen = window.open
  const asked: string[] = []
  // Returning null is deliberate: MovableSurface treats a blocked window as a
  // handled failure and returns the surface home, and the features string -
  // the only thing under test - has already been handed over by then.
  window.open = ((_url?: unknown, _name?: unknown, features?: unknown) => {
    asked.push(String(features ?? '')); return null
  }) as typeof window.open
  t.after(async () => {
    window.open = realOpen
    for (const x of tail.reverse()) await x.unmount()
    localStorage.clear(); forgetModalPins(); forgetModalOpenCache()
  })

  const widths: number[] = []
  for (const box of [{ w: 1200, h: 400 }, { w: 400, h: 1200 }]) {
    localStorage.clear(); forgetModalPins(); forgetModalOpenCache()
    asked.length = 0
    const { panel } = await mountPanel(box, tail)
    const popout = panel.closest('*')?.ownerDocument
      .querySelector('[aria-label="Open in new window"]') as HTMLElement | null
    assert.ok(popout, 'the panel must offer a pop-out control at all')
    await inAct(() => { popout.click() })
    await flush()
    assert.equal(asked.length, 1, 'exactly one window should have been asked for')
    const width = Number(/width=(\d+)/.exec(asked[0]!)?.[1])
    const height = Number(/height=(\d+)/.exec(asked[0]!)?.[1])
    assert.ok(width > 0 && height > 0, `the features must carry a size: ${asked[0]}`)
    assert.ok(Math.abs(width / height - box.w / box.h) < 0.05,
      `the window asked for must match the panel it came from `
      + `(panel ${box.w}x${box.h}, window ${width}x${height})`)
    widths.push(width)
  }

  // THE CONTROL FOR THIS SECTION. Every assertion above would also hold if
  // the opener ignored the panel and the two boxes happened to agree; these
  // two do not, so the numbers must differ.
  assert.ok(widths[0]! > widths[1]!,
    `a wide panel must ask for a wider window than a tall one (${widths.join(' vs ')})`)
})

test('§7 a PINNED surface pops out at the box the user dragged it to', async (t) => {
  // THE OTHER ORIGIN the brief names. A centred modal's box is its laid-out
  // default (§6); a pinned one's box is wherever the user put it, and that is
  // what its popout must match. Same measurement, different branch of
  // PinFrameInner - so this is what fails if pinned surfaces are ever
  // special-cased back onto a fixed size.
  const tail: { unmount: () => Promise<void> }[] = []
  const realOpen = window.open
  const asked: string[] = []
  window.open = ((_url?: unknown, _name?: unknown, features?: unknown) => {
    asked.push(String(features ?? '')); return null
  }) as typeof window.open
  t.after(async () => {
    window.open = realOpen
    for (const x of tail.reverse()) await x.unmount()
    localStorage.clear(); forgetModalPins(); forgetModalOpenCache()
  })
  localStorage.clear(); forgetModalPins(); forgetModalOpenCache()

  // start it centred at one shape, then pin it and give it a very different one
  await mountPanel({ w: 600, h: 600 }, tail)
  const pin = document.querySelector('[aria-label="pin this to the window"]') as HTMLElement | null
  assert.ok(pin, 'the panel must offer a pin control at all')
  await inAct(() => { pin.click() })
  await flush()
  assert.ok(isModalPinned('usage', 'alpha'), 'POSITIVE CONTROL: it really is pinned now')

  // the pinned window's box, which is what a pinned popout must follow
  const pinned = document.querySelector('.usage-modal') as HTMLElement | null
  assert.ok(pinned, 'the pinned panel is still on screen')
  pinned.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0,
    width: 960, height: 320, right: 960, bottom: 320, toJSON() {} }) as DOMRect

  asked.length = 0
  const popout = document.querySelector('[aria-label="Open in new window"]') as HTMLElement | null
  assert.ok(popout, 'a pinned window must still offer a pop-out control')
  await inAct(() => { popout.click() })
  await flush()
  assert.equal(asked.length, 1, 'exactly one window should have been asked for')
  const width = Number(/width=(\d+)/.exec(asked[0]!)?.[1])
  const height = Number(/height=(\d+)/.exec(asked[0]!)?.[1])
  assert.ok(Math.abs(width / height - 3) < 0.05,
    `a 960x320 pinned window must pop out 3:1, got ${width}x${height}`)
  assert.notEqual(width, POPUP_DEFAULT.width,
    'and must not have fallen back to the fixed default')
})
