// attentiondeskwindow.test.tsx — A POPPED-OUT DESK CAN BECOME ITS OWN ATTENTION DESK.
//
// USER 2026-11-15 10:34:16Z mbf1f1ca2cfe9 (4.6.1, @item:orgtree/popped-out-desk-can-become-its-own-attention-des):
// "allow any popped out desk to be turned into a separate \"attention desk\", where it gains the agents list popout
// that can change the active agent viewed in it. it should look and function identically to the normal attention
// desk. this should allow the user to have multiple simultaneous attention desks open if they wish."
//
// The window draws the Attention view's own agent desk (`AgentDeskPanel`: the agents drawer and the desk), with a
// selection of its own: switching it never moves the main Attention desk. Design: design-461-desk-views.md §3.
import './harness'
import { FakeServer, flush, inAct, installFetch, mountView } from './harness'
import { installBridge, removeBridge } from './shellbridge'
import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import { resetConvos } from '../src/convo'
import { DeskHosts, DeskSlot } from '../src/canvas/deskhosts'
import { USER } from '../src/canvas/shared'
import type { CanvasNode, OpFn } from '../src/canvas/shared'
import { AttentionDeskWindows, attentionDeskWindows, forgetAttentionDeskWindows, openAttentionDeskWindow } from '../src/attention/deskwindows'
import { forgetAttentionMode, attentionLayout } from '../src/attention/mode'
import { CurrentOrg } from '../src/popout'
import { openSurfaces, resetActionDocument } from '../src/windowlife'
import { endWindowExit } from '../src/windowlayout'
import type { TreePayload } from '../src/types'

const SLUG = 'attn-windows-org'
const noop = () => {}
const op: OpFn = async () => ({})
const mk = (id: string) => ({ id, parent: USER, tier: 'opus', state: 'live', generation: 0,
  children: [], seat: 1, grant: 0, free: 0, scope: { tools: {}, add_dirs: [] } } as unknown as CanvasNode)
const alpha = mk('alpha'), beta = mk('beta')
const map = new Map<string, CanvasNode>([[USER, { id: USER, parent: null, tier: null, state: 'user',
  children: ['alpha', 'beta'] } as unknown as CanvasNode], ['alpha', alpha], ['beta', beta]])
const tree = { slug: SLUG, name: 'Attention windows fixture', epoch: 1, rev: 1, roots: [],
  work_items_summary: { attention: 0, active: 0 }, user_inbox_count: 0, user_inbox_urgent_count: 0,
  asks: [], asks_open: 0, max_top_grant: 1000 } as unknown as TreePayload

/** every window.open gets a fresh child document, as the native shell does */
function stage(t: TestContext) {
  localStorage.clear(); forgetAttentionMode(); forgetAttentionDeskWindows(); resetConvos(); resetActionDocument(); endWindowExit()
  installFetch(new FakeServer())
  const children: Window[] = []
  const originalOpen = window.open
  const originalObserver = globalThis.MutationObserver
  window.open = (() => {
    const dom = new JSDOM('<html><head></head><body></body></html>', { url: 'http://localhost/' })
    const w = dom.window as unknown as Window
    Object.defineProperties(w, { screenX: { value: 200 }, screenY: { value: 180 }, outerWidth: { value: 830 },
      outerHeight: { value: 700 }, closed: { value: false, writable: true } })
    w.focus = noop; w.requestAnimationFrame = () => 1; w.cancelAnimationFrame = noop
    w.close = () => { (w as unknown as { closed: boolean }).closed = true; w.dispatchEvent(new dom.window.Event('pagehide')) }
    globalThis.MutationObserver = dom.window.MutationObserver
    children.push(w)
    return w
  }) as typeof window.open
  installBridge({ minimizePopout: async () => {}, toggleMaximizePopout: async () => {}, closePopout: async () => {} })
  t.after(() => { window.open = originalOpen; globalThis.MutationObserver = originalObserver; removeBridge(); localStorage.clear() })
  const open = () => children.filter((w) => !(w as unknown as { closed: boolean }).closed)
  return { children, open }
}
const scene = () => <CurrentOrg.Provider value={SLUG}>
  <DeskHosts map={map} slug={SLUG} popoutDesk={(node) => ({ node, map, op, slug: SLUG, toast: noop })}>
    <div data-which="card"><DeskSlot node={alpha} map={map} op={op} slug={SLUG} toast={noop} bare openIn="card" /></div>
    <AttentionDeskWindows slug={SLUG} tree={tree} map={map} op={op} toast={noop} />
  </DeskHosts>
