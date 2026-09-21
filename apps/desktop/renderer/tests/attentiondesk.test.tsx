// attentiondesk.test.tsx — the dynamic agent area's list behaviour.
//
// The ticket: "The agents list may be collapsed by default. When collapsed,
// hovering it rolls it out OVER the agent Desk rather than permanently
// consuming Desk width; it can retract after selection or hover ends without
// losing the selected agent." Two claims worth pinning separately, because
// each has its own way of going quietly wrong:
//
//   • rolling out must not change the DESK's layout — a list that pushed the
//     desk sideways on every hover is the "permanently consuming Desk width"
//     the ticket rules out, only worse, because it would reflow a live
//     composer under the reader's cursor;
//   • retracting must not disturb the SELECTION — a list that reset to the
//     default agent when the pointer left would make the collapse unusable.
//
// And one the ticket implies rather than states: the collapse must not make
// the list mouse-only. Focus rolls it out and holds it out, so the keyboard
// can reach every row.
//
// Run:  node apps/desktop/renderer/tests/run.mjs attentiondesk

import './harness'
import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import type { CanvasNode } from '../src/canvas/shared'
import { USER } from '../src/canvas/shared'
import type { OpFn, TreePayload } from '../src/types'
import { attentionLayout, forgetAttentionMode, setAttentionLayout } from '../src/attention/mode'
import { AgentDeskPanel } from '../src/attention/AgentDeskPanel'

const SLUG = 'org1'

const node = (id: string, parent: string | null, o: Partial<CanvasNode> = {}): CanvasNode => ({
  id, parent, tier: 'opus', state: 'live', generation: 0, children: [],
  seat: 1, grant: 10, free: 4, ...o,
} as CanvasNode)

const map = (): Map<string, CanvasNode> => new Map([
  node(USER, null, { tier: null, state: 'user' }),
  node('alpha', USER),
  node('beta', USER),
].map((n) => [n.id, n] as [string, CanvasNode]))

const tree = (): TreePayload => ({
  slug: SLUG, name: 'Org 1', epoch: 1, rev: 1, roots: [],
  work_items_summary: { attention: 0, active: 0 },
  user_inbox_count: 0, user_inbox_urgent_count: 0, asks: [], asks_open: 0,
  max_top_grant: 1000,
} as unknown as TreePayload)

const op: OpFn = () => Promise.resolve({ ok: true } as never)

function installQuietServer() {
  ;(globalThis as unknown as { fetch: unknown }).fetch = () => Promise.resolve({
    ok: true, status: 200, headers: new Headers(),
    json: () => Promise.resolve({ ok: true, messages: [], pending: [], delivered: [], sent: [] }),
  })
}

const reset = () => {
  localStorage.clear()
  forgetAttentionMode()
  installQuietServer()
}

const panel = () => <AgentDeskPanel slug={SLUG} tree={tree()} op={op} toast={() => {}}
  map={map()} />

const wrap = (el: HTMLElement) => el.querySelector('.attn-agents-wrap') as HTMLElement
const list = (el: HTMLElement) => el.querySelector('.attn-agents') as HTMLElement
const rowFor = (el: HTMLElement, id: string) =>
  el.querySelector(`[data-attn-agent="${id}"]`) as HTMLElement | null
const selectedRow = (el: HTMLElement) =>
  (el.querySelector('.attn-agent-row[aria-selected="true"]') as HTMLElement | null)
    ?.getAttribute('data-attn-agent') ?? null

const settle = async () => { await inAct(() => flush(8)) }

/** ⚠ REACT SYNTHESIZES enter/leave FROM `pointerover`/`pointerout`, and does
 *  not listen for `pointerenter`/`pointerleave` at all — those do not bubble,
 *  so there is nothing for a delegating root to hear. Dispatching the pair
 *  React actually listens to is what makes this a test of the hover and not of
 *  the test's own event names; dispatching `pointerenter` passes §3 and §4
 *  vacuously, because the list simply never opens. */
const hover = (el: HTMLElement, over: boolean) => inAct(() => {
  el.dispatchEvent(new window.MouseEvent(over ? 'pointerover' : 'pointerout',
    { bubbles: true, relatedTarget: null }))
})

