// attentiondesk.test.tsx — the dynamic agent area's list behaviour.
//
// The list is a DRAWER opened only by a click (user 2026-09-29, image-28:
// "it shouldn't appear on hover, only when the button is clicked … it should
// darken the desk while out"). What is pinned here:
//
//   • hover opens nothing, anywhere — not the list, not the button;
//   • the button opens it and closes it; the scrim and Escape close it;
//   • opening it must not change the DESK's layout (it is drawn over the
//     desk, under a scrim) and closing it must not disturb the SELECTION;
//   • shut, it is `inert`, so the keyboard reaches it through the button.
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
 *  React actually listens to is what makes "hover opens nothing" a test of the
 *  hover and not of the test's own event names. */
const hover = (el: HTMLElement, over: boolean) => inAct(() => {
  el.dispatchEvent(new window.MouseEvent(over ? 'pointerover' : 'pointerout',
    { bubbles: true, relatedTarget: null }))
})
const toggle = (el: HTMLElement) => el.querySelector('.attn-agents-toggle') as HTMLButtonElement
const scrim = (el: HTMLElement) => el.querySelector('.attn-agents-scrim') as HTMLElement
const isOpen = (el: HTMLElement) => wrap(el).className.includes('list-open')

test('§1 the drawer is shut by default and opening it does not touch the desk', async () => {
  reset()
  const v = await mountView(panel(), () => wrap(document.body as HTMLElement))
  await settle()
  const el = v.el
  assert.equal(isOpen(el), false, 'shut until the button is clicked')
  assert.ok(list(el).hasAttribute('inert'), 'shut, the list takes no focus and no pointer')

  // ⚠ THE DESK SUBTREE IS NOT TOUCHED BY OPENING THE DRAWER. jsdom does no
  // layout, so the width itself cannot be measured here — but the thing that
  // WOULD cost width is the list entering the desk's flow, and that would
  // re-parent or rebuild the desk. Holding the element identity is the
  // falsifiable version; the CSS that makes it an overlay is in attention.css
  // and is measured in the real renderer (attentionlayout_probe.py).
  const desk = el.querySelector('.attn-desk') as HTMLElement
  const deskParent = desk.parentElement
  await inAct(() => { toggle(el).click() })
  assert.equal(isOpen(el), true)
  assert.equal(list(el).hasAttribute('inert'), false)
  // ⚠ `assert.ok` WITH A BOOLEAN, NOT `assert.equal` WITH TWO DOM NODES. An
  // element handed to the reporter as `actual` is serialised with its whole
  // document graph when the assertion fails: measured at ~4.7s and
  // `RangeError: Array buffer allocation failed` (finding f4).
  assert.ok(el.querySelector('.attn-desk') === desk,
    'the desk is the same element — nothing about it was rebuilt to make room')
  assert.ok(desk.parentElement === deskParent, 'and it did not move in the tree')
  await v.unmount()
})

test('§2 hovering opens nothing and never closes an open drawer', async () => {
  reset()
  const v = await mountView(panel(), () => '')
  await settle()
  const el = v.el
  for (const target of [toggle(el), list(el), el.querySelector('.attn-agents-bar') as HTMLElement]) {
    await hover(target, true)
    await settle()
    assert.equal(isOpen(el), false, `hovering ${target.className} must not open the list`)
    await hover(target, false)
  }
  await inAct(() => { toggle(el).click() })
  await hover(list(el), true)
  await hover(list(el), false)
  // the pointer wandering onto the desk (its "↑ you" chip, in the report) is a
  // pointerout from the list and a pointerover on the desk
  await hover(el.querySelector('.attn-desk') as HTMLElement, true)
  await settle()
  assert.equal(isOpen(el), true, 'leaving the drawer does not close it')
  await v.unmount()
})

test('§3 the button again, the scrim, and Escape each close it', async () => {
  reset()
  const v = await mountView(panel(), () => '')
  await settle()
  const el = v.el
  assert.equal(toggle(el).getAttribute('aria-expanded'), 'false')
  await inAct(() => { toggle(el).click() })
  assert.equal(toggle(el).getAttribute('aria-expanded'), 'true')
  await inAct(() => { toggle(el).click() })
  assert.equal(isOpen(el), false, 'the button closes it')
  assert.equal(toggle(el).getAttribute('aria-expanded'), 'false')

  await inAct(() => { toggle(el).click() })
  await inAct(() => { scrim(el).click() })
  assert.equal(isOpen(el), false, 'a click on the dark area closes it')
  // a click on the scrim while shut does nothing (in the real renderer it is
  // not even hittable — pointer-events: none)
  await inAct(() => { scrim(el).click() })
  assert.equal(isOpen(el), false)

  await inAct(() => { toggle(el).click() })
  await inAct(() => {
    window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  })
  assert.equal(isOpen(el), false, 'Escape closes it')
  await v.unmount()
})

test('§4 choosing an agent keeps the drawer open and the choice sticks', async () => {
  reset()
  const v = await mountView(panel(), () => '')
  await settle()
  const el = v.el
  assert.equal(selectedRow(el), 'alpha', 'opens on the leftmost top-level agent')
  await inAct(() => { toggle(el).click() })
  await inAct(() => { rowFor(el, 'beta')!.click() })
  await settle()
  assert.equal(selectedRow(el), 'beta', 'clicking an agent replaces the open Desk')
  assert.equal(isOpen(el), true,
    'a list the user deliberately opened is not closed by their next click in it')
  assert.equal(attentionLayout(SLUG).agent, 'beta', 'and the choice is remembered')
  assert.equal(attentionLayout(SLUG).listOpen, true, 'and so is the drawer being out')
  await inAct(() => { toggle(el).click() })
  assert.equal(selectedRow(el), 'beta', 'closing it does not reset the selection')
  await v.unmount()
})

test('§5 the keyboard opens the drawer through the button and drives it', async () => {
  reset()
  const v = await mountView(panel(), () => '')
  await settle()
  const el = v.el
  // focus inside a shut drawer opens nothing — it used to roll the list out
  await inAct(() => {
    list(el).dispatchEvent(new window.Event('focusin', { bubbles: true }))
  })
  assert.equal(isOpen(el), false)
  // Enter/Space on a <button> is a click
  await inAct(() => { toggle(el).click() })
  assert.equal(isOpen(el), true)

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
  // Escape from a row hands focus back to the button, not to a hidden row
  await inAct(() => { rowFor(el, 'alpha')!.focus() })
  await inAct(() => {
    rowFor(el, 'alpha')!.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  })
  assert.equal(isOpen(el), false)
  assert.ok(document.activeElement === toggle(el), 'focus returns to the list button')
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
