import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { PilePicker } from '../src/canvas/modals'
import type { CanvasNode } from '../src/canvas/shared'

const node = (id: string) => ({ id, state: 'archived', tier: 'sol', children: [], turns: [] } as unknown as CanvasNode)
const pile = { key: 'boss|a', parent: 'boss', kind: 'a' as const, list: ['preview'], front: 'preview', total: 1401 }
async function fixture(t: test.TestContext, answer: (url: URL) => Promise<Response>, extra = {}) {
  const old = globalThis.fetch
  const urls: URL[] = []
  globalThis.fetch = (async input => { const url = new URL(String(input), 'http://fixture.invalid'); urls.push(url); return answer(url) }) as typeof fetch
  const props = { pile, map: new Map([['preview', node('preview')]]), close() {}, onPick() {}, ...extra, ...{ org: 'org' } }
  const view = await mountView(<PilePicker {...props} />, el => el.textContent)
  t.after(async () => { await view.unmount(); globalThis.fetch = old })
  await inAct(() => flush())
  return { ...view, el: document.body, urls }
}
const json = (rows: string[], next: string | null = null) => new Response(JSON.stringify({ agents: rows.map(node), next_cursor: next }), { headers: { 'content-type': 'application/json' } })
const names = (el: HTMLElement) => [...el.querySelectorAll('.pile-name')].map(e => e.textContent)
async function search(el: HTMLElement, value: string) {
  const input = el.querySelector<HTMLInputElement>('input[type="search"]')
  assert.ok(input, 'retired picker has server-side name search')
  await inAct(() => { Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })) })
  await inAct(() => new Promise(r => setTimeout(r, 300)))
  await inAct(() => flush())
}
test('opening reads one page independently of the partial canvas; scroll reads only the next page', async t => {
  const a = Array.from({ length: 50 }, (_, i) => `old-${i}`)
  const v = await fixture(t, async u => json(u.searchParams.get('cursor') ? ['last'] : a, u.searchParams.get('cursor') ? null : 'page2'))
  assert.equal(v.urls.length, 1, 'no eager drain')
  assert.match(v.urls[0]!.pathname, /\/retired$/)
  assert.equal(v.urls[0]!.searchParams.get('parent'), 'boss')
  assert.deepEqual(names(v.el), a)
  const rows = v.el.querySelector<HTMLElement>('.pile-rows')!
  Object.defineProperties(rows, { clientHeight: { value: 300 }, scrollHeight: { value: 1800 } })
  await inAct(() => { rows.scrollTop = 1450; rows.dispatchEvent(new Event('scroll')) })
  await inAct(() => flush())
  assert.equal(v.urls.length, 2)
  assert.equal(v.urls[1]!.searchParams.get('cursor'), 'page2')
  assert.deepEqual(names(v.el), [...a, 'last'])
})
test('name search reaches unloaded agents, clears old pages, and empty results are explicit', async t => {
  const v = await fixture(t, async u => json(u.searchParams.get('q') === 'needle' ? ['deep-needle'] : u.searchParams.get('q') ? [] : ['first'], 'next'))
  await search(v.el, 'needle')
  assert.deepEqual(names(v.el), ['deep-needle'])
  assert.equal(v.urls.at(-1)!.searchParams.get('cursor'), null)
  await search(v.el, 'missing')
  assert.deepEqual(names(v.el), [])
  assert.match(v.el.textContent ?? '', /No retired agents match/)
})
test('a delayed old page cannot replace a newer search or leak after close', async t => {
  let finish!: (r: Response) => void
  const v = await fixture(t, u => u.searchParams.get('q') ? Promise.resolve(json(['found'])) : new Promise(r => { finish = r }))
  await search(v.el, 'found')
  await inAct(async () => { finish(json(['stale'])); await flush() })
  assert.deepEqual(names(v.el), ['found'])
})
test('failed pages keep loaded rows and offer retry', async t => {
  let fail = true
  const v = await fixture(t, async () => fail ? new Response(JSON.stringify({ detail: 'offline' }), { status: 503 }) : json(['back']))
  assert.match(v.el.textContent ?? '', /offline/)
  const retry = [...v.el.querySelectorAll('button')].find(b => b.textContent === 'retry')
  assert.ok(retry)
  fail = false
  await inAct(() => retry.click()); await inAct(() => flush())
  assert.deepEqual(names(v.el), ['back'])
})
test('crowd stack stays local and keeps its existing ordering', async t => {
  const v = await fixture(t, async () => { throw new Error('crowd must not fetch') }, { pile: { ...pile, kind: 'c', list: ['one', 'two'], front: 'two' }, map: new Map([['one', node('one')], ['two', node('two')]]) })
  assert.equal(v.urls.length, 0)
  assert.deepEqual(names(v.el), ['two', 'one'])
})
test('delete all ignores the search and visits every page only after confirmation', async t => {
  const removed: string[] = [], notes: string[][] = []
  const v = await fixture(t, async u => json(u.searchParams.get('q') ? ['needle'] : u.searchParams.get('cursor') ? ['last'] : ['first'], u.searchParams.get('q') || u.searchParams.get('cursor') ? null : 'more'),
    { op: async (r: { node: string }) => { removed.push(r.node) }, toast: (n: string[]) => notes.push(n) })
  await search(v.el, 'needle')
  assert.deepEqual(removed, [])
  const wipe = [...v.el.querySelectorAll('button')].find(b => b.textContent?.includes('delete all 1401'))!
  assert.ok(wipe)
  await inAct(() => wipe.click())
  assert.deepEqual(removed, [])
  const confirm = [...v.el.querySelectorAll('button')].find(b => b.textContent === 'delete all')!
  assert.ok(confirm)
  await inAct(() => confirm.click()); await inAct(() => flush())
  assert.deepEqual(removed, ['first', 'last'])
  assert.match(notes.flat().join(' '), /2 of 2/)
})
test('picking a loaded page row works without adding it to the canvas map', async t => {
  const picked: string[] = []
  const v = await fixture(t, async () => json(['unloaded']), { onPick: (id: string) => picked.push(id) })
  await inAct(() => v.el.querySelector<HTMLButtonElement>('.pile-row')!.click())
  assert.deepEqual(picked, ['unloaded'])
})
