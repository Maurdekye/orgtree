// RT-0: the shared pipeline (md() -> KaTeX -> mention chips -> DOMPurify) renders
// the spec's fixture with the full mention set. Green at the base: it guards the
// pipeline every converted surface relies on (spec G4/G5).
import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { RefMdBody } from '../src/canvas/refmd'
import { md } from '../src/canvas/shared'
import { RICH, RICH_DISPLAY, expectRich, onOpen, world } from './fixtures/richformat'

test('RT-0 the fixture renders Markdown, LaTeX and the mention set through RefMdBody', async t => {
  const view = await mountView(<RefMdBody html={md(RICH)} world={world} onOpen={onOpen} />, el => el)
  t.after(() => view.unmount())
  await inAct(async () => { await flush(2) })
  expectRich(view.el)
  const tokens = [...view.el.querySelectorAll('[data-ref-token]')].map(c => c.getAttribute('data-ref-token'))
  console.log('RT-0 chips:', JSON.stringify(tokens))
  assert.ok(view.el.querySelector('[data-hub-address]'), '@net: gives a hub-address chip')
  assert.ok(view.el.querySelector('[data-user-identity]'), '@user gives a user identity link')
})

test('RT-0 display math renders as .katex-display', async t => {
  const view = await mountView(<RefMdBody html={md(RICH_DISPLAY)} world={world} onOpen={onOpen} />, el => el)
  t.after(() => view.unmount())
  await inAct(async () => { await flush(2) })
  assert.ok(view.el.querySelector('.katex-display'))
})
