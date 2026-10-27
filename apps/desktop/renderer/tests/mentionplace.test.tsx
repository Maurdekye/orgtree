// mentionplace.test.tsx — WHERE THE @ LIST OPENS (4.5.0 alpha.5 hands-on check,
// 2026-10-27: in Quick chat at the top of the window the list opened upward,
// off the screen). With room above its box the list stays there, the best match
// next to the box; with too little room above it opens below, the other way up,
// and the arrows follow the screen. jsdom lays nothing out, so each box is
// placed by hand; the rig capture (tools/rig/proofs/mention-menu.mjs) measures
// the real window.
//
// Run:  cd apps/desktop/renderer && node tests/run.mjs mentionplace
import { flush, inAct, mountView } from './harness'
import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { QuickChat } from '../src/QuickChatBox'
import { legacyAppBackend } from './appfeed-fixture'
import { MENTION_LIST_MAX, placeMentionList } from '../src/canvas/agentmentions'
import type { TreePayload } from '../src/types'

test('the list opens above its box when it fits there, else below, never past the window', () => {
  // Quick chat in the header (measured in the alpha.5 rig: y 15, 26 high)
  const header = placeMentionList({ left: 219, top: 15, bottom: 41, width: 294 }, 760)
  assert.deepEqual(header, { left: 219, width: 294, maxHeight: MENTION_LIST_MAX, below: true, top: 45 })
  // a desk composer at the bottom: above, as before
  const desk = placeMentionList({ left: 290, top: 667, bottom: 694, width: 495 }, 760)
  assert.deepEqual(desk, { left: 290, width: 320, maxHeight: MENTION_LIST_MAX, below: false, bottom: 97 })
  // a box in a short window: the bigger side, and never taller than the room it has
  const short = placeMentionList({ left: 4, top: 150, bottom: 176, width: 100 }, 300)
  assert.equal(short.below, false)
  assert.equal(short.maxHeight, 138)
  assert.equal(short.left, 8)
  assert.equal(short.width, 180)
  const low = placeMentionList({ left: 10, top: 90, bottom: 116, width: 200 }, 300)
  assert.equal(low.below, true)
  assert.equal(low.maxHeight, 172)
  // no layout (jsdom, a hidden composer): above, as before
  assert.equal(placeMentionList({ left: 0, top: 0, bottom: 0, width: 0 }, 768).below, false)
})

const node = (id: string, kind = 'agent') => ({ id, state: 'live', kind, tier: kind === 'project' ? 'project' : 'haiku', children: [] })
const tree = { slug: 'org', roots: [node('worker-alpha'), node('worker-beta'), node('worker-gamma')] } as unknown as TreePayload
const type = async (box: HTMLInputElement, value: string) => inAct(async () => {
  Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(box, value)
  box.dispatchEvent(new window.Event('input', { bubbles: true }))
  box.setSelectionRange(value.length, value.length)
  box.dispatchEvent(new window.Event('select', { bubbles: true }))
  await flush(5)
})
const press = async (box: HTMLInputElement, key: string) => inAct(async () => {
  box.dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
  await flush(3)
})
const active = () => document.querySelector('.agent-mentions .agent-mention-item.active .agent-mention-name')?.textContent
const names = () => [...document.querySelectorAll('.agent-mentions .agent-mention-name')].map(n => n.textContent)

async function quickChat(t: TestContext, box: { top: number; bottom: number }) {
  const old = globalThis.fetch
  globalThis.fetch = legacyAppBackend((async () => ({ ok: true, status: 200, headers: new Headers(), json: async () => ({ providers: [] }) })) as typeof fetch)
  t.after(() => { globalThis.fetch = old })
  const view = await mountView(<QuickChat slug="org" tree={tree} op={async () => ({} as never)} toast={() => {}} onHired={() => {}} />, h => h)
  t.after(() => view.unmount())
  const input = view.el.querySelector<HTMLInputElement>('.quickchat-input')!
  input.getBoundingClientRect = () => ({ left: 219, right: 513, width: 294, top: box.top, bottom: box.bottom, height: box.bottom - box.top,
    x: 219, y: box.top, toJSON: () => ({}) }) as DOMRect
  return input
}

test('Quick chat in the header: the list opens below the box, best match next to it, arrows follow the screen', async t => {
  const box = await quickChat(t, { top: 15, bottom: 41 })
  await type(box, 'Ask @worker-')
  const list = document.querySelector<HTMLElement>('.agent-mentions')!
  assert.ok(list, '@ opens the list')
  assert.ok(list.classList.contains('below'), 'below the box')
  assert.equal(list.style.top, '45px')
  assert.equal(list.style.bottom, '')
  // the best match is the last entry; .below shows it first, next to the box
  const order = names()
  assert.equal(active(), order[order.length - 1], 'the best match starts highlighted')
  await press(box, 'ArrowDown')
  assert.equal(active(), order[order.length - 2], 'ArrowDown moves down the screen, away from the box')
  await press(box, 'ArrowUp')
  assert.equal(active(), order[order.length - 1], 'ArrowUp moves back up')
  await press(box, 'Tab')
  assert.equal(box.value, `Ask ${order[order.length - 1]} `)
})

test('a composer at the bottom keeps its list above, arrows as before', async t => {
  const box = await quickChat(t, { top: 700, bottom: 726 })
  await type(box, 'Ask @worker-')
  const list = document.querySelector<HTMLElement>('.agent-mentions')!
  assert.ok(list && !list.classList.contains('below'), 'above the box')
  assert.equal(list.style.bottom, `${window.innerHeight - 700 + 4}px`)
  assert.equal(list.style.top, '')
  const order = names()
  assert.equal(active(), order[order.length - 1])
  await press(box, 'ArrowUp')
  assert.equal(active(), order[order.length - 2], 'ArrowUp moves up the screen, away from the box')
})
