import test from 'node:test'
import assert from 'node:assert/strict'
import { mountView, inAct, fireResize, resizeWatchers } from './harness'
import { CardFace } from '../src/canvas/cardface'
import { CardName } from '../src/canvas/cardname'
import { CardHoverCard } from './cardhoverfit-fixture'

// jsdom has no layout. Model only the measurement boundary: an absolute
// full-name overlay adds scroll overflow unless excluded during measurement.
test('fit excludes transient full-name overflow but still responds to real content', async t => {
  const observer = Object.getOwnPropertyDescriptor(window, 'ResizeObserver')
  Object.defineProperty(window, 'ResizeObserver', { configurable: true, writable: true, value: globalThis.ResizeObserver })
  t.after(() => { if (observer) Object.defineProperty(window, 'ResizeObserver', observer); else Reflect.deleteProperty(window, 'ResizeObserver') })
  const proto = HTMLElement.prototype, saved = new Map<string, PropertyDescriptor | undefined>()
  let height = 60
  for (const key of ['clientWidth','clientHeight','offsetWidth','offsetHeight','scrollWidth','scrollHeight']) {
    saved.set(key, Object.getOwnPropertyDescriptor(proto, key))
    Object.defineProperty(proto, key, { configurable: true, get(this: HTMLElement) {
      if (this.classList.contains('name')) return key.includes('Width') ? (key === 'scrollWidth' ? 320 : 85) : 15
      if (this.classList.contains('card-face')) return key.includes('Width') ? 110 : 110
      if (this.classList.contains('card-face-inner')) {
        const overlay = this.querySelector<HTMLElement>('.name-full')
        if (key === 'scrollWidth' && overlay && overlay.style.display !== 'none') return 340
        return key.includes('Width') ? 110 : height
      }
      return saved.get(key)?.get?.call(this) ?? 0
    } })
  }
  t.after(() => { for (const [key, d] of saved) if (d) Object.defineProperty(proto, key, d); else delete (proto as unknown as Record<string, unknown>)[key] })
  const render = (hovered: boolean) => <CardFace><div className="sq-head"><div className="sq-title"><CardName text="long-name-for-fit-regression" hovered={hovered} /></div></div></CardFace>
  const v = await mountView(render(false), el => el); t.after(() => v.unmount())
  const frame = v.el.querySelector<HTMLElement>('.card-face')!
  const inner = v.el.querySelector<HTMLElement>('.card-face-inner')!
  assert.ok(resizeWatchers(inner) > 0, 'positive control: observer installed in the owning window')
  const rest = frame.dataset.cardScale
  assert.equal(rest, '1')
  await v.render(render(true))
  assert.ok(v.el.querySelector('.name-full'), 'positive control: clipped full name is revealed')
  await inAct(() => fireResize(inner))
  assert.equal(frame.dataset.cardScale, rest, 'hover does not change face magnification')
  assert.notEqual(v.el.querySelector<HTMLElement>('.name-full')!.style.display, 'none', 'measurement restores overlay visibility')
  height = 220; await inAct(() => fireResize(inner))
  assert.equal(Number(frame.dataset.cardScale), .5, 'real content growth still refits')
  await v.render(render(false)); assert.equal(Number(frame.dataset.cardScale), .5)
  height = 60; await inAct(() => fireResize(inner)); assert.equal(frame.dataset.cardScale, rest)
})

for (const kind of ['agent', 'project'] as const) test(`${kind} retired chip follows all other header chips`, async t => {
  const v = await mountView(<CardHoverCard kind={kind} lod="norm" crowded={true} />, el => el)
  t.after(() => v.unmount())
  const badges = v.el.querySelector('.sq-badges')!
  assert.ok(badges.children.length > 1, 'positive control: coloured chips and retired badge exist')
  assert.equal(badges.lastElementChild?.classList.contains('retired-token'), true)
})

// Desk-load hang (4.6.1-alpha.3): every glide frame re-renders every card, and the face measured
// (a forced synchronous layout) after EVERY render, so one camera frame cost one reflow per card over
// a DOM that had just gained a desk. CF1: only a change inside the face, or a resize, measures.
test('CF1 a re-render that changes nothing inside the face does not measure; a content change still refits', async t => {
  const proto = HTMLElement.prototype, saved = new Map<string, PropertyDescriptor | undefined>()
  let reads = 0, wide = 110
  for (const key of ['clientWidth', 'clientHeight', 'offsetWidth', 'offsetHeight', 'scrollWidth', 'scrollHeight']) {
    saved.set(key, Object.getOwnPropertyDescriptor(proto, key))
    Object.defineProperty(proto, key, { configurable: true, get(this: HTMLElement) {
      if (this.classList.contains('card-face')) return 110
      if (this.classList.contains('card-face-inner')) { if (key === 'scrollWidth') { reads++; return wide } return 110 }
      return saved.get(key)?.get?.call(this) ?? 0
    } })
  }
  t.after(() => { for (const [key, d] of saved) if (d) Object.defineProperty(proto, key, d); else delete (proto as unknown as Record<string, unknown>)[key] })
  const face = (title: string, x: number) => <div style={{ transform: `translate(${x}px, 0px)` }}><CardFace><div className="sq-title">{title}</div></CardFace></div>
  const v = await mountView(face('worker', 0), el => el); t.after(() => v.unmount())
  const frame = v.el.querySelector<HTMLElement>('.card-face')!
  assert.ok(reads > 0, 'positive control: the first render measures')
  assert.equal(frame.dataset.cardScale, '1')
  const before = reads
  for (let x = 1; x <= 30; x++) await v.render(face('worker', x))   // a glide: the card moves, its face does not change
  assert.equal(reads - before, 0, `30 camera frames measured the face ${reads - before} times`)
  wide = 220
  await v.render(face('a much longer worker title', 30))             // content grows past the face, its box does not
  assert.equal(Number(frame.dataset.cardScale), .5, 'a content change still refits')
})
