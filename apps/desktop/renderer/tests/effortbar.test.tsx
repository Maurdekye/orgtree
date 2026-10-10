// effortbar.test.tsx — the effort selector is ONE bar (user 2026-10-10: "click
// anywhere along the bar, like Claude Code's"): a press between two levels picks
// the nearest, a drag moves the pick and the release commits, pressing the
// pinned level clears it, the keys step it, and the slider says its level.
import './harness'
import { createElement, inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { EffortBar, nearestLevel } from '../src/canvas/effortbar'
import { EFFORT_LEVELS } from '../src/canvas/effortlevels'

// the track is 132 wide with an 8px inset: levels sit at 8, 40.5, 66+, … of 116 usable px
const W = 132
const x = (i: number) => 8 + (W - 16) * (i / (EFFORT_LEVELS.length - 1))

test('nearestLevel picks the level closest to the pointer', () => {
  assert.equal(nearestLevel(0), 0)
  assert.equal(nearestLevel(1), 4)
  assert.equal(nearestLevel(0.12), 0)
  assert.equal(nearestLevel(0.13), 1)
  assert.equal(nearestLevel(0.5), 2)
  assert.equal(nearestLevel(0.62), 2)
  assert.equal(nearestLevel(0.63), 3)
  assert.equal(nearestLevel(-4), 0)
  assert.equal(nearestLevel(9), 4)
  assert.equal(nearestLevel(Number.NaN), 0)
})

function mountBar(value: string, level: string, sets: string[]) {
  return mountView(createElement(EffortBar, { value, level, onSet: (l: string) => { sets.push(l) } }), (el) => el)
}

async function fire(el: Element, type: string, clientX: number) {
  await inAct(async () => {
    el.dispatchEvent(new (el.ownerDocument.defaultView as unknown as { MouseEvent: typeof MouseEvent }).MouseEvent(
      type, { bubbles: true, cancelable: true, clientX, button: 0 }))
  })
}

function track(view: { el: HTMLElement }) {
  const t = view.el.querySelector('.effort-bar-track') as HTMLElement
  t.getBoundingClientRect = () => ({ left: 0, top: 0, right: W, bottom: 24, width: W, height: 24, x: 0, y: 0, toJSON() {} }) as DOMRect
  return t
}

test('a press anywhere along the bar sets the nearest level', async () => {
  const sets: string[] = []
  const view = await mountBar('', 'medium', sets)
  const t = track(view)
  // between low and medium, nearer low
  await fire(t, 'pointerdown', x(0) + 5); await fire(t, 'pointerup', x(0) + 5)
  // well off the dots, near high
  await fire(t, 'pointerdown', x(2) + 9); await fire(t, 'pointerup', x(2) + 9)
  // past the right end
  await fire(t, 'pointerdown', W + 40); await fire(t, 'pointerup', W + 40)
  assert.deepEqual(sets, ['low', 'high', 'max'])
  await view.unmount()
})

test('a drag moves the pick live and the release commits once', async () => {
  const sets: string[] = []
  const view = await mountBar('low', 'low', sets)
  const t = track(view)
  await fire(t, 'pointerdown', x(0))
  await fire(t, 'pointermove', x(2))
  assert.equal(view.el.querySelector('.effort-bar-label')!.textContent, 'Effort (high)')
  assert.deepEqual(sets, [])
  await fire(t, 'pointerup', x(3))
  assert.deepEqual(sets, ['xhigh'])
  await view.unmount()
})

test('pressing and releasing on the pinned level clears it back to inherit', async () => {
  const sets: string[] = []
  const view = await mountBar('high', 'high', sets)
  const t = track(view)
  await fire(t, 'pointerdown', x(2) + 3); await fire(t, 'pointerup', x(2) + 3)
  assert.deepEqual(sets, [''])
  await view.unmount()
})

test('the keys step the level and the slider names it', async () => {
  const sets: string[] = []
  const view = await mountBar('medium', 'medium', sets)
  const t = track(view)
  assert.equal(t.getAttribute('role'), 'slider')
  assert.equal(t.getAttribute('aria-valuetext'), 'medium')
  assert.equal(t.getAttribute('aria-valuenow'), '1')
  for (const key of ['ArrowRight', 'ArrowLeft', 'End', 'Home']) {
    await inAct(async () => { t.dispatchEvent(new (t.ownerDocument.defaultView as unknown as { KeyboardEvent: typeof KeyboardEvent }).KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })) })
  }
  assert.deepEqual(sets, ['high', 'low', 'max', 'low'])
  await view.unmount()
})
