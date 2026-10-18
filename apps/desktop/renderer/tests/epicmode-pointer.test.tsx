import { JSDOM } from './harness'
import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { Stage } from '../src/epic/stage'

function fixture(t: TestContext, doc = document) {
  const view = doc.defaultView!
  let now = 0
  t.mock.method(performance, 'now', () => now)
  Object.defineProperty(doc, 'visibilityState', { configurable: true, value: 'visible' })
  const played: { cancelled: boolean; frames: Keyframe[] }[] = []
  t.mock.method(view.HTMLCanvasElement.prototype, 'getContext', () => null)
  const root = doc.createElement('div')
  root.style.overflow = 'auto'
  doc.body.append(root)
  Object.defineProperty(root, 'animate', { configurable: true, value: (frames: Keyframe[]) => {
    const record = { frames, cancelled: false }
    played.push(record)
    const animation = { onfinish: null as null | (() => void), oncancel: null as null | (() => void),
      cancel() { record.cancelled = true; animation.oncancel?.() } }
    return animation
  } })
  const stage = new Stage(doc, () => root)
  const move = (target: Element, type = 'pointermove') => target.dispatchEvent(
    new view.MouseEvent(type, { bubbles: true, clientX: 200, clientY: 180 }))
  t.after(() => { stage.destroy(); root.remove() })
  return { stage, root, played, move, clock: (ms: number) => { now = ms } }
}

test('an approaching pointer stops a running shake before it reaches a watchdog chip', t => {
  const f = fixture(t)
  f.stage.shake(20, 900)
  assert.equal(f.played.length, 1, 'positive control: the window still shakes elsewhere')
  f.move(f.root)
  assert.equal(f.played[0]!.cancelled, true)
  assert.equal(f.root.style.overflow, 'auto', 'ending the shake restores its temporary clipping')
  f.clock(200)
  f.stage.shake(20, 900)
  assert.equal(f.played.length, 1, 'the pointer gets a settling interval before motion resumes')
  f.clock(300)
  f.stage.shake(20, 900)
  assert.equal(f.played.length, 2, 'motion resumes after settling away from controls')
})

test('a stationary pointer on a watchdog descendant keeps new shakes from moving its click target', t => {
  const f = fixture(t)
  f.root.innerHTML = '<button class="wd-chip"><span class="wd-name">watchdog</span></button>'
  f.root.firstElementChild!.addEventListener('pointermove', e => e.stopPropagation())
  f.move(f.root.querySelector('span')!)
  f.clock(1000)
  f.stage.shake(20, 900)
  assert.equal(f.played.length, 0, 'hover stays protected beyond the settling interval')
  f.stage.burst(200, 180, { count: 5 })
  assert.equal(f.stage.particleCount, 5, 'the other EPIC effects remain active')
})

test('links, inputs and the clickable org inbox receive the same hover protection', t => {
  const f = fixture(t)
  f.root.innerHTML = '<a href="#"><span>link</span></a><input><div class="sq orginbox">inbox</div>'
  for (const target of f.root.querySelectorAll('span, input, .orginbox')) {
    f.move(target)
    f.clock(1000)
    f.stage.shake(20, 900)
    assert.equal(f.played.length, 0, `stable ${target.tagName} control`)
    f.clock(0)
  }
  f.clock(1000)
  f.root.querySelector('input')!.dispatchEvent(new window.Event('blur'))
  f.stage.shake(20, 900)
  assert.equal(f.played.length, 0, 'input blur does not clear control hover like window blur')
})

test('a pointer held down stays protected until release, even on a non-control drag surface', t => {
  const f = fixture(t)
  f.move(f.root, 'pointerdown')
  f.clock(2000)
  f.stage.shake(20, 900)
  assert.equal(f.played.length, 0, 'a held pointer cannot lose its target to a new shake')
  f.move(f.root, 'pointerup')
  f.clock(2300)
  f.stage.shake(20, 900)
  assert.equal(f.played.length, 1, 'release away from controls restores normal motion')
})

test('a pointer leaving the window clears stale control hover', t => {
  const f = fixture(t)
  f.root.innerHTML = '<button>watchdog</button>'
  f.move(f.root.firstElementChild!)
  f.clock(1000)
  f.root.firstElementChild!.dispatchEvent(new window.MouseEvent('pointerout', { bubbles: true, relatedTarget: null }))
  f.stage.shake(20, 900)
  assert.equal(f.played.length, 1, 'a departed pointer does not suppress future effects')
})

test('a second document protects its controls using its own pointer events and releases listeners on stop', t => {
  const dom = new JSDOM('<!doctype html><body></body>')
  t.after(() => dom.window.close())
  const f = fixture(t, dom.window.document)
  f.root.innerHTML = '<button><span>watchdog</span></button>'
  const registered: [string, EventListenerOrEventListenerObject][] = []
  const removed: [string, EventListenerOrEventListenerObject][] = []
  // This stage was already made; make another while observing its listener ownership.
  const add = dom.window.addEventListener.bind(dom.window)
  const remove = dom.window.removeEventListener.bind(dom.window)
  t.mock.method(dom.window, 'addEventListener', (type: string, fn: EventListenerOrEventListenerObject, opts?: AddEventListenerOptions) => {
    registered.push([type, fn]); add(type, fn, opts)
  })
  t.mock.method(dom.window, 'removeEventListener', (type: string, fn: EventListenerOrEventListenerObject, opts?: EventListenerOptions) => {
    removed.push([type, fn]); remove(type, fn, opts)
  })
  const other = new Stage(dom.window.document, () => f.root)
  // Later selector calls may lazily register jsdom's own load listener.
  // Capture the stage's registrations before exercising those selectors.
  const owned = registered.slice()
  try {
    f.move(f.root.querySelector('span')!)
    f.clock(1000)
    other.shake(20, 900)
    assert.equal(f.played.length, 0, 'the second realm uses duck-typed control targets')
  } finally { other.destroy() }
  assert.equal(owned.some(([type]) => type === 'pointermove'), true)
  assert.equal(owned.every(([type, fn]) => removed.some(([a, b]) => a === type && b === fn)), true)
})
