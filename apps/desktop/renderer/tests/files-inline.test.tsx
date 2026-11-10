import { mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { AgentFilesView } from '../src/canvas/files'
import { fileUrl } from '../src/api'
import { inAct, flush } from './harness'

// USER 2026-11-10 m3ef1104c77c6: "the listed files should have the embedded content inline" — each Files row shows its content
// with the SAME renderer chat uses for that file type (SentFileCard: images, video and audio players); a type chat does not
// embed stays a plain row. The row's own metadata and actions stay.
const response = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } })
const file = (id: string, name: string, bytes = 4096) => ({ delivery_id: id, name, path: `out/${name}`, bytes, note: null, at: '2026-11-10T08:00:00Z' })

function mediaMocks(t: import('node:test').TestContext) {
  const proto = window.HTMLMediaElement.prototype
  t.mock.method(proto, 'canPlayType', () => 'probably')
  const play = t.mock.method(proto, 'play', () => Promise.resolve())
  t.mock.method(proto, 'pause', () => {})
  t.mock.method(proto, 'load', () => {})
  return { play }
}
function observerMock(t: import('node:test').TestContext) {
  let notify: IntersectionObserverCallback = () => {}
  const before = Object.getOwnPropertyDescriptor(globalThis, 'IntersectionObserver')
  class Observer { constructor(cb: IntersectionObserverCallback) { notify = cb } observe() {} disconnect() {} }
  Object.defineProperty(globalThis, 'IntersectionObserver', { configurable: true, value: Observer })
  t.after(() => before ? Object.defineProperty(globalThis, 'IntersectionObserver', before) : delete (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver)
  return (isIntersecting: boolean) => inAct(() => notify([{ isIntersecting } as IntersectionObserverEntry], {} as IntersectionObserver))
}
const rows = [file('f4', 'tone.wav'), file('f3', 'clip.webm'), file('f2', 'notes.zip'), file('f1', 'preview.png')]
const mount = async (t: import('node:test').TestContext) => {
  globalThis.fetch = (async () => response({ node: 'maker', files: rows, next_cursor: null })) as typeof fetch
  const v = await mountView(<AgentFilesView slug="fixture" nid="maker" />, el => el)
  t.after(() => v.unmount())
  await inAct(() => flush(2))
  return v
}
const row = (v: { el: HTMLElement }, id: string) => v.el.querySelector<HTMLLIElement>(`li[data-delivery-id="${id}"]`)!

test('an image file shows the chat image card inline, lazily, and keeps its row metadata and actions', async t => {
  mediaMocks(t)
  const v = await mount(t)
  const li = row(v, 'f1')
  const img = li.querySelector<HTMLImageElement>('img.imgcard-img')
  assert.ok(img, 'the image is embedded in its row')
  assert.equal(img!.getAttribute('src'), fileUrl('fixture', 'maker', 'out/preview.png'))
  assert.equal(img!.getAttribute('loading'), 'lazy', 'lazy like chat')
  assert.ok(li.querySelector('a.agent-file-name'), 'the name link stays')
  assert.ok(li.querySelector('.agent-file-size'), 'the size stays')
  assert.ok(li.querySelector('a.agent-file-download'), 'the download action stays')
})

test('a video file shows the chat video player inline and an audio file shows its player at once, neither autoplaying', async t => {
  const m = mediaMocks(t)
  const v = await mount(t)
  const video = row(v, 'f3').querySelector('video')!
  assert.ok(video, 'the video player is embedded')
  assert.equal(video.getAttribute('preload'), 'metadata')
  assert.equal(video.getAttribute('src'), fileUrl('fixture', 'maker', 'out/clip.webm') + '&media=true')
  const audio = row(v, 'f4').querySelector('audio')!
  assert.ok(audio, 'the audio player is embedded')
  assert.equal(audio.hidden, false, 'visible at once')
  assert.equal(audio.getAttribute('src'), fileUrl('fixture', 'maker', 'out/tone.wav') + '&media=true')
  assert.equal(v.el.querySelector('.media-play'), null, 'no reveal button')
  assert.equal(m.play.mock.callCount(), 0, 'nothing autoplays')
  assert.ok(row(v, 'f3').querySelector('a.agent-file-download') && row(v, 'f4').querySelector('a.agent-file-download'))
})

test('a file type chat does not embed stays a plain row', async t => {
  mediaMocks(t)
  const v = await mount(t)
  const li = row(v, 'f2')
  assert.equal(li.querySelector('img,video,audio,.filecard'), null)
  assert.ok(li.querySelector('a.agent-file-name') && li.querySelector('a.agent-file-download'))
})

test('embedded players load lazily: nothing is requested until the row is seen, and scrolling away releases it', async t => {
  mediaMocks(t)
  const intersect = observerMock(t)
  const v = await mount(t)
  const video = row(v, 'f3').querySelector('video')!, audio = row(v, 'f4').querySelector('audio')!
  assert.equal(video.hasAttribute('src'), false)
  assert.equal(audio.hasAttribute('src'), false)
  await intersect(true)
  assert.equal(video.hasAttribute('src'), true)
  assert.equal(audio.hasAttribute('src'), true)
  await intersect(false)
  assert.equal(video.hasAttribute('src'), false)
  assert.equal(audio.hasAttribute('src'), false)
})
