// agenttooltipstale.test.tsx — THE MODEL TAG MUST NOT STAY ON A CARD THAT BECAME A DESK.
//
// USER 2026-11-13 m34935c22a71e: "hovering over any part of an agent's desk on the canvas that doesnt have unique
// hover tooltip text shows the provider+model+version+effort+etc. tag that you normally get while hovering the norm /
// mini node. that shouldnt show anything unless youre explicitly hovering the agent's name on the desk".
//
// The cause. A canvas card carries `data-agent-tooltip` while it is a node and drops it when it becomes the desk
// (cards.tsx: `agentTooltipProps(focused ? undefined : node.id)`; projectcard.tsx the same with `deskOpen`). The shared
// host (agentnav.tsx) writes the tag as a native `title` on the hovered anchor and takes it off again when the pointer
// leaves, finding the anchor BY that attribute. Hover a node, click it: the attribute goes, the title stays, and
// nothing can find the element to clear it any more, so the whole desk inherits the tag.
//
// Run:  node apps/desktop/renderer/tests/run.mjs agenttooltipstale

import './harness'
import { flush } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { AGENT_TOOLTIP_ATTR, registerAgentNativeTooltipDocument } from '../src/canvas/agentnav'

const TAG = 'scout · Claude Opus 5.5 · high'
const over = (el: Element, type = 'pointerover') =>
  el.dispatchEvent(new window.MouseEvent(type, { bubbles: true }))

function scene() {
  document.body.innerHTML = ''
  const card = document.createElement('div')
  card.setAttribute(AGENT_TOOLTIP_ATTR, 'scout')
  const body = document.createElement('p')
  body.textContent = 'a plain part of the desk'
  const name = document.createElement('span')
  name.setAttribute(AGENT_TOOLTIP_ATTR, 'scout')
  name.textContent = 'scout'
  const own = document.createElement('button')
  own.title = 'settings for scout'
  card.append(name, body, own)
  document.body.append(card)
  return { card, body, name, own }
}

test('a card that stops being a tooltip anchor loses the tag it was given', async (t) => {
  t.after(registerAgentNativeTooltipDocument(document, () => ({ title: TAG })))
  const { card, body } = scene()
  over(body)
  assert.equal(card.title, TAG, 'control: hovering the node shows its tag')

  // the click that opens the desk: React drops the attribute, as cards.tsx does when `focused`
  card.removeAttribute(AGENT_TOOLTIP_ATTR)
  await flush()
  assert.equal(card.hasAttribute('title'), false, 'the desk must not keep the node\'s tag')
})

test('on the desk, the name still shows the tag and an element\'s own tooltip is untouched', async (t) => {
  t.after(registerAgentNativeTooltipDocument(document, () => ({ title: TAG })))
  const { card, body, name, own } = scene()
  over(body)
  card.removeAttribute(AGENT_TOOLTIP_ATTR)
  await flush()

  over(body)
  assert.equal(card.hasAttribute('title'), false, 'a plain part of the desk shows nothing')
  over(name)
  assert.equal(name.title, TAG, 'the agent\'s name shows the tag')
  over(name, 'pointerout')
  assert.equal(name.hasAttribute('title'), false, 'and loses it when the pointer leaves, as before')
  assert.equal(own.title, 'settings for scout')
})

test('control: a node that stays a node keeps its tag until the pointer leaves', async (t) => {
  t.after(registerAgentNativeTooltipDocument(document, () => ({ title: TAG })))
  const { card, body } = scene()
  over(body)
  await flush()
  assert.equal(card.title, TAG)
  over(card, 'pointerout')
  assert.equal(card.hasAttribute('title'), false)
})

test('an anchor re-pointed at another agent drops the old agent\'s tag', async (t) => {
  t.after(registerAgentNativeTooltipDocument(document, (id) => ({ title: id + ' tag' })))
  const { card, body } = scene()
  over(body)
  assert.equal(card.title, 'scout tag')
  card.setAttribute(AGENT_TOOLTIP_ATTR, 'other')
  await flush()
  assert.equal(card.hasAttribute('title'), false, 'the old tag is gone')
  over(body)
  assert.equal(card.title, 'other tag', 'and the next hover shows the new agent\'s')
})