</CurrentOrg.Provider>
async function click(el: Element | null | undefined) {
  assert.ok(el, 'control: the control exists')
  await inAct(async () => { (el as HTMLElement).click(); await flush(8) })
}
const deskAgent = (doc: Document | HTMLElement) => {
  const key = doc.querySelector('[data-desk-slot]')?.getAttribute('data-desk-slot')
  return key ? (JSON.parse(key) as [string, string, number])[1] : null
}
const attentionDesk = (doc: Document) => doc.querySelector('.attn-agents-toggle') !== null

test('a popped-out desk turns into an attention desk: the agents drawer and the same agent\'s desk', async (t) => {
  const s = stage(t)
  const v = await mountView(scene(), (el) => el)
  t.after(() => v.unmount())
  await inAct(async () => { await flush(8) })
  await click(v.el.querySelector('[data-which="card"] button[aria-label="Open in new window"]'))
  assert.equal(s.open().length, 1, 'control: the desk window opened')
  const plain = s.open()[0]!.document
  assert.equal(attentionDesk(plain), false, 'control: a plain desk window has no agents drawer')
  const toggle = plain.querySelector('.cc-head-right button.popout-button[aria-label="Make attention desk"]')
  assert.ok(toggle, 'the toggle is a header icon beside the pop-out button')
  assert.equal(toggle!.getAttribute('aria-pressed'), 'false')
  assert.equal(toggle!.getAttribute('title'), 'Make attention desk')
  await click(toggle)
  assert.equal(s.open().length, 1, 'one window: the plain desk window became the attention desk')
  const win = s.open()[0]!.document
  assert.equal(attentionDesk(win), true, 'the window has the Attention desk\'s agents drawer')
  assert.equal(deskAgent(win), 'alpha', 'on the agent it was showing')
  assert.deepEqual(attentionDeskWindows(SLUG).map((w) => w.agent), ['alpha'], 'it is remembered with its agent')
  const pressed = win.querySelector('.cc-head-right button.popout-button[aria-label="Make plain desk"]')
  assert.ok(pressed, 'the same header icon is there, now to make it a plain desk')
  assert.equal(pressed!.getAttribute('aria-pressed'), 'true')
  assert.equal(pressed!.getAttribute('title'), 'Make plain desk')
  assert.equal(openSurfaces().some((x) => x.kind.startsWith('desk:')), false, 'the plain desk window is gone')
})

test('its drawer switches ITS desk; the main Attention desk\'s selection does not move', async (t) => {
  const s = stage(t)
  const v = await mountView(scene(), (el) => el)
  t.after(() => v.unmount())
  await inAct(async () => { openAttentionDeskWindow(SLUG, 'alpha'); await flush(8) })
  assert.equal(s.open().length, 1, 'the attention desk window opened')
  const win = s.open()[0]!.document
  assert.equal(deskAgent(win), 'alpha', 'control: the window opened on alpha')
  await click(win.querySelector('.attn-agents-toggle'))
  await click(win.querySelector('[data-attn-agent="beta"]'))
  assert.equal(deskAgent(win), 'beta', 'the window now shows beta')
  assert.deepEqual(attentionDeskWindows(SLUG).map((w) => w.agent), ['beta'], 'and remembers beta')
  assert.equal(attentionLayout(SLUG).agent, null, 'the main Attention desk was not switched')
})

test('several attention desks are open at once, each on its own agent', async (t) => {
  const s = stage(t)
  const v = await mountView(scene(), (el) => el)
  t.after(() => v.unmount())
  await inAct(async () => { openAttentionDeskWindow(SLUG, 'alpha'); await flush(8) })
  await inAct(async () => { openAttentionDeskWindow(SLUG, 'beta'); await flush(8) })
  assert.equal(s.open().length, 2, 'two windows')
  assert.deepEqual(s.open().map((w) => deskAgent(w.document)).sort(), ['alpha', 'beta'])
  assert.equal(s.open().every((w) => attentionDesk(w.document)), true, 'both are attention desks')
})

test('Make plain desk turns it back into a plain desk window on the agent it shows', async (t) => {
  const s = stage(t)
  const v = await mountView(scene(), (el) => el)
  t.after(() => v.unmount())
  await inAct(async () => { openAttentionDeskWindow(SLUG, 'beta'); await flush(8) })
  assert.equal(s.open().length, 1, 'the attention desk window opened')
  await click(s.open()[0]!.document.querySelector('button[aria-label="Make plain desk"]'))
  assert.equal(s.open().length, 1, 'one window')
  const win = s.open()[0]!.document
  assert.equal(attentionDesk(win), false, 'no agents drawer any more')
  assert.equal(deskAgent(win), 'beta', 'the desk is the agent it was showing')
  assert.deepEqual(attentionDeskWindows(SLUG), [], 'it is no longer an attention desk window')
})
