import { advance, inAct, mountView, realClock, useFakeClock } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { FirstUseGuide, beginFirstUse, beginFirstUseAt, firstUseHired, firstUseName, firstUseProgress, firstUseToken } from '../src/canvas/firstuse'

// USER 2026-10-28 me1fad212bab7: "allow the user to dismiss the initial intro 4-step intro tutorial".
// jsdom has no layout, so the guide's targets get fixed rectangles and a hit test of their own; the real
// button is exercised by the app composition probe (tests/app-firstuse-scenarios.ts).
type Box = { el: Element; left: number; top: number; width: number; height: number }
const boxes: Box[] = []
const rect = (b: Pick<Box, 'left' | 'top' | 'width' | 'height'>) => ({ ...b, x: b.left, y: b.top, right: b.left + b.width, bottom: b.top + b.height, toJSON() { return this } }) as DOMRect
function place(el: Element, left: number, top: number, width: number, height: number) {
  boxes.push({ el, left, top, width, height })
  ;(el as HTMLElement).style.opacity = '1'
  el.getBoundingClientRect = () => rect({ left, top, width, height })
  return el as HTMLElement
}

async function setup(t: test.TestContext, step: string, slug: string, start: () => void) {
  useFakeClock(); localStorage.clear(); boxes.length = 0
  Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: (x: number, y: number) =>
    [...boxes].reverse().find(b => x >= b.left && x < b.left + b.width && y >= b.top && y < b.top + b.height)?.el ?? document.body })
  document.documentElement.style.opacity = '1'; document.body.style.opacity = '1'
  // only the step's own surface, as on the canvas: the guide steers clear of every other visible control
  const host = document.createElement('div')
  host.innerHTML = step === 'token' ? '<div class="sq user"><div class="hsof"><button data-first-use="token">hire</button></div></div>'
    : step === 'message' ? '<div data-first-use-agent="lead">lead</div>'
    : '<div class="sq draft"><input class="df-name"><div class="df-foot"><button class="primary">Hire</button></div></div>'
  document.body.appendChild(host)
  place(host, 0, 0, 1000, 700)
  const at = (selector: string, ...box: [number, number, number, number]) => place(host.querySelector(selector)!, ...box)
  const target = step === 'token' ? (at('.sq.user', 540, 260, 260, 160), at('.hsof', 560, 280, 160, 80), at('[data-first-use="token"]', 600, 300, 60, 40))
    : step === 'message' ? at('[data-first-use-agent="lead"]', 400, 500, 120, 60)
    : (at('.sq.draft', 80, 260, 240, 170), at('.df-name', 100, 300, 200, 30), at('.df-foot .primary', 220, 380, 60, 30),
      host.querySelector<HTMLElement>(step === 'name' ? '.df-name' : '.df-foot .primary')!)
  start()
  // the guide is a React child of the canvas viewport, whose pointer-down starts a pan: count what reaches it
  const reached = { down: 0, menu: 0 }
  const view = await mountView(<div onPointerDown={() => { reached.down++ }} onContextMenu={() => { reached.menu++ }}>
    <FirstUseGuide slug={slug} root={{ current: host }} />
  </div>, () => null)
  t.after(async () => { await view.unmount(); host.remove(); realClock(); boxes.length = 0 })
  await advance(100)
  return { target, reached, card: () => document.querySelector<HTMLElement>('.first-use-card') }
}

const steps = {
  token: { n: 1, start: (s: string) => beginFirstUse(s) },
  name: { n: 2, start: (s: string) => { beginFirstUse(s); firstUseToken(s) } },
  hire: { n: 3, start: (s: string) => { beginFirstUse(s); firstUseToken(s); firstUseName(s, 'lead') } },
  message: { n: 4, start: (s: string) => beginFirstUseAt(s, 'lead') },
}
for (const [step, { n, start }] of Object.entries(steps)) {
  test(`the ${step} step's note carries a Dismiss button that ends the guide for good`, async t => {
    const slug = 'dismiss-note-' + step
    const c = await setup(t, step, slug, () => start(slug))
    assert.ok(c.card(), 'the step shows its note')
    assert.match(c.card()!.textContent!, new RegExp(`Getting started · ${n} of 4`))
    const button = document.querySelector<HTMLButtonElement>('.first-use-dismiss')
    assert.ok(button, 'the note has a Dismiss button')
    assert.equal(button.type, 'button')
    assert.equal(button.textContent, 'Dismiss')
    assert.match(button.getAttribute('aria-label') ?? '', /dismiss/i, 'an accessible name that says what it does')
    assert.equal(button.closest('[role="status"]')?.contains(button) ?? false, false, 'a control is not read out as part of the live note')
    assert.ok(c.target.getAttribute('aria-describedby'), 'the real control is described by the note')

    await inAct(() => { button.click() })
    await advance(50)
    assert.equal(c.card(), null, 'the note is gone')
    assert.equal(document.querySelector('.first-use-ring'), null, 'so is the ring')
    assert.equal(firstUseProgress(slug)?.step, 'done')
    assert.equal(JSON.parse(localStorage.getItem('orgtree-first-use:' + slug)!).step, 'done', 'kept for the next launch')
    assert.equal(c.target.getAttribute('aria-describedby'), null, 'the real control is no longer described by it')
  })
}

test('a dismissed guide does not come back when the real controls are used afterwards', async t => {
  const c = await setup(t, 'token', 'dismiss-then-use', () => beginFirstUse('dismiss-then-use'))
  await inAct(() => { document.querySelector<HTMLButtonElement>('.first-use-dismiss')!.click() })
  await advance(50)
  await inAct(() => { firstUseToken('dismiss-then-use'); firstUseName('dismiss-then-use', 'lead'); firstUseHired('dismiss-then-use', 'lead') })
  await advance(100)
  assert.equal(c.card(), null)
  assert.equal(firstUseProgress('dismiss-then-use')?.step, 'done')
})

test('pressing or right-clicking Dismiss does not reach the canvas, so no pan captures the pointer from the click', async t => {
  const c = await setup(t, 'token', 'dismiss-bubble', () => beginFirstUse('dismiss-bubble'))
  const button = document.querySelector<HTMLButtonElement>('.first-use-dismiss')!
  await inAct(() => {
    button.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    button.dispatchEvent(new Event('contextmenu', { bubbles: true, cancelable: true }))
  })
  assert.deepEqual(c.reached, { down: 0, menu: 0 })
  await inAct(() => { c.card()!.dispatchEvent(new Event('pointerdown', { bubbles: true })) })
  assert.equal(c.reached.down, 1, 'control: the same event on the note itself does bubble to the canvas')
})
