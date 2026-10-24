import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { textSelectionMenuEntries, useContextMenu } from '../src/canvas/contextmenu'

function Fixture() {
  const menu = useContextMenu()
  return <div><p onContextMenu={event => menu.open(event, textSelectionMenuEntries(event.currentTarget, 'captured passage'), undefined, { textSelection: true })}>captured passage</p>{menu.node}</div>
}

test('read-only text menu copies its captured selection and selects the originating document without its menu labels', async t => {
  const writes: string[] = []
  const prior = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => { writes.push(text) } } })
  t.after(() => { if (prior) Object.defineProperty(navigator, 'clipboard', prior); else delete (navigator as unknown as Record<string, unknown>).clipboard })
  const view = await mountView(<Fixture />, el => el); t.after(() => view.unmount())
  const text = view.el.querySelector('p')!, selected = document.getSelection()!
  t.after(() => selected.removeAllRanges())
  text.getBoundingClientRect = () => ({ left: 20, top: 20, right: 200, bottom: 60, x: 20, y: 20, width: 180, height: 40, toJSON() {} })
  const open = async () => {
    selected.selectAllChildren(text)
    await inAct(async () => { text.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: 40, clientY: 30 })); await flush(2) })
  }
  await open()
  const copy = document.querySelector<HTMLButtonElement>('[aria-label="Copy"]')!
  assert.ok(copy); assert.ok(copy.querySelector('.ctxmenu-shortcut')?.textContent?.includes('C'))
  await inAct(async () => { copy.click(); await flush(2) })
  assert.deepEqual(writes, ['captured passage'])
  await open()
  const all = document.querySelector<HTMLButtonElement>('[aria-label="Select All"]')!
  assert.ok(all); assert.ok(all.querySelector('.ctxmenu-shortcut')?.textContent?.includes('A'))
  await inAct(async () => { all.click(); await flush(5) })
  assert.ok(selected.toString().includes('captured passage'))
  assert.equal(document.querySelector('.ctxmenu'), null)
  assert.equal(selected.toString().includes('Select All'), false)
})
