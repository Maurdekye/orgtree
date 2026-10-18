import { FakeServer, fireResize, flush, inAct, installFetch, JSDOM, mountView } from './harness'
import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { createPortal } from 'react-dom'
import { DeskChat } from '../src/canvas/desk'
import type { CanvasNode } from '../src/canvas/shared'
import { refreshConvo, resetConvos } from '../src/convo'
import { SurfaceDocumentOwner } from '../src/popout'

async function fixture(t: TestContext, host = 'desk') {
  resetConvos(); localStorage.clear()
  const server = new FakeServer(); server.assistantMsg('First result'); installFetch(server)
  const node: CanvasNode = { id: 'writer', generation: 1, state: 'live', tier: 'haiku',
    children: [], seat: 1, grant: 0, free: 0, scope: { tools: {}, add_dirs: [] } }
  const popup = host === 'popped-out' ? new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' }) : null
  const doc = popup?.window.document ?? document
  const body = <div data-frame={host}><DeskChat node={node} map={new Map([[node.id, node]])}
    slug="org" bare={host !== 'desk'} op={async () => ({})} toast={() => {}} /></div>
  const view = await mountView(popup
    ? <SurfaceDocumentOwner owner={doc}>{createPortal(body, doc.body)}</SurfaceDocumentOwner>
    : body, el => el)
  t.after(async () => { await view.unmount(); popup?.window.close(); resetConvos() })
  const frame = doc.querySelector<HTMLElement>('[data-frame]')!
  await inAct(async () => { await refreshConvo('org', node.id, { force: true }); await flush(5) })
  const list = frame.querySelector<HTMLElement>('.msgs-wrap .msgs')!
  assert.ok(list, 'real DeskChat transcript mounted')
  let height = 1200, top = 0, now = 10_000
  t.mock.method(performance, 'now', () => now)
  Object.defineProperties(list, {
    clientHeight: { configurable: true, get: () => 400 },
    scrollHeight: { configurable: true, get: () => height },
    scrollTop: { configurable: true, get: () => top,
      set: (v: number) => { top = Math.max(0, Math.min(v, height - 400)) } },
  })
  await inAct(() => { fireResize(list) })
  assert.equal(top, 800, 'fixture starts pinned with browser-like clamping')
  const scroll = async (next: number) => inAct(async () => {
    list.scrollTop = next; list.dispatchEvent(new doc.defaultView!.Event('scroll', { bubbles: true })); await flush(3)
  })
  const wheel = async (deltaY: number) => inAct(() => {
    list.dispatchEvent(new doc.defaultView!.WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY }))
  })
  const jump = () => !!frame.querySelector('.jumpbottom')
  const detach = async () => { await wheel(-1); await scroll(400); assert.equal(jump(), true) }
  const grow = async () => inAct(async () => {
    height += 200; server.assistantMsg('Another result'); await refreshConvo('org', node.id, { force: true }); await flush(5)
  })
  return { frame, list, scroll, wheel, jump, detach, grow, bottom: () => height - 400,
    elapse: (ms: number) => { now += ms }, resize: async (nextHeight: number) => inAct(() => {
      height = nextHeight; list.scrollTop = top; fireResize(list)
    }) }
}

for (const host of ['desk', 'pinned', 'popped-out']) {
  test(`${host}: hand scrolling within 8px of the tail hides the card and follows new output`, async t => {
    const f = await fixture(t, host)
    await f.detach()
    await f.wheel(1); await f.scroll(f.bottom() - 4)
    assert.equal(f.jump(), false, 'near-tail downward movement resumes follow')
    await f.grow()
    assert.equal(f.list.scrollTop, f.bottom(), 'new output stays pinned')
    assert.equal(f.frame.scrollTop, 0, 'only the transcript list scrolls')
    await f.detach()
    await f.grow()
    assert.equal(f.list.scrollTop, 400, 'scrolling up detaches again')
    assert.equal(f.jump(), true)
  })
}

test('downward momentum can reach the tail after the one-second input window expires', async t => {
  const f = await fixture(t)
  await f.detach(); await f.wheel(1); await f.scroll(600)
  f.elapse(1500)
  await f.scroll(f.bottom())
  assert.equal(f.jump(), false, 'the final downward scroll still belongs to the reader')
  await f.grow()
  assert.equal(f.list.scrollTop, f.bottom())
})

test('layout-only clamping to the tail does not resume follow after upward input', async t => {
  const f = await fixture(t)
  await f.detach()
  f.elapse(1500)
  await f.resize(800); await f.scroll(400)
  assert.equal(f.jump(), true)
  await f.grow()
  assert.equal(f.list.scrollTop, 400, 'content growth cannot claim a manual return to the bottom')
})

test('downward input far from the tail and input cancelled by blur do not reattach', async t => {
  const f = await fixture(t)
  await f.detach(); await f.wheel(1); await f.scroll(f.bottom() - 20)
  assert.equal(f.jump(), true, '8px is a small threshold, not a broad near-bottom zone')
  await inAct(() => { window.dispatchEvent(new Event('blur')) })
  await f.scroll(f.bottom())
  assert.equal(f.jump(), true, 'blur ends the downward gesture')
})