test('§1 the list is collapsed by default and the desk is not narrowed for it', async () => {
  reset()
  const v = await mountView(panel(), () => wrap(document.body as HTMLElement))
  await settle()
  const el = v.el
  assert.equal(wrap(el).className.includes('list-open'), false,
    'collapsed until something rolls it out')
  assert.ok(list(el), 'and it is in the document while collapsed, so focus can reach it')

  // ⚠ THE DESK SUBTREE IS NOT TOUCHED BY THE ROLL-OUT, and that is the
  // structural half of "rather than permanently consuming Desk width". jsdom
  // does no layout, so the width itself cannot be measured here — but the
  // thing that WOULD cost width is the list entering the desk's flow, and that
  // would re-parent or rebuild the desk. Holding the element identity across
  // the roll-out is the falsifiable version of the claim; the CSS that makes
  // it an overlay is in attention.css and is checked in the real renderer.
  const desk = el.querySelector('.attn-desk') as HTMLElement
  const deskParent = desk.parentElement
  await hover(list(el), true)
  assert.equal(wrap(el).className.includes('list-open'), true)
  assert.equal(el.querySelector('.attn-desk'), desk,
    'the desk is the same element — nothing about it was rebuilt to make room')
  assert.equal(desk.parentElement, deskParent, 'and it did not move in the tree')
  await v.unmount()
})

test('§2 hovering rolls it out, and leaving retracts it', async () => {
  reset()
  const v = await mountView(panel(), () => '')
  await settle()
  const el = v.el
  await hover(list(el), true)
  assert.equal(wrap(el).className.includes('list-open'), true, 'hover rolls it out')
  await hover(list(el), false)
  assert.equal(wrap(el).className.includes('list-open'), false, 'and leaving retracts it')
  await v.unmount()
})

test('§3 retracting keeps the selected agent and its desk', async () => {
  reset()
  const v = await mountView(panel(), () => '')
  await settle()
  const el = v.el
  assert.equal(selectedRow(el), 'alpha', 'opens on the leftmost top-level agent')

  await hover(list(el), true)
  await inAct(() => { rowFor(el, 'beta')!.click() })
  await settle()
  assert.equal(selectedRow(el), 'beta', 'clicking an agent replaces the open Desk')
  assert.equal(wrap(el).className.includes('list-open'), false,
    'a selection is a decision — the list retracts behind it')
  assert.equal(attentionLayout(SLUG).agent, 'beta', 'and the choice is remembered')

  await hover(list(el), true)
  await hover(list(el), false)
  assert.equal(selectedRow(el), 'beta',
    'hovering and leaving again does not reset the selection')
  await v.unmount()
})

test('§4 the toggle holds it open across hover and selection', async () => {
  reset()
  const v = await mountView(panel(), () => '')
  await settle()
  const el = v.el
  const toggle = el.querySelector('.attn-agents-toggle') as HTMLElement
  assert.equal(toggle.getAttribute('aria-expanded'), 'false')
  await inAct(() => { toggle.click() })
  assert.equal(wrap(el).className.includes('list-open'), true)
  assert.equal(toggle.getAttribute('aria-expanded'), 'true')

  await inAct(() => { rowFor(el, 'beta')!.click() })
  await settle()
  assert.equal(wrap(el).className.includes('list-open'), true,
    'a list the user deliberately opened is not closed by their next click in it')
  assert.equal(attentionLayout(SLUG).listOpen, true, 'and that choice is remembered too')
  await v.unmount()
})

test('§5 the keyboard can drive the list while it is collapsed', async () => {
  reset()
  const v = await mountView(panel(), () => '')
  await settle()
  const el = v.el
  // focus rolls it out — a collapse that made the list mouse-only would be a
  // control the keyboard cannot reach at all
  await inAct(() => {
    list(el).dispatchEvent(new window.Event('focusin', { bubbles: true }))
  })
  assert.equal(wrap(el).className.includes('list-open'), true)

  const key = (k: string) => inAct(() => {
    list(el).dispatchEvent(new window.KeyboardEvent('keydown', { key: k, bubbles: true }))
  })
  await key('ArrowDown')
  await settle()
  assert.equal(selectedRow(el), 'beta', 'ArrowDown moves to the next agent')
  await key('ArrowUp')
  await settle()
  assert.equal(selectedRow(el), 'alpha')
  assert.equal(list(el).getAttribute('role'), 'listbox')
  assert.equal(rowFor(el, 'alpha')!.getAttribute('role'), 'option')
  await v.unmount()
})

test('§6 a stored selection survives a remount; a stale one falls back', async () => {
  reset()
  setAttentionLayout(SLUG, { agent: 'beta' })
  const v = await mountView(panel(), () => '')
  await settle()
  assert.equal(selectedRow(v.el), 'beta', 'the organization reopens on the agent it was left on')
  await v.unmount()

  // the agent is gone from the organization — the view must not open on a
  // desk that does not exist, and must not rewrite the stored choice either
  setAttentionLayout(SLUG, { agent: 'a-retired-agent' })
  const v2 = await mountView(panel(), () => '')
  await settle()
  assert.equal(selectedRow(v2.el), 'alpha', 'it falls back to the default agent')
  assert.equal(attentionLayout(SLUG).agent, 'a-retired-agent',
    'without overwriting a choice that may simply belong to data still loading')
  await v2.unmount()
})
