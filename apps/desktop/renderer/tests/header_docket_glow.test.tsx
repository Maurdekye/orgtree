// header_docket_glow.test.tsx — regression tests for header button order
// (Mail -> Docket -> Presented Documents) and Docket attention glow/pulse behavior.
import './harness'
import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import App, { AskBell } from '../src/App'
import { DocketToolbarButton } from '../src/canvas/docket'
import { forgetModalOpenCache, forgetModalPins } from '../src/canvas/modalpin'
import type { TreePayload } from '../src/types'

const agent = (id: string) => ({
  id, state: 'live', tier: 'haiku', model_id: 'haiku', children: [], parent: null,
  seat: 1, grant: 10, free: 5, cost_usd: 0, occupancy: 0, context_window: 100000,
  scope: { tools: {}, add_dirs: [], permission_mode: 'default', org_visibility: 'team' },
})

const makeTree = (slug: string, over: Partial<TreePayload> = {}): TreePayload => ({
  slug, name: slug, workspace: null, dirs: [],
  max_top_grant: 1000, default_top_grant: 50, compact_at: 0, default_tools: null,
  default_visibility: 'team', default_effort: '', prefer_reserve_default: false,
  credit_requests: [], tiers: { haiku: 1 }, audiences: [], roots: [agent('a1') as any],
  cost_usd_total: 0, audit: { live_nodes: 1, top_level_holds: 0, no_overdraft: true, problems: [] },
  user_inbox_count: 0, user_inbox_newest: null, fable_lock: null, spend_frozen: false,
  storage_blocked: false, auto_resume: false, fable_limit_policy: 'freeze',
  fable_filter_policy: 'halt', cascade_hire: false, cascade_alloc: true, sandboxed: false,
  audience_requests: [], org_inbox: null, net: null, public: false, epoch: 1, rev: 1,
  work_items_summary: { attention: 0, active: 0 }, asks: [], asks_open: 0, watchdogs: [],
  ...over,
}) as TreePayload

async function setupApp(t: { after: (fn: () => void | Promise<void>) => void }, treePayload: TreePayload) {
  localStorage.clear()
  forgetModalPins()
  forgetModalOpenCache()
  window.history.replaceState(null, '', `/o/${treePayload.slug}`)

  const g = globalThis as unknown as Record<string, unknown>
  const json = (body: unknown) => ({
    ok: true, status: 200, headers: new Headers(),
    json: () => Promise.resolve(body),
  })

  let currentTree = treePayload
  const stub = (async (input: RequestInfo | URL) => {
    const path = String(input).replace(/^https?:\/\/[^/]+/, '').split('?')[0]!
    if (path === '/api/orgs') return json([{ slug: currentTree.slug, name: currentTree.name, live: 1, seats: 1 }])
    if (path === `/api/orgs/${currentTree.slug}`) return json(currentTree)
    if (path === '/api/providers') return json({ providers: [] })
    if (/inbox|mailbox|\/mail/.test(path)) {
      return json({ pending: [], delivered: [], history: [], messages: [], items: [], unread: 0 })
    }
    if (/\/(work|items|documents|asks|watchdogs|events|audiences)$/.test(path)) return json([])
    return json({})
  }) as unknown as typeof fetch

  g.fetch = stub
  ;(window as unknown as Record<string, unknown>).fetch = stub
  g.history ??= window.history
  g.location ??= window.location

  let onWsMessage: ((ev: MessageEvent) => void) | null = null
  class MockWs {
    readyState = 1
    _onmessage: ((ev: MessageEvent) => void) | null = null
    get onmessage() { return this._onmessage }
    set onmessage(fn: ((ev: MessageEvent) => void) | null) {
      this._onmessage = fn
      onWsMessage = fn
    }
    onclose: (() => void) | null = null
    send() {}
    close() { this.onclose?.() }
  }
  const prevWs = g.WebSocket
  g.WebSocket = MockWs
  ;(window as unknown as Record<string, unknown>).WebSocket = MockWs

  const view = await mountView(<App />, (el) => el)
  t.after(async () => {
    await view.unmount()
    delete g.fetch
    g.WebSocket = prevWs
    ;(window as unknown as Record<string, unknown>).WebSocket = prevWs
    forgetModalPins()
    forgetModalOpenCache()
  })

  const settle = () => inAct(async () => { await flush(50) })
  await settle()

  return {
    view,
    settle,
    setTree: (t: TreePayload) => { currentTree = t },
    triggerTreeRefresh: async (newTree: TreePayload) => {
      currentTree = newTree
      await inAct(async () => {
        if (onWsMessage) {
          onWsMessage(new MessageEvent('message', {
            data: JSON.stringify({ type: 'node_event', event: 'changed', node: 'a1' }),
          }))
        }
        await flush(50)
      })
      await settle()
    },
  }
}

