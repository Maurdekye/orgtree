// A markdown image's native error event must reach the fallback handler in
// the document that owns the adopted surface. This exercises the production
// MovableSurface adoption path with a second DOM document; it is not an
// installed Electron window proof.
import { flush, inAct, mountView } from './harness'
import { installBridge, removeBridge } from './shellbridge'
import test from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import { MovableSurface, PopoutButton } from '../src/popout'
import { md } from '../src/canvas/shared'

test('a failed markdown image in an adopted pop-out document exposes its fallback', async () => {
  localStorage.clear()
  installBridge({})
  const dom = new JSDOM('<html><head></head><body></body></html>', { url: 'http://localhost/' })
  const w = dom.window as unknown as Window
  Object.defineProperties(w, {
    screenX: { value: 200 }, screenY: { value: 180 },
    outerWidth: { value: 830 }, outerHeight: { value: 700 },
    closed: { value: false, writable: true },
  })
  w.focus = () => {}
  w.requestAnimationFrame = () => 1
  w.cancelAnimationFrame = () => {}
  const originalClose = w.close.bind(w)
  w.close = () => { (w as unknown as { closed: boolean }).closed = true }
  const originalOpen = window.open
  window.open = (() => w) as typeof window.open
  const originalObserver = globalThis.MutationObserver
  globalThis.MutationObserver = dom.window.MutationObserver

  const view = await mountView(<MovableSurface kind="image-popout-fixture" title="Images">
    <div className="md" dangerouslySetInnerHTML={md('![remote](https://images.example.test/chart.png)')} />
    <PopoutButton />
  </MovableSurface>, el => el)
  try {
    const open = view.el.querySelector<HTMLButtonElement>('button[aria-label="Open in new window"]')!
    await inAct(async () => { open.click(); await flush(5) })
    const img = w.document.querySelector<HTMLImageElement>('.md-image-embed img')!
    const wrapper = img.closest('.md-image-embed')!
    assert.equal(wrapper.classList.contains('failed'), false, 'the fallback starts hidden')
    const EventCtor = (w as unknown as { Event: typeof Event }).Event
    img.dispatchEvent(new EventCtor('error'))
    const fallback = w.document.querySelector<HTMLAnchorElement>('.md-image-fallback')
    assert.equal(wrapper.classList.contains('failed'), true, 'the adopted document handled the image error')
    assert.ok(fallback, 'the failed image retains its fallback link')
    assert.equal(fallback.getAttribute('href'), 'https://images.example.test/chart.png')

    const detachedProbe = w.document.createElement('div')
    detachedProbe.innerHTML = '<div class="md-image-embed"><img></div>'
    w.document.body.appendChild(detachedProbe)
    const returnButton = w.document.querySelector<HTMLButtonElement>('button[aria-label="Return to main window"]')!
    await inAct(async () => { returnButton.click(); await flush(5) })
    const probe = detachedProbe.querySelector('.md-image-embed')!
    probe.querySelector('img')!.dispatchEvent(new EventCtor('error'))
    assert.equal(probe.classList.contains('failed'), false, 'returning removes the pop-out error listener')
  } finally {
    await view.unmount()
    removeBridge()
    window.open = originalOpen
    globalThis.MutationObserver = originalObserver
    try { originalClose() } catch { /* already closed */ }
    localStorage.clear()
  }
})
