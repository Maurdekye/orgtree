import { FakeServer, flush, inAct, installFetch, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { DeskChat } from '../src/canvas/desk'
import type { CanvasNode } from '../src/canvas/shared'
import { resetConvos } from '../src/convo'

test('live event menu anchors on its pressed text instead of the contents wrapper', async t => {
  const prior = globalThis.fetch
  const server = new FakeServer(); server.busy = true
  server.live = [{ kind: 'text', text: 'live passage', n: 1, event_id: 'live-e1' }]
  installFetch(server); resetConvos()
  t.after(() => { globalThis.fetch = prior; resetConvos() })
  const node: CanvasNode = { id: 'writer', generation: 1, state: 'live', tier: 'sol', children: [], seat: 1, grant: 0, free: 0, scope: { tools: {}, add_dirs: [] } }
  const view = await mountView(<DeskChat node={node} map={new Map([[node.id, node]])} slug="demo" op={async () => ({})} toast={() => {}} bare />, el => el)
  t.after(() => view.unmount())
  await inAct(async () => { await flush(5) })
  const wrapper = view.el.querySelector<HTMLElement>('.reply-event')!
  assert.ok(wrapper, 'a real live transcript row rendered')
  // jsdom does not load styles.css; model its .reply-event display rule.
  wrapper.style.display = 'contents'
  const text = wrapper.querySelector<HTMLElement>('.md p')!
  assert.ok(text)
  text.getBoundingClientRect = () => ({ x: 420, y: 180, left: 420, top: 180, right: 700, bottom: 230, width: 280, height: 50, toJSON() {} })
  document.getSelection()?.removeAllRanges()
  await inAct(async () => { text.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: 460, clientY: 210 })); await flush(2) })
  const menu = document.querySelector<HTMLElement>('.ctxmenu')!
  assert.ok(menu)
  assert.ok(menu.textContent?.includes('Copy contents'))
  assert.deepEqual({ x: parseFloat(menu.style.left), y: parseFloat(menu.style.top) }, { x: 460, y: 210 })
})
