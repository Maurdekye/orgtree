import './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { inAct, mountView } from './harness'
import { SentFileCard } from '../src/canvas/filecard'
import { MediaCard, MEDIA_MAX_BYTES, mediaHref } from '../src/canvas/media'
import { MailReadPane } from '../src/canvas/mail'
import { navigationBlocked } from '../src/shell/navigationkeys'
import { SegmentAttachments } from '../src/events/segments'

const href = '/api/orgs/synthetic/nodes/agent/file?path=clip.webm'
function mediaMocks(t: import('node:test').TestContext) {
  const proto = window.HTMLMediaElement.prototype
  t.mock.method(proto, 'canPlayType', () => 'probably')
  const play = t.mock.method(proto, 'play', () => Promise.resolve())
  const pause = t.mock.method(proto, 'pause', () => {})
  t.mock.method(proto, 'load', () => {})
  return { play, pause }
}

test('media cards render a click-to-play video instead of a download-only card', async t => {
  const v = await mountView(<SentFileCard slug="synthetic" nid="agent" file={{name:'clip.webm',path:'clip.webm',bytes:1200}} />, el => el)
  t.after(() => v.unmount())
  assert.equal(v.el.querySelector('button')?.textContent, 'Play video')
  assert.equal(v.el.querySelector('video')?.getAttribute('src'), null, 'no media request before Play')
})

test('media cards render click-to-play audio instead of a download-only card', async t => {
  const v = await mountView(<SentFileCard slug="synthetic" nid="agent" file={{name:'sound.wav',path:'sound.wav',bytes:1200}} />, el => el)
  t.after(() => v.unmount())
  assert.equal(v.el.querySelector('button')?.textContent, 'Play audio')
  assert.equal(v.el.querySelector('audio')?.getAttribute('src'), null, 'no media request before Play')
})

test('media cards retain existing image, caption and ordinary download behavior', async t => {
  const v = await mountView(<><SentFileCard slug="synthetic" nid="agent" file={{name:'picture.png',path:'picture.png',bytes:10,note:'An image'}} />
    <SentFileCard slug="synthetic" nid="agent" file={{name:'archive.zip',path:'archive.zip',bytes:12}} /></>, el => el)
  t.after(() => v.unmount())
  assert.equal(v.el.querySelectorAll('img').length, 1)
  assert.ok(v.el.textContent?.includes('An image'))
  assert.equal(v.el.querySelectorAll('a[download]').length, 2)
  assert.equal(v.el.querySelector('audio,video'), null)
})

test('media cards request only the authorized streaming route on explicit Play and release on unmount', async t => {
  const m = mediaMocks(t)
  const v = await mountView(<MediaCard href={href} name="clip.webm" bytes={10} />, el => el)
  const media = v.el.querySelector('video')!
  assert.equal(media.getAttribute('preload'), 'none')
  assert.equal(media.autoplay, false)
  assert.equal(m.play.mock.callCount(), 0)
  await inAct(() => v.el.querySelector('button')!.click())
  assert.equal(m.play.mock.callCount(), 1)
  assert.equal(media.getAttribute('src'), href + '&media=true')
  assert.equal(media.hidden, false)
  const key = new KeyboardEvent('keydown', {key:' '})
  Object.defineProperty(key, 'target', {value:media})
  assert.equal(navigationBlocked(key, document), true, 'native controls own keyboard navigation')
  await v.unmount()
  assert.equal(media.hasAttribute('src'), false, 'captured media element is released after its ref detaches')
  assert.ok(m.pause.mock.callCount() > 0)
})

