import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { OrgPictureEditor } from '../src/canvas/orgpicture'

const picture = { revision: 'r1', sha256: 'hash', data: 'AA==', width: 1, height: 1, bytes: 1 }
const response = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'Content-Type': 'application/json' } })
const settle = () => inAct(() => flush())
const button = (el: HTMLElement, label: string) => [...el.querySelectorAll('button')].find(b => b.textContent === label)!
async function select(el: HTMLElement, file: { size: number; arrayBuffer(): Promise<ArrayBuffer> }) {
  const input = el.querySelector('input[type=file]')!
  Object.defineProperty(input, 'files', { configurable: true, value: [file] })
  await inAct(() => { input.dispatchEvent(new Event('change', { bubbles: true })) })
  await settle()
}

test('editor remains disabled until the owning organization is loaded; removal carries its numeric owner', async t => {
  const old = globalThis.fetch; t.after(() => { globalThis.fetch = old })
  let resolve!: (r: Response) => void
  const pending = new Promise<Response>(r => { resolve = r })
  const sent: unknown[] = []
  globalThis.fetch = async (_url, init) => {
    if (init?.method === 'POST') { sent.push(JSON.parse(String(init.body))); return response({ ...picture, data: null, sha256: null }) }
    return pending
  }
  const view = await mountView(<OrgPictureEditor slug="one" />, el => el.textContent); t.after(() => view.unmount())
  assert.equal(view.el.querySelector<HTMLInputElement>('input[type=file]')!.disabled, true)
  await inAct(() => { resolve(response({ owner: 17, picture })) }); await settle()
  assert.equal(view.el.querySelector<HTMLInputElement>('input[type=file]')!.disabled, false)
  await inAct(() => { button(view.el, 'Remove picture').click() }); await settle()
  assert.equal((sent[0] as { owner: number }).owner, 17)
  assert.equal((sent[0] as { data: unknown }).data, null)
  assert.equal(view.el.querySelector('img'), null)
})

test('late previous-organization load cannot replace the current picture or edit owner', async t => {
  const old = globalThis.fetch; t.after(() => { globalThis.fetch = old })
  let resolve!: (r: Response) => void
  const pending = new Promise<Response>(r => { resolve = r })
  const sent: unknown[] = []
  globalThis.fetch = async (url, init) => {
    if (init?.method === 'POST') { sent.push(JSON.parse(String(init.body))); return response({ ...picture, data: null, sha256: null }) }
    return String(url).includes('/one/') ? pending : response({ owner: 22, picture: { ...picture, data: 'Ag==' } })
  }
  const view = await mountView(<OrgPictureEditor slug="one" />, el => el.textContent); t.after(() => view.unmount())
  await view.render(<OrgPictureEditor slug="two" />); await settle()
  await inAct(() => { resolve(response({ owner: 11, picture })) }); await settle()
  assert.equal(view.el.querySelector('img')!.getAttribute('src'), 'data:image/png;base64,Ag==')
  await inAct(() => { button(view.el, 'Remove picture').click() }); await settle()
  assert.equal((sent[0] as { owner: number }).owner, 22)
})

test('oversized selection is refused before reading or sending original bytes', async t => {
  const old = globalThis.fetch; t.after(() => { globalThis.fetch = old })
  const paths: string[] = []; let reads = 0
  globalThis.fetch = async url => { paths.push(String(url)); return response({ owner: 1, picture: null }) }
  const view = await mountView(<OrgPictureEditor slug="one" />, el => el.textContent); t.after(() => view.unmount()); await settle()
  await select(view.el, { size: 5 * 1024 * 1024 + 1, async arrayBuffer() { reads++; return new ArrayBuffer(0) } })
  assert.match(view.last()!, /up to 5 MiB/); assert.equal(reads, 0); assert.equal(paths.length, 1)
})

test('native preview is displayed and the selected original plus square crop reaches save', async t => {
  const old = globalThis.fetch; t.after(() => { globalThis.fetch = old })
  const sent: { url: string; body: Record<string, unknown> }[] = []
  globalThis.fetch = async (url, init) => {
    if (init?.method !== 'POST') return response({ owner: 31, picture: null })
    sent.push({ url: String(url), body: JSON.parse(String(init.body)) })
    return response(String(url).endsWith('/preview') ? { data: 'AQ==', width: 400, height: 200 } : picture)
  }
  const view = await mountView(<OrgPictureEditor slug="one" />, el => el.textContent); t.after(() => view.unmount()); await settle()
  await select(view.el, { size: 3, async arrayBuffer() { return Uint8Array.from([7, 8, 9]).buffer } })
  assert.equal(view.el.querySelector('img')!.getAttribute('src'), 'data:image/png;base64,AQ==')
  assert.equal(view.el.querySelector('img')!.style.width, '384px')
  await inAct(() => { button(view.el, 'Save picture').click() }); await settle()
  assert.equal(sent.length, 2); assert.match(sent[0].url, /\/preview$/)
  assert.deepEqual(sent[1].body, { owner: 31, data: 'BwgJ', crop: { x: .5, y: .5, size: 1 } })
})

test('a failed owner refresh disables editing until retry succeeds', async t => {
  const old = globalThis.fetch; t.after(() => { globalThis.fetch = old })
  let fail = false
  globalThis.fetch = async () => fail ? response({ detail: 'temporarily unavailable' }, 503) : response({ owner: 1, picture })
  const view = await mountView(<OrgPictureEditor slug="one" revision="r1" />, el => el.textContent); t.after(() => view.unmount()); await settle()
  fail = true; await view.render(<OrgPictureEditor slug="one" revision="r2" />); await settle()
  assert.equal(view.el.querySelector<HTMLInputElement>('input[type=file]')!.disabled, true)
  assert.equal(button(view.el, 'Remove picture'), undefined)
  fail = false; await inAct(() => { button(view.el, 'Retry').click() }); await settle()
  assert.equal(view.el.querySelector<HTMLInputElement>('input[type=file]')!.disabled, false)
})