test('DocketToolbarButton unit: attention triggers glow and asks pulse', async () => {
  let clicked = false
  const view = await mountView(
    <DocketToolbarButton summary={{ attention: 2, active: 6 }} onClick={() => { clicked = true }} />,
    (el) => el
  )

  const btn = view.el.querySelector('button.docket-bell') as HTMLButtonElement
  assert.ok(btn, 'docket button exists')
  assert.ok(btn.classList.contains('glow'), 'button has glow class when attention > 0')
  assert.equal(btn.getAttribute('title'), 'work docket — 2 item(s) need attention')

  const badge = view.el.querySelector('.eye-count') as HTMLElement
  assert.ok(badge, 'badge exists')
  assert.equal(badge.textContent?.trim(), '2', 'displays attention count')
  assert.ok(badge.classList.contains('docket-attn'), 'badge has docket-attn class')
  assert.ok(badge.classList.contains('asks'), 'badge has asks pulse class')

  await inAct(() => btn.click())
  assert.ok(clicked, 'click handler fires')
  await view.unmount()
})

test('DocketToolbarButton unit: active items without attention do not glow or pulse', async () => {
  const view = await mountView(
    <DocketToolbarButton summary={{ attention: 0, active: 4 }} />,
    (el) => el
  )

  const btn = view.el.querySelector('button.docket-bell') as HTMLButtonElement
  assert.ok(btn, 'docket button exists')
  assert.ok(!btn.classList.contains('glow'), 'button must NOT have glow class when attention is 0')
  assert.equal(btn.getAttribute('title'), 'work docket')

  const badge = view.el.querySelector('.eye-count') as HTMLElement
  assert.ok(badge, 'badge exists')
  assert.equal(badge.textContent?.trim(), '4', 'displays active count')
  assert.ok(!badge.classList.contains('docket-attn'), 'badge must NOT have docket-attn class')
  assert.ok(!badge.classList.contains('asks'), 'badge must NOT have asks pulse class')

  await view.unmount()
})

test('DocketToolbarButton unit: zero items renders no badge and no glow', async () => {
  const view = await mountView(
    <DocketToolbarButton summary={{ attention: 0, active: 0 }} />,
    (el) => el
  )

  const btn = view.el.querySelector('button.docket-bell') as HTMLButtonElement
  assert.ok(btn, 'docket button exists')
  assert.ok(!btn.classList.contains('glow'), 'button must NOT have glow class')
  assert.equal(btn.getAttribute('title'), 'work docket')
  assert.equal(view.el.querySelector('.eye-count'), null, 'no badge rendered for 0 items')

  await view.unmount()
})

