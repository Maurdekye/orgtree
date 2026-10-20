import { FakeServer, flush, inAct, installFetch, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { ComposerFocusFixture, seedComposer } from './composerfocus-fixture'
import { resetConvos } from '../src/convo'

async function type(el: HTMLTextAreaElement, text: string) {
  const set = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')!.set!
  await inAct(async () => {
    set.call(el, text); el.dispatchEvent(new window.Event('input', { bubbles: true })); await flush(5)
  })
}
const lines = (n: number) => Array.from({ length: n }, (_, i) => `Draft line ${i + 1}`).join('\n')

for (const surface of ['agent', 'project'] as const) for (const lineHeight of [20, 24]) {
  test(`${surface}: grows thirty extra rows at ${lineHeight}px, scrolls at the cap and shrinks on delete/send`, async t => {
    localStorage.clear(); resetConvos(); installFetch(new FakeServer()); seedComposer()
    const view = await mountView(<ComposerFocusFixture surface={surface} />, e => e)
    t.after(async () => { await view.unmount(); resetConvos() })
    const ta = view.el.querySelector<HTMLTextAreaElement>('.cc-composer textarea')!
    ta.style.lineHeight = `${lineHeight}px`; ta.style.padding = '0px'; ta.style.border = '0px'
    ta.style.boxSizing = 'content-box'
    Object.defineProperty(ta, 'scrollHeight', { configurable: true, get: () =>
      Math.max(Math.max(ta.rows, ta.value.split('\n').length) * lineHeight, parseFloat(ta.style.height) || 0) })
    await type(ta, lines(10))
    assert.equal(parseFloat(ta.style.height), 10 * lineHeight, 'ten lines must grow beyond the former 160px cap')
    assert.equal(ta.style.overflowY, 'hidden')
    await type(ta, lines(32))
    assert.equal(parseFloat(ta.style.height), (ta.rows + 30) * lineHeight, 'base rows plus thirty')
    await type(ta, lines(45))
    assert.equal(parseFloat(ta.style.height), (ta.rows + 30) * lineHeight, 'additional text stays within the cap')
    assert.equal(ta.style.overflowY, 'auto', 'overflow scrolls inside')
    await type(ta, '')
    assert.equal(parseFloat(ta.style.height), ta.rows * lineHeight, 'deleting restores base rows')
    assert.equal(ta.style.overflowY, 'hidden')
    await type(ta, lines(12))
    await inAct(async () => { view.el.querySelector<HTMLButtonElement>('.cc-send')!.click(); await flush(8) })
    assert.equal(ta.value, '', 'successful send clears the draft')
    assert.equal(parseFloat(ta.style.height), ta.rows * lineHeight, 'send restores base height without another keystroke')
  })
}
