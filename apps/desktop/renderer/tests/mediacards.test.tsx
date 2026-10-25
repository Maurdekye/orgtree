import './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { mountView } from './harness'
import { SentFileCard } from '../src/canvas/filecard'

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