test('DocketToolbarButton unit: dynamic same-button transitions between attention, quiet, and zero states', async () => {
  let updateSummary: ((s: { attention: number; active: number } | null) => void) | null = null

  function DynamicWrapper() {
    const [s, setS] = React.useState<{ attention: number; active: number } | null>({ attention: 2, active: 5 })
    updateSummary = setS
    return <DocketToolbarButton summary={s} />
  }

  const view = await mountView(<DynamicWrapper />, (el) => el)
  const btn = view.el.querySelector('button.docket-bell') as HTMLButtonElement
  assert.ok(btn, 'button is mounted')

  // Phase 1: Attention state
  assert.ok(btn.classList.contains('glow'), 'glow present under attention')
  let badge = btn.querySelector('.eye-count') as HTMLElement
  assert.ok(badge, 'badge is present')
  assert.equal(badge.textContent?.trim(), '2', 'shows attention count')
  assert.ok(badge.classList.contains('docket-attn'), 'docket-attn present')
  assert.ok(badge.classList.contains('asks'), 'asks pulse present')
  assert.equal(btn.getAttribute('title'), 'work docket — 2 item(s) need attention')

  // Phase 2: Transition to quiet state (attention drops to 0, active remains 5) on SAME button
  await inAct(() => updateSummary!({ attention: 0, active: 5 }))
  const sameBtnPhase2 = view.el.querySelector('button.docket-bell') as HTMLButtonElement
  assert.equal(sameBtnPhase2, btn, 'same DOM button element retained across state transition')
  assert.ok(!btn.classList.contains('glow'), 'glow removed immediately when attention drops to 0')
  badge = btn.querySelector('.eye-count') as HTMLElement
  assert.ok(badge, 'badge still present for active count')
  assert.equal(badge.textContent?.trim(), '5', 'shows active count quietly')
  assert.ok(!badge.classList.contains('docket-attn'), 'docket-attn removed')
  assert.ok(!badge.classList.contains('asks'), 'asks pulse removed')
  assert.equal(btn.getAttribute('title'), 'work docket')

  // Phase 3: Transition to zero items (active drops to 0) on SAME button
  await inAct(() => updateSummary!({ attention: 0, active: 0 }))
  assert.ok(!btn.classList.contains('glow'), 'no glow on zero items')
  assert.equal(btn.querySelector('.eye-count'), null, 'badge element unmounted on zero items')
  assert.equal(btn.getAttribute('title'), 'work docket')

  // Phase 4: Transition back to attention state (attention=4, active=7) on SAME button
  await inAct(() => updateSummary!({ attention: 4, active: 7 }))
  assert.ok(btn.classList.contains('glow'), 'glow reappears immediately when attention arrives')
  badge = btn.querySelector('.eye-count') as HTMLElement
  assert.ok(badge, 'badge rendered on attention')
  assert.equal(badge.textContent?.trim(), '4', 'shows updated attention count')
  assert.ok(badge.classList.contains('docket-attn'), 'docket-attn reappears')
  assert.ok(badge.classList.contains('asks'), 'asks pulse reappears')
  assert.equal(btn.getAttribute('title'), 'work docket — 4 item(s) need attention')

  await view.unmount()
})

test('Header control order: Mail -> Docket -> Presented Documents', async (t) => {
  const tree = makeTree('order-test')
  const { view } = await setupApp(t, tree)

  const askBell = view.el.querySelector('button.ask-bell') as HTMLButtonElement
  const docketBell = view.el.querySelector('button.docket-bell') as HTMLButtonElement
  const docBell = view.el.querySelector('button.doc-bell') as HTMLButtonElement

  assert.ok(askBell, 'ask-bell button rendered')
  assert.ok(docketBell, 'docket-bell button rendered')
  assert.ok(docBell, 'doc-bell button rendered')

  // Check direct sibling sequence in DOM
  assert.equal(askBell.nextElementSibling, docketBell, 'docket button directly follows mail button')
  assert.equal(docketBell.nextElementSibling, docBell, 'presented documents button directly follows docket button')

  // Verify full control order in header cluster
  const headerRight = askBell.parentElement!
  const buttons = Array.from(headerRight.children).filter((el) => el.tagName.toLowerCase() === 'button')
  const askIdx = buttons.indexOf(askBell)
  const docketIdx = buttons.indexOf(docketBell)
  const docIdx = buttons.indexOf(docBell)

  assert.ok(askIdx !== -1 && docketIdx !== -1 && docIdx !== -1)
  assert.equal(docketIdx, askIdx + 1, 'Docket sits immediately after Mail')
  assert.equal(docIdx, docketIdx + 1, 'Presented Documents sits immediately after Docket')
})

test('Header integration: Docket glows on attention and leaves Presented Documents quiet', async (t) => {
  const tree = makeTree('glow-test', {
    work_items_summary: { attention: 3, active: 8 },
  })
  const { view } = await setupApp(t, tree)

  const docketBell = view.el.querySelector('button.docket-bell') as HTMLButtonElement
  const docBell = view.el.querySelector('button.doc-bell') as HTMLButtonElement
  const askBell = view.el.querySelector('button.ask-bell') as HTMLButtonElement

  // Docket has attention
  assert.ok(docketBell.classList.contains('glow'), 'Docket button has glow class')
  const docketBadge = docketBell.querySelector('.eye-count')
  assert.ok(docketBadge?.classList.contains('docket-attn'), 'Docket badge has docket-attn class')
  assert.ok(docketBadge?.classList.contains('asks'), 'Docket badge has asks pulse class')
  assert.equal(docketBadge?.textContent?.trim(), '3')

  // Presented Documents must remain quiet
  assert.ok(!docBell.classList.contains('glow'), 'doc-bell never glows')
  assert.equal(docBell.querySelector('.asks'), null, 'doc-bell never has asks pulse')

  // Mail is quiet in this fixture
  assert.ok(!askBell.classList.contains('glow'), 'ask-bell does not glow without mail attention')
  assert.equal(askBell.querySelector('.asks'), null, 'ask-bell badge does not pulse')
})

