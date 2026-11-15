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

// 4.6.1 (USER 2026-11-15 mbf1f1ca2cfe9): the switchboard and the pinned Attention desk each show the agent's live
// desk at once. Neither takes it from the other; the unsent draft is the agent's one draft, in both.
test('opening the switchboard beside the pinned Attention desk shows the live desk in both, with one draft', async t => {
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
    const board = v.el.querySelector('[data-switchboard] textarea') as HTMLTextAreaElement | null
    assert.equal(Boolean(board), true, 'the switchboard shows a live desk')
    assert.equal(board!.value, 'unfinished draft', 'the switchboard shows the same draft')
    assert.equal(panel.querySelector('textarea') === composer, true, 'the Attention desk kept its own desk')
    assert.equal(document.querySelectorAll('.popout-placeholder').length, 0, 'no place shows a placeholder')
    await v.render(scene.wrap(false)); await settle()
    assert.equal(panel.querySelector('textarea') === composer, true, 'closing the switchboard leaves the Attention desk alone')
    assert.equal(composer.value, 'unfinished draft')
    assert.equal(document.querySelectorAll('textarea').length, 1)
  }
})

test('a place off screen shows nothing while the places on screen each show the live desk', async t => {
  setup()
  const scene = eligibleDeskScene()
  const v = await mountView(scene.before, el => el)
  t.after(() => v.unmount())
  await settle()
  for (const host of ['visible', 'owner']) {
    assert.equal(v.el.querySelector(`[data-host="${host}"] textarea`) !== null, true, `${host} shows a live desk`)
  }
  const visible = v.el.querySelector('[data-host="visible"] textarea')
  await v.render(scene.after); await settle()
  assert.equal(v.el.querySelector('[data-host="visible"] textarea') === visible, true, 'removing a place leaves the others mounted')
  assert.equal(v.el.querySelector('[data-host="hidden"] textarea') === null, true)
  assert.equal(v.el.querySelector('[data-host="hidden"] .popout-placeholder') === null, true, 'the hidden place draws nothing')
})
