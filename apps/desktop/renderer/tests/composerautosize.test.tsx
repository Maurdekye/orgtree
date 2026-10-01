import { FakeServer, fireResize, flush, inAct, installFetch, mountView, resizeWatchers } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { DeskChat } from '../src/canvas/desk'
import type { CanvasNode } from '../src/canvas/shared'
import { resetConvos } from '../src/convo'

const writer: CanvasNode = { id: 'writer', generation: 2, state: 'live', tier: 'haiku',
  children: [], seat: 1, grant: 0, free: 0, scope: { tools: {}, add_dirs: [] } }
const desk = (bare: boolean, compact: boolean) => <DeskChat node={writer}
  map={new Map([[writer.id, writer]])} slug="autosize" op={async () => ({})}
  toast={() => {}} pub={false} bare={bare} compact={compact} />

async function type(el: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')!.set!
  await inAct(async () => {
    setter.call(el, value)
    el.dispatchEvent(new window.Event('input', { bubbles: true }))
    await flush(3)
  })
}

for (const home of ['embedded', 'standalone', 'compact'] as const) {
  test(`${home} composer resizes with width and content, without feeding its height back`, async t => {
    localStorage.clear(); resetConvos(); installFetch(new FakeServer())
    const v = await mountView(desk(home !== 'standalone', home === 'compact'), el => el)
    const ta = v.el.querySelector('textarea')!
    let width = 105
    let reads = 0
    const intrinsic = () => !ta.value ? 39 : width < 200 ? 490 : 59
    Object.defineProperty(ta, 'clientWidth', { configurable: true, get: () => width })
    // Real scrollHeight cannot shrink below an assigned height. The reset to
    // auto is necessary: removing it makes the wide/empty assertions fail.
    Object.defineProperty(ta, 'scrollHeight', { configurable: true, get: () => {
      reads++
      return Math.max(intrinsic(), Number.parseInt(ta.style.height) || 0)
    } })
    t.after(async () => { await v.unmount(); resetConvos() })
    await type(ta, 'A draft that wraps to many lines at narrow width.')
    assert.equal(ta.style.height, '160px')
    assert.equal(resizeWatchers(ta), 1, 'one observer follows this composer')
    width = 778
    await inAct(() => fireResize(ta))
    assert.equal(ta.style.height, '59px', 'widening shrinks the same draft without typing')
    const readAtWidth = reads
    for (let i = 0; i < 10; i++) await inAct(() => fireResize(ta))
    assert.equal(reads, readAtWidth, 'height-only notifications do not measure or grow again')
    await v.render(desk(home !== 'standalone', home === 'compact'))
    assert.equal(ta.style.height, '59px', 'unrelated rerender keeps height constant')
    assert.equal(resizeWatchers(ta), 1, 'rerender does not reattach the observer')
    await type(ta, '')
    assert.equal(ta.style.height, '39px', 'removing text restores the normal height')
    ta.style.height = '160px'
    await inAct(() => { ta.focus(); ta.blur() })
    assert.equal(ta.style.height, '39px', 'blur clears stale height without changing the draft')
    await v.unmount()
    assert.equal(resizeWatchers(ta), 0, 'detaching cleans up its observer')
  })
}
