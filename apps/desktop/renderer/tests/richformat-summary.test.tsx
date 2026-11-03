// C4 + RT-8 (spec §2.2, R8): the project Summary in read mode renders rich text;
// a chip click opens the mention and does NOT enter edit mode, a text click does.
import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { DescriptionEditor } from '../src/canvas/projectdesk'
import type { CanvasNode } from '../src/canvas/shared'
import { RICH, expectRich, opened, refs } from './fixtures/richformat'

const node = { id: 'proj-one', state: 'live', kind: 'project', charter: RICH, children: [] } as unknown as CanvasNode
const mount = async () => {
  const view = await mountView(<DescriptionEditor node={node} op={async () => ({})} toast={() => {}} editable refs={refs} />, el => el)
  await inAct(async () => { await flush(2) })
  return view
}

test('RT-C4 the Summary in read mode renders Markdown, LaTeX and mentions', async t => {
  const view = await mount()
  t.after(() => view.unmount())
  const body = view.el.querySelector('.project-description-md')
  assert.ok(body)
  expectRich(body!)
})

test('RT-8 a chip click opens the mention without entering edit mode; a text click edits', async t => {
  const view = await mount()
  t.after(() => view.unmount())
  opened.length = 0
  const chip = view.el.querySelector('[data-ref-token="@item:t/sample-item"]') as HTMLElement
  assert.ok(chip, 'the item chip is there')
  await inAct(async () => {
    chip.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))
    chip.focus?.()
    chip.click()
    await flush(2)
  })
  assert.equal(view.el.querySelector('textarea'), null, 'a chip click did not open the editor')
  assert.equal(opened.length, 1, 'it opened the mention instead')
  const bold = view.el.querySelector('.project-description-md strong') as HTMLElement
  await inAct(async () => {
    bold.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))
    bold.click()
    await flush(2)
  })
  assert.ok(view.el.querySelector('textarea'), 'a click on plain text opens the editor')
})