test('media cards stop and release offscreen playback and replace source identity', async t => {
  mediaMocks(t)
  let notify: IntersectionObserverCallback = () => {}
  const before = Object.getOwnPropertyDescriptor(globalThis, 'IntersectionObserver')
  class Observer { constructor(cb: IntersectionObserverCallback) { notify = cb } observe() {} disconnect() {} }
  Object.defineProperty(globalThis, 'IntersectionObserver', { configurable: true, value: Observer })
  t.after(() => before ? Object.defineProperty(globalThis, 'IntersectionObserver', before) : delete (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver)
  const v = await mountView(<MediaCard href={href} name="clip.webm" />, el => el)
  t.after(() => v.unmount())
  await inAct(() => v.el.querySelector('button')!.click())
  const old = v.el.querySelector('video')!
  await inAct(() => notify([{ isIntersecting: false } as IntersectionObserverEntry], {} as IntersectionObserver))
  assert.equal(old.hasAttribute('src'), false)
  assert.equal(v.el.querySelector('button')?.textContent, 'Play video')
  await inAct(() => v.el.querySelector('button')!.click())
  await v.render(<MediaCard href={href.replace('synthetic', 'other-org')} name="clip.webm" />)
  assert.equal(old.hasAttribute('src'), false)
  assert.equal(v.el.querySelector('video')?.hasAttribute('src'), false)
})

test('media cards retain Download on size, codec, decode and unsafe URL failures', async t => {
  mediaMocks(t)
  const v = await mountView(<MediaCard href={href} name="large.webm" bytes={MEDIA_MAX_BYTES+1} />, el => el)
  t.after(() => v.unmount())
  assert.equal(v.el.querySelector('button'), null)
  assert.ok(v.el.textContent?.includes('256 MiB'))
  await v.render(<MediaCard href={href} name="clip.webm" bytes={MEDIA_MAX_BYTES} />)
  await inAct(() => v.el.querySelector('button')!.click())
  await inAct(() => v.el.querySelector('video')!.dispatchEvent(new Event('error')))
  assert.ok(v.el.textContent?.includes('Preview unavailable'))
  assert.ok(v.el.querySelector('a[download]'))
  t.mock.method(window.HTMLMediaElement.prototype, 'canPlayType', () => '')
  await inAct(() => v.el.querySelector('button')!.click())
  assert.ok(v.el.textContent?.includes('not supported'))
  for (const bad of ['file:///C:/secret.mp4','https://remote.invalid/video.mp4','//remote.invalid/video.mp4','/api/markdown-image?path=x']) assert.equal(mediaHref(bad), null)
})

test('message attachments share video and audio cards without adding a composer player', async t => {
  const v = await mountView(<MailReadPane cur={{id:'synthetic-mail',from:'agent',kind:'message',body:'Media',at:'2026-10-25T00:00:00Z',attachments:[{name:'clip.webm',path:'clip.webm',bytes:10},{name:'sound.wav',path:'sound.wav',bytes:10},{name:'missing.mp4'}]}}
    members={[]} sender={id => id} party="agent" fileHref={p => '/api/orgs/synthetic/nodes/agent/file?path='+encodeURIComponent(p)} />, el => el)
  t.after(() => v.unmount())
  assert.equal(v.el.querySelectorAll('.mediacard').length, 2)
  assert.equal(v.el.querySelectorAll('video,audio').length, 2)
  assert.equal(v.el.querySelectorAll('video[src],audio[src]').length, 0)
  assert.ok(v.el.textContent?.includes('missing.mp4'))
})

test('transcript segment attachments cover every approved container and preserve missing/image/download rows', async t => {
  const names = ['clip.mp4','clip.webm','sound.mp3','sound.wav','sound.ogg','sound.m4a','sound.aac','sound.flac','image.png','archive.zip']
  const v = await mountView(<SegmentAttachments slug="synthetic" nid="agent" values={[...names.map(name => ({name,path:name,bytes:20})),{name:'missing.mp4'}]} />, el => el)
  t.after(() => v.unmount())
  assert.equal(v.el.querySelectorAll('.mediacard').length, 8)
  assert.equal(v.el.querySelectorAll('video').length, 2)
  assert.equal(v.el.querySelectorAll('audio').length, 6)
  assert.equal(v.el.querySelectorAll('video[src],audio[src]').length, 0)
  assert.equal(v.el.querySelectorAll('img').length, 1)
  assert.ok(v.el.querySelector('a[download="archive.zip"]'))
  assert.ok(v.el.textContent?.includes('missing.mp4'))
})
