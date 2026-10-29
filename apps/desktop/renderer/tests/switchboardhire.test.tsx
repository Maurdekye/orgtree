// switchboardhire.test.tsx — the switchboard's (the eye's) expanded hire strip
// folds when the pointer leaves the card, as an agent's (NodeSquare clears
// expandedHireEdge) and a project's do (S5 #48). USER 2026-10-29 22:42:05Z
// m71f428e3e25c, answering "a project's hire strip collapses when the pointer
// leaves it, like an agent's": "should do the same for the switchboard".
//
// Docket switchboard-s-hire-strip-collapses-on-pointer-le. The first-use
// guide's token step keeps the strip open on its own (`guideHire`), which must
// survive: the leave only clears the card's own expand state.
//
// Run: node apps/desktop/renderer/tests/run.mjs switchboardhire

import { inAct, mountView } from './harness'
import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { UserNode } from '../src/canvas/cards'
import { beginFirstUse, firstUseDismiss } from '../src/canvas/firstuse'
import type { OpResult } from '../src/types'

const noop = () => {}
const op = () => Promise.resolve({} as OpResult)
const seats = {
  haiku: 1, sonnet: 2, opus: 5, fable: 10, 'gpt-reserve': 0.2, luna: 0.2, terra: 2, sol: 5, flash: 1, pro: 2,
}
const available = { enabled: true, installed: true, reason: null }

// 0.77: the strip is compact (a ⋯ toggle), as overseerhire.test.tsx mounts it
function eye(slug: string, t: TestContext) {
  return mountView(
    <UserNode pos={{ x: 0, y: 0 }} isDrop={false}
      stats={{ circ: 0, seats: 0, free: 0 }} pip={null} seats={seats}
      codexHire={available} antigravityHire={available} claudeHire={available}
      pxc={1} zoom={0.77}
      onSpawn={noop} onMailLink={noop} onWorkLink={noop} focused={false} eyeW={124}
      posX={() => 0} map={new Map()} op={op} slug={slug} toast={noop} />,
    (el) => el).then((view) => { t.after(() => view.unmount()); return view })
}
const leave = (card: HTMLElement, to: Element | null) =>
  card.dispatchEvent(new MouseEvent('pointerout', { bubbles: true, relatedTarget: to }))

test('an expanded switchboard hire strip collapses when the pointer leaves the card, and expands again', async (t) => {
  const view = await eye('switchboard-leave', t)
  const card = view.el.querySelector<HTMLElement>('.sq.user')!
  const strip = card.querySelector<HTMLElement>('.hsof')!
  const expand = strip.querySelector<HTMLButtonElement>('.hire-expand')!
  assert.ok(strip && expand, 'the compact hire strip with its ⋯ toggle')
  await inAct(() => { expand.click() })
  assert.equal(strip.classList.contains('is-expanded'), true, 'the strip expands')
  assert.equal(expand.getAttribute('aria-expanded'), 'true')
  // moving onto something inside the card is not leaving it
  await inAct(() => { leave(card, strip) })
  assert.equal(strip.classList.contains('is-expanded'), true, 'moving within the card keeps it open')
  await inAct(() => { leave(card, document.body) })
  assert.equal(strip.classList.contains('is-expanded'), false, 'leaving the card collapses it, as an agent\'s and a project\'s do')
  assert.equal(expand.getAttribute('aria-expanded'), 'false')
  await inAct(() => { expand.click() })
  assert.equal(strip.classList.contains('is-expanded'), true, 'expanding again still works')
})

test('the first-use guide\'s token step keeps the switchboard strip open through a pointer leave', async (t) => {
  const slug = 'switchboard-guide'
  beginFirstUse(slug)
  const view = await eye(slug, t)
  t.after(() => firstUseDismiss(slug)) // after the unmount, so the store change finds no card to update
  const card = view.el.querySelector<HTMLElement>('.sq.user')!
  const strip = card.querySelector<HTMLElement>('.hsof')!
  assert.equal(strip.classList.contains('is-expanded'), true, 'the guide opens the strip for the token step')
  await inAct(() => { leave(card, document.body) })
  assert.equal(strip.classList.contains('is-expanded'), true, 'the guide\'s forced-open strip stays open when the pointer leaves')
})
