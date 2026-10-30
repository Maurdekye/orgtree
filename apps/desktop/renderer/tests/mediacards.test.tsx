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

// USER 2026-10-30 m478dfd75cf44 "inline videos should open automatically, just not play until clicked": a video card shows
// its player and first frame when it renders. Only the metadata is asked for, nothing plays, and the player's own
// controls start it. (This replaces the 4.5.0 "Media loads only after Play" for video; audio keeps it.)
test('a video card opens its player on render and does not play until its own control is used', async t => {
  const m = mediaMocks(t)
  const v = await mountView(<SentFileCard slug="synthetic" nid="agent" file={{name:'clip.webm',path:'clip.webm',bytes:1200}} />, el => el)
  t.after(() => v.unmount())
  const video = v.el.querySelector('video')!
  assert.equal(video.hidden, false, 'the player is shown on render')
  assert.equal(video.controls, true, 'with its native controls, which are the Play')
  assert.equal(video.getAttribute('preload'), 'metadata', 'only the metadata and first frame are asked for')
  assert.equal(video.getAttribute('src'), href + '&media=true', 'the authorized route, set on render')
  assert.equal(video.autoplay, false)
  assert.equal(m.play.mock.callCount(), 0, 'nothing plays by itself')
  assert.equal(v.el.querySelector('.media-play'), null, 'no separate Play button: the player is already open')
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

test('audio cards request only the authorized streaming route on explicit Play and release on unmount', async t => {
  const m = mediaMocks(t)
  const v = await mountView(<MediaCard href={href.replace('clip.webm', 'sound.wav')} name="sound.wav" bytes={10} />, el => el)
  const media = v.el.querySelector('audio')!
  assert.equal(media.getAttribute('preload'), 'none')
  assert.equal(media.autoplay, false)
  assert.equal(m.play.mock.callCount(), 0)
  await inAct(() => v.el.querySelector('button')!.click())
  assert.equal(m.play.mock.callCount(), 1)
  assert.equal(media.getAttribute('src'), href.replace('clip.webm', 'sound.wav') + '&media=true')
  assert.equal(media.hidden, false)
  const key = new KeyboardEvent('keydown', {key:' '})
  Object.defineProperty(key, 'target', {value:media})
  assert.equal(navigationBlocked(key, document), true, 'native controls own keyboard navigation')
  await v.unmount()
  assert.equal(media.hasAttribute('src'), false, 'captured media element is released after its ref detaches')
  assert.ok(m.pause.mock.callCount() > 0)
})

test('a video card releases its source when it unmounts, and its own control owns the keyboard', async t => {
  const m = mediaMocks(t)
  const v = await mountView(<MediaCard href={href} name="clip.webm" bytes={10} />, el => el)
  const media = v.el.querySelector('video')!
  assert.equal(media.getAttribute('src'), href + '&media=true')
  const key = new KeyboardEvent('keydown', {key:' '})
  Object.defineProperty(key, 'target', {value:media})
  assert.equal(navigationBlocked(key, document), true, 'native controls own keyboard navigation')
  await v.unmount()
  assert.equal(media.hasAttribute('src'), false, 'captured media element is released after its ref detaches')
  assert.ok(m.pause.mock.callCount() > 0)
})

function observerMock(t: import('node:test').TestContext) {
  let notify: IntersectionObserverCallback = () => {}
  const before = Object.getOwnPropertyDescriptor(globalThis, 'IntersectionObserver')
  class Observer { constructor(cb: IntersectionObserverCallback) { notify = cb } observe() {} disconnect() {} }
  Object.defineProperty(globalThis, 'IntersectionObserver', { configurable: true, value: Observer })
  t.after(() => before ? Object.defineProperty(globalThis, 'IntersectionObserver', before) : delete (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver)
  return (isIntersecting: boolean) => inAct(() => notify([{ isIntersecting } as IntersectionObserverEntry], {} as IntersectionObserver))
}

test('audio cards stop and release offscreen playback and replace source identity', async t => {
  mediaMocks(t)
  const sound = href.replace('clip.webm', 'sound.wav')
  const intersect = observerMock(t)
  const v = await mountView(<MediaCard href={sound} name="sound.wav" />, el => el)
  t.after(() => v.unmount())
  await inAct(() => v.el.querySelector('button')!.click())
  const old = v.el.querySelector('audio')!
  await intersect(false)
  assert.equal(old.hasAttribute('src'), false)
  assert.equal(v.el.querySelector('button')?.textContent, 'Play audio')
  await inAct(() => v.el.querySelector('button')!.click())
  await v.render(<MediaCard href={sound.replace('synthetic', 'other-org')} name="sound.wav" />)
  assert.equal(old.hasAttribute('src'), false)
  assert.equal(v.el.querySelector('audio')?.hasAttribute('src'), false)
})

test('a video card loads only while it is on screen, and coming back reopens it paused', async t => {
  const m = mediaMocks(t)
  const intersect = observerMock(t)
  const v = await mountView(<MediaCard href={href} name="clip.webm" />, el => el)
  t.after(() => v.unmount())
  const video = v.el.querySelector('video')!
  assert.equal(video.hasAttribute('src'), false, 'nothing is requested before the card is seen')
  await intersect(true)
  assert.equal(video.getAttribute('src'), href + '&media=true', 'seen: the player opens')
  await intersect(false)
  assert.equal(video.hasAttribute('src'), false, 'scrolled away: the source is released')
  assert.ok(m.pause.mock.callCount() > 0)
  await intersect(true)
  assert.equal(video.getAttribute('src'), href + '&media=true', 'back in view: the player opens again')
  assert.equal(m.play.mock.callCount(), 0, 'and it never resumes by itself')
  await v.render(<MediaCard href={href.replace('synthetic', 'other-org')} name="clip.webm" />)
  assert.equal(video.hasAttribute('src'), false, 'a new file replaces the old player')
})

// USER 2026-10-30 md731a537e304 "issue, i cant maximize inline videos". Whatever the observer says about the card while its
// video takes the whole screen, that must not tear the video down.
test('a video that has taken the whole screen keeps its source when its card is reported offscreen', async t => {
  mediaMocks(t)
  const intersect = observerMock(t)
  const v = await mountView(<MediaCard href={href} name="clip.webm" />, el => el)
  t.after(() => v.unmount())
  await intersect(true)
  const video = v.el.querySelector('video')!
  Object.defineProperty(document, 'fullscreenElement', { configurable: true, value: video })
  t.after(() => { delete (document as { fullscreenElement?: unknown }).fullscreenElement })
  await intersect(false)
  assert.equal(video.getAttribute('src'), href + '&media=true', 'fullscreen is not offscreen')
  assert.equal(video.hidden, false)
  Object.defineProperty(document, 'fullscreenElement', { configurable: true, value: null })
  await intersect(false)
  assert.equal(video.hasAttribute('src'), false, 'out of fullscreen and offscreen: released as before')
})

test('media cards retain Download on size, codec, decode and unsafe URL failures', async t => {
  mediaMocks(t)
  const v = await mountView(<MediaCard href={href} name="large.webm" bytes={MEDIA_MAX_BYTES+1} />, el => el)
  t.after(() => v.unmount())
  assert.equal(v.el.querySelector('button'), null)
  assert.ok(v.el.textContent?.includes('256 MiB'))
  await v.render(<MediaCard href={href} name="clip.webm" bytes={MEDIA_MAX_BYTES} />)
  await inAct(() => v.el.querySelector('video')!.dispatchEvent(new Event('error')))
  assert.ok(v.el.textContent?.includes('Preview unavailable'))
  assert.ok(v.el.querySelector('a[download]'))
  assert.equal(v.el.querySelector('video')!.hidden, true, 'a video that cannot be opened is not left as an empty player')
  t.mock.method(window.HTMLMediaElement.prototype, 'canPlayType', () => '')
  await v.render(<MediaCard href={href} name="other.webm" bytes={MEDIA_MAX_BYTES} />)
  assert.ok(v.el.textContent?.includes('not supported'), 'an unsupported video says so on render')
  assert.equal(v.el.querySelector('video')!.hasAttribute('src'), false)
  await v.render(<MediaCard href={href.replace('clip.webm', 'sound.wav')} name="sound.wav" bytes={MEDIA_MAX_BYTES} />)
  await inAct(() => v.el.querySelector('button')!.click())
  assert.ok(v.el.textContent?.includes('not supported'), 'an unsupported audio file says so on Play')
  for (const bad of ['file:///C:/secret.mp4','https://remote.invalid/video.mp4','//remote.invalid/video.mp4','/api/markdown-image?path=x']) assert.equal(mediaHref(bad), null)
})

test('message attachments share video and audio cards without adding a composer player', async t => {
  mediaMocks(t)
  const v = await mountView(<MailReadPane cur={{id:'synthetic-mail',from:'agent',kind:'message',body:'Media',at:'2026-10-25T00:00:00Z',attachments:[{name:'clip.webm',path:'clip.webm',bytes:10},{name:'sound.wav',path:'sound.wav',bytes:10},{name:'missing.mp4'}]}}
    members={[]} sender={id => id} party="agent" fileHref={p => '/api/orgs/synthetic/nodes/agent/file?path='+encodeURIComponent(p)} />, el => el)
  t.after(() => v.unmount())
  assert.equal(v.el.querySelectorAll('.mediacard').length, 2)
  assert.equal(v.el.querySelectorAll('video,audio').length, 2)
  assert.equal(v.el.querySelectorAll('video[src]').length, 1, 'the video opens on render')
  assert.equal(v.el.querySelectorAll('audio[src]').length, 0, 'the audio waits for Play')
  assert.ok(v.el.textContent?.includes('missing.mp4'))
})

test('transcript segment attachments cover every approved container and preserve missing/image/download rows', async t => {
  mediaMocks(t)
  const names = ['clip.mp4','clip.webm','sound.mp3','sound.wav','sound.ogg','sound.m4a','sound.aac','sound.flac','image.png','archive.zip']
  const v = await mountView(<SegmentAttachments slug="synthetic" nid="agent" values={[...names.map(name => ({name,path:name,bytes:20})),{name:'missing.mp4'}]} />, el => el)
  t.after(() => v.unmount())
  assert.equal(v.el.querySelectorAll('.mediacard').length, 8)
  assert.equal(v.el.querySelectorAll('video').length, 2)
  assert.equal(v.el.querySelectorAll('audio').length, 6)
  assert.equal(v.el.querySelectorAll('video[src]').length, 2, 'both videos open on render')
  assert.equal(v.el.querySelectorAll('audio[src]').length, 0, 'no audio waits on anything but Play')
  assert.equal(v.el.querySelectorAll('img').length, 1)
  assert.ok(v.el.querySelector('a[download="archive.zip"]'))
  assert.ok(v.el.textContent?.includes('missing.mp4'))
})