test('Header integration: live WebSocket / repoll tree update transitions Docket on/off on same mounted button', async (t) => {
  const tree = makeTree('live-glow-test', {
    work_items_summary: { attention: 3, active: 5 },
  })
  const { view, triggerTreeRefresh } = await setupApp(t, tree)

  const docketBell = view.el.querySelector('button.docket-bell') as HTMLButtonElement
  assert.ok(docketBell, 'Docket button exists in header')

  // 1. Initial attention state
  assert.ok(docketBell.classList.contains('glow'), 'initial header Docket button has glow')
  let badge = docketBell.querySelector('.eye-count')
  assert.ok(badge?.classList.contains('docket-attn'), 'initial badge has docket-attn')
  assert.ok(badge?.classList.contains('asks'), 'initial badge has asks pulse')
  assert.equal(badge?.textContent?.trim(), '3')

  // 2. Live tree update clears attention: attention=0, active=5
  await triggerTreeRefresh(makeTree('live-glow-test', {
    work_items_summary: { attention: 0, active: 5 },
  }))

  const sameDocketBell = view.el.querySelector('button.docket-bell') as HTMLButtonElement
  assert.equal(sameDocketBell, docketBell, 'same DOM button element retained across tree update')
  assert.ok(!docketBell.classList.contains('glow'), 'glow removed from header Docket button when attention clears')
  badge = docketBell.querySelector('.eye-count')
  assert.ok(badge, 'badge still rendered for active count')
  assert.equal(badge?.textContent?.trim(), '5', 'shows active count quietly')
  assert.ok(!badge?.classList.contains('docket-attn'), 'docket-attn removed from badge')
  assert.ok(!badge?.classList.contains('asks'), 'asks pulse removed from badge')

  // 3. Live tree update clears active items: attention=0, active=0
  await triggerTreeRefresh(makeTree('live-glow-test', {
    work_items_summary: { attention: 0, active: 0 },
  }))
  assert.ok(!docketBell.classList.contains('glow'), 'no glow on zero items')
  assert.equal(docketBell.querySelector('.eye-count'), null, 'badge removed on zero items')

  // 4. Live tree update adds new attention item: attention=1, active=2
  await triggerTreeRefresh(makeTree('live-glow-test', {
    work_items_summary: { attention: 1, active: 2 },
  }))
  assert.ok(docketBell.classList.contains('glow'), 'glow returns when new attention item appears')
  badge = docketBell.querySelector('.eye-count')
  assert.ok(badge?.classList.contains('docket-attn'), 'docket-attn returns to badge')
  assert.ok(badge?.classList.contains('asks'), 'asks pulse returns to badge')
  assert.equal(badge?.textContent?.trim(), '1')
})

test('Header integration: clicking Docket opens docket modal, clicking doc-bell opens gallery', async (t) => {
  const tree = makeTree('nav-test')
  const { view, settle } = await setupApp(t, tree)

  const docketBell = view.el.querySelector('button.docket-bell') as HTMLButtonElement
  const docBell = view.el.querySelector('button.doc-bell') as HTMLButtonElement

  // Click Docket
  await inAct(() => docketBell.click())
  await settle()
  const docketModal = document.querySelector('.docket-modal')
  assert.ok(docketModal, 'Docket modal opens on clicking docket-bell')

  // Close Docket by clicking its backdrop
  const docketBackdrop = docketModal?.closest('.overlay') as HTMLElement | null
  if (docketBackdrop) {
    await inAct(() => docketBackdrop.click())
    await settle()
  }

  // Click Presented Documents
  await inAct(() => docBell.click())
  await settle()
  const galleryModal = document.querySelector('.gallery-modal')
  assert.ok(galleryModal, 'Gallery modal opens on clicking doc-bell')
})
