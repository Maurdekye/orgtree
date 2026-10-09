// structuredjson.test.tsx — tool-call JSON renders as a structured view with
// a Raw toggle; huge payloads start collapsed past the first level; non-JSON
// is left to the caller. Run:  node apps/desktop/renderer/tests/run.mjs structuredjson

import test from 'node:test'
import assert from 'node:assert/strict'
import { flush, inAct, mountView } from './harness'
import { StructuredJson, parseStructured, countRows, ROW_LIMIT } from '../src/canvas/structuredjson'

const mount = (value: unknown, raw?: string) =>
  mountView(<StructuredJson value={value} raw={raw} />, el => el)

test('parseStructured only accepts objects and arrays', () => {
  assert.deepEqual(parseStructured('{"a":1}'), { a: 1 })
  assert.deepEqual(parseStructured(' [1,2] '), [1, 2])
  assert.equal(parseStructured('42'), undefined)
  assert.equal(parseStructured('"x"'), undefined)
  assert.equal(parseStructured('plain text'), undefined)
  assert.equal(parseStructured('{not json'), undefined)
})

test('nested objects, lists and multi-line strings render as rows', async () => {
  const v = { cmd: 'ls', opts: { deep: { n: 3 } }, list: ['a', 'b'], body: 'l1\nl2' }
  const view = await mount(v)
  try {
    const keys = [...view.el.querySelectorAll('.sj-key')].map(k => k.textContent)
    assert.deepEqual(keys, ['cmd', 'opts', 'deep', 'n', 'list', '0', '1', 'body'])
    assert.equal(view.el.querySelector('.sj-text')?.textContent, 'l1\nl2')
    // folding a group hides its children
    const fold = [...view.el.querySelectorAll('.sj-fold')]
      .find(f => f.textContent?.includes('opts')) as HTMLElement
    await inAct(() => { fold.click() })
    assert.ok(![...view.el.querySelectorAll('.sj-key')].some(k => k.textContent === 'deep'))
  } finally { await view.unmount() }
})

test('Raw toggle shows the JSON and goes back', async () => {
  const view = await mount({ a: { b: 1 } }, '{"a":{"b":1}}')
  try {
    const btn = view.el.querySelector('.sj-raw') as HTMLElement
    await inAct(() => { btn.click() }); await flush(2)
    assert.equal(view.el.querySelector('.sj-rawpre')?.textContent, '{"a":{"b":1}}')
    assert.equal(view.el.querySelectorAll('.sj-key').length, 0)
    await inAct(() => { btn.click() }); await flush(2)
    assert.equal(view.el.querySelectorAll('.sj-key').length, 2)
  } finally { await view.unmount() }
})

test('a payload over the row limit starts collapsed past the first level', async () => {
  const big = { items: Array.from({ length: ROW_LIMIT + 50 }, (_, i) => ({ id: i, tag: 't' })) }
  assert.ok(countRows(big) > ROW_LIMIT)
  const view = await mount(big)
  try {
    const keys = [...view.el.querySelectorAll('.sj-key')].map(k => k.textContent)
    assert.equal(keys[0], 'items')
    assert.equal(keys.length, 1 + big.items.length, 'first level only: the items, not their fields')
  } finally { await view.unmount() }
})

test('a clipped JSON result is closed at its last complete piece', () => {
  const clipped = '{"a":1,"rows":[{"id":1,"n":"x"},{"id":2,"n":"yy'
  assert.equal(parseStructured(clipped), undefined, 'strict parse refuses it')
  assert.deepEqual(parseStructured(clipped, true), { a: 1, rows: [{ id: 1, n: 'x' }, { id: 2 }] })
  assert.equal(parseStructured('{"a":"b\\"', true) !== undefined, true)
  assert.equal(parseStructured('not json at all', true), undefined)
})
