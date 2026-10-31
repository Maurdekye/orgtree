// lightboxzoom.test.ts — the lightbox zooms only the picture, and closing leaves the page at 1:1.
//
// USER 2026-10-31 16:59:58Z mae5103702a59 ("Yes, in 4.5.3"): Orgtree's lightbox gets the zoom Hubchat's viewer
// has (USER 15:03:04Z md50218422de7: closing a zoomed-in image left Hubchat's whole app zoomed in). The same
// gestures and math (./pinchmath is a copy of Hubchat's): pinch, one-finger pan while zoomed, double click
// fit <-> 2.5x, ctrl+wheel; the end of a gesture is not the tap that closes; opening and closing pin the
// viewport meta to scale 1 for a moment and restore it; no pointer capture; the controls sit above a zoomed
// picture. jsdom has no pinch of its own, so this is the lightbox's part, not the real window's.
//
// Run:  node apps/desktop/renderer/tests/run.mjs lightboxzoom

import { flush, JSDOM } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { openLightbox, closeLightbox } from '../src/canvas/lightbox'
declare const __SRC_DIR__: string

const META = 'width=device-width, initial-scale=1.0, viewport-fit=cover'

function open() {
  const dom = new JSDOM(`<html><head><meta name="viewport" content="${META}"></head><body></body></html>`,
    { url: 'http://localhost/', pretendToBeVisual: true })
  const win = dom.window as unknown as Window & typeof globalThis
  const P = win.HTMLElement.prototype as unknown as Record<string, unknown>
  let captured = 0
  P.setPointerCapture = () => { captured += 1 }
  Object.defineProperty(P, 'offsetWidth', { configurable: true, get(this: HTMLElement) { return this.tagName === 'IMG' ? 300 : 0 } })
  Object.defineProperty(P, 'offsetHeight', { configurable: true, get(this: HTMLElement) { return this.tagName === 'IMG' ? 200 : 0 } })
  P.getBoundingClientRect = function (this: HTMLElement) {
    return this.tagName === 'IMG'
      ? { left: 100, top: 100, width: 300, height: 200, right: 400, bottom: 300, x: 100, y: 100 }
      : { left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0, x: 0, y: 0 }
  }
  const doc = win.document
  const meta = doc.querySelector('meta[name=viewport]')!
  const log: string[] = []
  const set = meta.setAttribute.bind(meta)
  meta.setAttribute = (n: string, v: string) => { if (n === 'content') log.push(v); set(n, v) }
  openLightbox('data:image/png;base64,AA==', { name: 'pic.png' }, doc)
  const ov = doc.querySelector('.lb-overlay') as HTMLElement
  const img = doc.querySelector('.lb-img') as HTMLImageElement
  const fire = (type: string, el: Element, x = 0, y = 0, id = 1, extra: Record<string, unknown> = {}) => {
    const e = type === 'wheel' ? new win.WheelEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, ...extra })
      : new win.MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, ...extra })
    Object.defineProperty(e, 'pointerId', { value: id })
    el.dispatchEvent(e)
    return e
  }
  const scale = () => /scale\(([\d.]+)\)/.exec(img.style.transform)?.[1]
  return { win, doc, ov, img, meta, log, fire, scale, captured: () => captured }
}

test('a two-finger pinch zooms the picture, not the page, and its end does not close the viewer', async () => {
  const k = open()
  try {
    await new Promise(r => setTimeout(r, 120))   // the open's own viewport pin is over
    k.fire('pointerdown', k.ov, 200, 200, 1); k.fire('pointerdown', k.ov, 240, 200, 2)
    k.fire('pointermove', k.ov, 160, 200, 1); k.fire('pointermove', k.ov, 280, 200, 2)
    assert.equal(k.scale(), '3', 'the picture is at 3x')
    k.fire('pointerup', k.ov, 160, 200, 1); k.fire('pointerup', k.ov, 280, 200, 2)
    k.fire('click', k.ov)
    assert.ok(k.doc.querySelector('.lb-overlay'), 'the end of a pinch does not close')
    assert.equal(k.meta.getAttribute('content'), META, 'the page scale is untouched by the pinch')
    assert.equal(k.captured(), 0, 'no pointer capture (it would retarget the picture\'s own clicks)')
    k.fire('click', k.ov)
    assert.equal(k.doc.querySelector('.lb-overlay'), null, 'a plain tap on the backdrop closes')
  } finally { closeLightbox(k.doc) }
})

