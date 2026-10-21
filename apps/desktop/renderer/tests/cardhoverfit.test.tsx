import test from 'node:test'
import assert from 'node:assert/strict'
import { mountView, inAct, fireResize } from './harness'
import { CardFace } from '../src/canvas/cardface'
import { CardName } from '../src/canvas/cardname'
import { CardHoverCard } from './cardhoverfit-fixture'

// jsdom has no layout. Model only the measurement boundary: an absolute
// full-name overlay adds scroll overflow unless excluded during measurement.
test('fit excludes transient full-name overflow but still responds to real content', async t => {
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
