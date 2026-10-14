import './harness'
import { FakeServer, flush, inAct, installFetch, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { resetConvos } from '../src/convo'
import { forgetAttentionMode } from '../src/attention/mode'
import { forgetModalPins } from '../src/canvas/modalpin'
import { attentionDeskScene, eligibleDeskScene } from './attentiondeskreclaim.fixture'

function setup() {
  localStorage.clear(); forgetAttentionMode(); forgetModalPins(); resetConvos()
  installFetch(new FakeServer())
}
const settle = () => inAct(() => flush(8))

test('closing the switchboard returns the SAME live desk to pinned Attention without a click or placeholder', async t => {
  setup()
  const scene = attentionDeskScene(); scene.init()
  const v = await mountView(scene.wrap(false), el => el)
  t.after(() => v.unmount())
  await settle()
  const panel = document.querySelector('.attn-panel-desk')!
  assert.ok(panel?.matches('.modalpin-win'), 'the real attention panel is pinned')
  const composer = panel.querySelector('textarea') as HTMLTextAreaElement
  assert.ok(composer)
  await inAct(() => {
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!.call(composer, 'unfinished draft')
    composer.dispatchEvent(new window.Event('input', { bubbles: true }))
  })
  for (let cycle = 0; cycle < 2; cycle++) {
    await v.render(scene.wrap(true)); await settle()
    assert.equal(v.el.querySelector('[data-switchboard] textarea') === composer, true)
    assert.equal(panel.querySelectorAll('.popout-placeholder').length, 1)
    assert.equal(panel.querySelectorAll('textarea').length, 0, 'a non-owner shows only the placeholder')
    await v.render(scene.wrap(false)); await settle()
    assert.equal(panel.querySelector('textarea') === composer, true, 'close returns the existing composer')
    assert.equal(composer.value, 'unfinished draft')
    assert.equal(panel.querySelectorAll('.popout-placeholder').length, 0, 'the returned desk cannot share width with a stale placeholder')
    assert.equal(document.querySelectorAll('textarea').length, 1)
  }
})

test('owner removal resolves the visible fallback before publishing, skipping the earlier hidden slot', async t => {
  setup()
  const scene = eligibleDeskScene()
  const v = await mountView(scene.before, el => el)
  t.after(() => v.unmount())
  await settle()
  const composer = v.el.querySelector('[data-host="owner"] textarea')!
  assert.ok(composer)
  await v.render(scene.after); await settle()
  const visible = v.el.querySelector('[data-host="visible"]')!
  assert.equal(visible.querySelector('textarea') === composer, true)
  assert.equal(visible.querySelectorAll('.popout-placeholder').length, 0)
  assert.equal(v.el.querySelector('[data-host="hidden"] textarea') === null, true)
  assert.equal(v.el.querySelector('[data-host="hidden"] .popout-placeholder') !== null, true)
})