test('a zoomed picture pans by one finger and stays within its edges; at fit nothing moves', async () => {
  const k = open()
  try {
    k.fire('pointerdown', k.ov, 200, 200, 1); k.fire('pointermove', k.ov, 260, 260, 1); k.fire('pointerup', k.ov, 260, 260, 1)
    assert.match(k.img.style.transform, /translate\(0px, 0px\) scale\(1\)|^$/, 'nothing to pan at fit')
    k.fire('click', k.ov)
    k.fire('dblclick', k.img, 250, 200)
    assert.equal(k.scale(), '2.5')
    k.fire('pointerdown', k.ov, 200, 200, 1); k.fire('pointermove', k.ov, 2000, 2000, 1); k.fire('pointerup', k.ov, 2000, 2000, 1)
    assert.match(k.img.style.transform, /translate\(225px, 150px\)/, 'an edge stops at the edge: (2.5-1)*300/2 and (2.5-1)*200/2')
  } finally { closeLightbox(k.doc) }
})

test('double click toggles fit <-> 2.5x on the picture without closing', async () => {
  const k = open()
  try {
    k.fire('click', k.img); k.fire('click', k.img); k.fire('dblclick', k.img, 250, 200)
    assert.equal(k.scale(), '2.5')
    assert.ok(k.doc.querySelector('.lb-overlay'), 'the picture\'s own clicks never close the viewer')
    k.fire('dblclick', k.img, 250, 200)
    assert.equal(k.scale(), '1')
  } finally { closeLightbox(k.doc) }
})

test('ctrl+wheel zooms about the pointer and is the browser\'s page zoom stopped; a plain wheel does nothing', async () => {
  const k = open()
  try {
    const plain = k.fire('wheel', k.ov, 250, 200, 1, { deltaY: -300 })
    assert.equal(plain.defaultPrevented, false)
    assert.equal(k.scale(), undefined, 'a plain wheel leaves the picture alone')
    const ctrl = k.fire('wheel', k.ov, 250, 200, 1, { deltaY: -300, ctrlKey: true })
    assert.equal(ctrl.defaultPrevented, true, 'the page zoom is stopped')
    assert.ok(Number(k.scale()) > 1)
  } finally { closeLightbox(k.doc) }
})

test('opening and closing pin the page scale to 1 for a moment and restore the viewport', async () => {
  const k = open()
  try {
    assert.ok(k.log.some(c => /minimum-scale=1, maximum-scale=1$/.test(c)), 'opening pinned the meta')
    await new Promise(r => setTimeout(r, 120))
    assert.equal(k.meta.getAttribute('content'), META, 'restored after the frames')
    k.log.length = 0
    closeLightbox(k.doc)
    assert.ok(k.log.some(c => /minimum-scale=1, maximum-scale=1$/.test(c)), 'closing pinned it again')
    await new Promise(r => setTimeout(r, 120))
    assert.equal(k.meta.getAttribute('content'), META, 'and restored it, as it was')
  } finally { closeLightbox(k.doc) }
})

test('the overlay takes the touches and the controls sit above a zoomed picture (styles.css)', () => {
  const css = fs.readFileSync(path.join(__SRC_DIR__, 'styles.css'), 'utf8')
  const rule = (sel: string) => new RegExp(sel.replace(/\./g, '\\.') + '\\s*\\{[^}]*\\}').exec(css)?.[0] ?? ''
  assert.match(rule('.lb-overlay'), /touch-action:\s*none/)
  assert.match(rule('.lb-img'), /touch-action:\s*none/)
  assert.match(rule('.lb-x'), /z-index:\s*2/)
  assert.match(rule('.lb-bar'), /z-index:\s*2/)
  void flush
})

test('the picture cannot be dragged natively: that steals the mouse pan', () => {
  const k = open()
  try {
    assert.equal(k.img.draggable, false)
    const start = k.fire('dragstart', k.img)
    assert.equal(start.defaultPrevented, true, 'the native drag is cancelled')
  } finally { closeLightbox(k.doc) }
})
