import { inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { HeldAudienceChips } from '../src/canvas/desk'
import { audienceGrantTooltip, type CanvasNode } from '../src/canvas/shared'

const map = new Map<string, CanvasNode>()
const mount = (sources: string[], explicit: string[] | undefined = []) => mountView(
  <HeldAudienceChips slug="demo" toast={() => {}} map={map} node={{
    id: 'worker', audiences_held: ['@user'], audiences_explicit: explicit,
    audiences_inherited: sources.map(project => ({ grantor: '@user', project })),
  }} />, el => el)

test('inherited header badge leads with the project and exposes the same text on keyboard focus', async t => {
  const view = await mount(['build-slot'])
  t.after(() => view.unmount())
  const badge = view.el.querySelector<HTMLElement>('.badge')!
  assert.equal(badge.title, `Inherited from project build-slot\n${audienceGrantTooltip('@user')}`)
  assert.equal(badge.getAttribute('aria-label'), badge.title)
  assert.equal(badge.tabIndex, 0)
  await inAct(() => badge.focus())
  assert.equal(document.activeElement, badge)
  assert.equal(badge.getAttribute('aria-label'), badge.title)
  assert.equal(badge.querySelector('.chip-x'), null, 'inheritance has no personal revoke')
})

test('all inherited project sources precede the explanation and explicit grant is still identified', async t => {
  const view = await mount(['outer', 'inner'], ['@user'])
  t.after(() => view.unmount())
  const badge = view.el.querySelector<HTMLElement>('.badge')!
  assert.equal(badge.title, ['Inherited from project outer', 'Inherited from project inner',
    audienceGrantTooltip('@user'), 'Also held explicitly'].join('\n'))
  assert.equal(badge.getAttribute('aria-label'), badge.title)
  assert.equal(badge.querySelector('button')?.title, 'Revoke')
})

test('explicit-only and legacy header badges retain their original title and revoke affordance', async t => {
  for (const explicit of [['@user'], undefined]) {
    const view = await mountView(<HeldAudienceChips slug="demo" toast={() => {}} map={map}
      node={{ id: 'worker', audiences_held: ['@user'], audiences_explicit: explicit }} />, el => el)
    t.after(() => view.unmount())
    const badge = view.el.querySelector<HTMLElement>('.badge')!
    assert.equal(badge.title, audienceGrantTooltip('@user'))
    assert.equal(badge.hasAttribute('aria-label'), false)
    assert.equal(badge.tabIndex, -1)
    assert.equal(badge.querySelector('button')?.title, 'Revoke')
  }
})
