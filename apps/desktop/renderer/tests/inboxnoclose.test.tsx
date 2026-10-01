// The inbox modals have no footer `close` button any more (user, 2026-09-28:
// "also remove this close button from the inbox modal").
//
// Both inbox surfaces lost it: the user's own inbox (InboxPanel, PinFrame kind
// `inbox`) and an agent's inbox (NodeInboxModal, kind `node-inbox`), which is
// "the same interface". What still dismisses them is Escape and a backdrop
// click (driven below), the title bar's right-click Close (closemenu.test.tsx)
// and, while pinned, the title bar's ✕. These assertions are what stop a later
// PinFrame change leaving an inbox with no way out at all.
//
// Run:  node apps/desktop/renderer/tests/run.mjs inboxnoclose

import './harness'
import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { InboxPanel } from '../src/App'
import { NodeInboxModal } from '../src/canvas/mail'
import { CurrentOrg } from '../src/popout'
import type { TreePayload } from '../src/types'

const W = window as unknown as Window & typeof globalThis
if (!W.HTMLElement.prototype.scrollIntoView) W.HTMLElement.prototype.scrollIntoView = () => {}

const MAIL = { id: 'm1', from: 'alpha', at: '2026-09-28T00:00:00Z', body: 'URGENT: free memo' }

const TREE = {
  slug: 'mine', name: 'Mine', tiers: { opus: { name: 'Opus' } }, roots: [], nodes: [],
  default_tools: { bash: true, web: true, edit: true, subagents: true, mcp: [] },
  default_visibility: 'full',
} as unknown as TreePayload

const NODE = {
  id: 'worker', title: 'worker', tier: 'haiku', model_id: 'haiku', state: 'live', seat: 1,
  grant: 0, free: 0, ui_order: 0, cost_usd: 0, occupancy: null, context_window: null,
  charter: null, mail_pending: 1, limit_locked: false, last_status: null, prev_status: null,
  inflight_at: null, last_denials: [], turns: [], frozen: null, audiences_held: [],
  bearer_state: null, generation: 0, children: [], lineage: [],
  scope: { permission_mode: 'default', add_dirs: [], tools: {}, org_visibility: 'team' },
} as never

/** every button whose visible label is exactly `close` — the control removed */
const footerCloses = () => [...document.querySelectorAll('button')]
  .filter(b => (b.textContent ?? '').trim() === 'close')

const SURFACES = {
  'your inbox': (close: () => void) =>
    <InboxPanel slug="mine" tree={TREE} toast={() => {}} close={close} jumpTo={null} />,
  'an agent inbox': (close: () => void) =>
    <NodeInboxModal slug="mine" node={NODE} toast={() => {}} close={close} onFocusAgent={() => {}} />,
}

async function setup(t: TestContext, which: keyof typeof SURFACES, pending = [MAIL]) {
  const oldFetch = globalThis.fetch
  globalThis.fetch = (async (url: string) => {
    const path = String(url)
    const body = path.includes('/inbox') ? { pending, delivered: [], sent: [] }
      : path.includes('/audiences') ? { audiences: [], requests: [] }
        : path.includes('/events') ? { events: [] } : {}
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }) as typeof fetch
  const state = { closed: 0 }
  const view = await mountView(
    <CurrentOrg.Provider value="mine">{SURFACES[which](() => { state.closed++ })}</CurrentOrg.Provider>,
    el => el)
  t.after(async () => { await view.unmount(); globalThis.fetch = oldFetch })
  await inAct(async () => { await flush(10) })
  return { view, state }
}

for (const which of Object.keys(SURFACES) as (keyof typeof SURFACES)[]) {
  test(`${which}: no footer close button, and the mail itself rendered`, async (t) => {
    const { view } = await setup(t, which)
    assert.match(view.el.textContent ?? '', /inbox/i, 'the inbox rendered')
    assert.deepEqual(footerCloses().map(b => b.className), [],
      'no button labelled "close" anywhere in the modal')
  })

  test(`${which}: Escape still dismisses it`, async (t) => {
    const { state } = await setup(t, which)
    await inAct(async () => {
      W.dispatchEvent(new W.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
      await flush(3)
    })
    assert.equal(state.closed, 1, 'Escape ran the modal’s own close')
  })

  test(`${which}: a backdrop click still dismisses it`, async (t) => {
    const { state } = await setup(t, which)
    const overlay = document.querySelector<HTMLElement>('.overlay')
    assert.ok(overlay, 'the centred modal has a backdrop')
    await inAct(async () => {
      overlay!.dispatchEvent(new W.MouseEvent('click', { bubbles: true, cancelable: true }))
      await flush(2)
    })
    assert.equal(state.closed, 1, 'a click on the backdrop ran the modal’s own close')
  })
}

test('your inbox keeps "Mark all read" while mail is pending, and draws no empty footer without it',
  async (t) => {
    const { view } = await setup(t, 'your inbox')
    const mark = [...view.el.querySelectorAll('button')].find(b => b.textContent === 'Mark all read')
    assert.ok(mark, 'Mark all read is still there')
    assert.equal(mark!.closest('.row')?.querySelectorAll('button').length, 1,
      'it is the only button in its footer row')
  })

test('your inbox with nothing pending has no footer row at all', async (t) => {
  const { view } = await setup(t, 'your inbox', [])
  const rows = [...document.querySelectorAll('.row')].filter(r => r.children.length === 0)
  assert.deepEqual(rows.map(r => r.outerHTML), [], 'no empty footer row is left behind')
  assert.equal([...view.el.querySelectorAll('button')].find(b => b.textContent === 'Mark all read'),
    undefined, 'and Mark all read only shows with pending mail')
})
