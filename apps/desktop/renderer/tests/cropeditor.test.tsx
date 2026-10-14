import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { OrgPictureEditor } from '../src/canvas/orgpicture'

const response = (v: unknown) => new Response(JSON.stringify(v), { headers: { 'Content-Type': 'application/json' } })
async function setup(t: { after: (f: () => unknown) => void }) {
  const old = globalThis.fetch, sent: any[] = []
  t.after(() => { globalThis.fetch = old })
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith('/preview')) return response({ data: 'AQ==', width: 400, height: 200 })
    if (init?.method === 'POST') { sent.push(JSON.parse(String(init.body))); return response(null) }
    return response({ owner: 31, picture: null })
  }
  const view = await mountView(<OrgPictureEditor slug="one" />, el => el.textContent)
  t.after(() => view.unmount()); await inAct(() => flush())
  const input = view.el.querySelector('input[type=file]')!
  Object.defineProperty(input, 'files', { configurable: true, value: [{ size: 3, arrayBuffer: async () => Uint8Array.from([7, 8, 9]).buffer }] })
  await inAct(() => { input.dispatchEvent(new Event('change', { bubbles: true })) }); await inAct(() => flush())
  const stage = view.el.querySelector<HTMLElement>('.square-crop-stage')
  if (stage) stage.getBoundingClientRect = () => ({ left: 0, top: 0, width: 400, height: 200 } as DOMRect)
  for (const button of view.el.querySelectorAll<HTMLElement>('.square-crop button')) {
    button.setPointerCapture = () => {}; button.hasPointerCapture = () => false
  }
  const save = async () => { await inAct(() => [...view.el.querySelectorAll('button')].find(b => b.textContent === 'Save logo')!.click()); await inAct(() => flush()); return sent[0] }
  return { view, sent, save }
}
const key = (el: Element, name: string, shiftKey = false) => inAct(() => { el.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: name, shiftKey })) })
function pointer(el: Element, type: string, x: number, y: number, id = 1) {
  const e = new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0 })
  Object.defineProperty(e, 'pointerId', { value: id }); Object.defineProperty(e, 'pointerType', { value: 'touch' })
  return inAct(() => { el.dispatchEvent(e) })
}
test('crop editor replaces sliders with full image, four labeled handles and a live preview', async t => {
  const { view } = await setup(t)
  assert.equal(view.el.querySelectorAll('input[type=range]').length, 0)
  assert.equal(view.el.querySelectorAll('.square-crop-handle').length, 4)
  assert.ok(view.el.querySelector('img[alt="Full image for cropping"]'))
  assert.ok(view.el.querySelector('img[alt="Selected organization logo crop"]'))
})
test('keyboard crop reaches the unchanged original-data and numeric-owner save contract', async t => {
  const { view, save } = await setup(t), mover = view.el.querySelector('[aria-label="Move crop square"]')!
  assert.ok(mover)
  await key(mover, 'ArrowLeft', true); await key(mover, 'ArrowRight')
  const result = await save()
  assert.equal(result.owner, 31); assert.equal(result.data, 'BwgJ'); assert.equal(result.crop.size, .99)
  assert.ok(result.crop.x > .5); assert.equal(result.crop.y, .5)
})
test('touch handle resize and drag clamp, ignore second pointers, and stop on cancellation', async t => {
  const { view, save } = await setup(t), handle = view.el.querySelector('.square-crop-se')!
  assert.ok(handle)
  await pointer(handle, 'pointerdown', 300, 200); await pointer(handle, 'pointermove', 200, 100)
  await pointer(handle, 'pointerup', 200, 100)
  const mover = view.el.querySelector('.square-crop-move')!
  await pointer(mover, 'pointerdown', 150, 50)
  await pointer(mover, 'pointermove', -1000, -1000, 2)
  await pointer(mover, 'pointermove', 2000, 2000)
  await pointer(mover, 'pointercancel', 2000, 2000)
  await pointer(mover, 'pointermove', -1000, -1000)
  assert.deepEqual((await save()).crop, { x: 1, y: 1, size: .5 })
})
test('cancel discards crop without a mutation', async t => {
  const { view, sent } = await setup(t)
  await inAct(() => [...view.el.querySelectorAll('button')].find(b => b.textContent === 'Cancel crop')!.click())
  assert.equal(view.el.querySelector('img[alt="Selected organization logo crop"]'), null); assert.equal(sent.length, 0)
})
