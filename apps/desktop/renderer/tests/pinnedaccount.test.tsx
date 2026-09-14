// pinnedaccount.test.tsx — the account card on PINNED DESK HEADERS, at the
// COMPACT size of its neighbours (user report 2026-09-14, docket
// `repair-rc4-installer-and-account-card-regression`).
//
// Two installed-2.1.4-RC4 regressions live here:
//
//   1. The pinned window's title bar — the pinned Desk header — showed no
//      account card at all. The desk body's own header row had it, but the
//      title bar is the surface that is always visible, and it carried only
//      the pin glyph, the name, and the state chip.
//   2. On the canvas node the card rendered at the CARD's inherited text
//      size: `button.badge.serving-account` said `font-size: inherit`, which
//      outweighs `.sq-badges .badge`'s 9.5px, so `default` towered over the
//      `last: reserve` pill beside it.
//
// The size half is asserted against the stylesheet text, exactly as
// servingaccount.test.tsx asserts the hover/focus reveal: jsdom computes no
// cascade, so the stylesheet itself is the only place that proof can live.
import { flush, inAct, mountView, realClock, useFakeClock } from './harness'
import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { useState } from 'react'
import { addPin, forgetPins } from '../src/canvas/pins'
import type { ServingAccount, TreePayload } from '../src/types'

declare const __SRC_DIR__: string

const asTree = (v: unknown) => v as TreePayload

/** the exact Codex token contract: the ambient account's card token is the
 *  word `default`, never `openai/…` and never `primary` */
function serving(): ServingAccount {
  return {
    id: 'default', display: 'default', provider: 'openai', label: null,
    email: null, auth: 'subscription', state: 'ready', active: false,
  } as unknown as ServingAccount
}

/** the operator's live Fable shape: a managed Claude secondary serving —
 *  the provider-generic half of the same requirement (2026-09-14: the card
 *  was OpenAI-only in the backend, so Fable agents never wore one) */
function claudeServing(): ServingAccount {
  return {
    id: 'claude-4', display: 'claude-4', provider: 'claude', label: null,
    email: null, auth: 'authenticated', state: 'ready', active: false,
  } as unknown as ServingAccount
}

function tree(withAccount: boolean, account: ServingAccount | null = null, tier = 'luna'): TreePayload {
  const mk = (id: string) => ({
    id, title: id, tier, model_id: tier, state: 'live',
    seat: 1, grant: 0, free: 0, ui_order: 0, cost_usd: 0, occupancy: null,
    context_window: null, charter: null, mail_pending: 0, limit_locked: false,
    last_status: null, prev_status: null, inflight_at: null, last_denials: [],
    turns: [], frozen: null, audiences_held: [], bearer_state: null,
    generation: 0, children: [], lineage: [],
    ...(withAccount ? { serving_account: account ?? serving() } : {}),
    scope: { permission_mode: 'default', add_dirs: [], tools: {}, org_visibility: 'team' },
  })
  return asTree({
    slug: 'mine', name: 'mine', workspace: null, dirs: [], max_top_grant: 1000,
    default_top_grant: 50, compact_at: 0, default_tools: null,
    default_visibility: 'team', default_effort: '', credit_requests: [],
    tiers: { haiku: 1, sonnet: 3, opus: 5, fable: 10 }, audiences: [],
    roots: [mk('worker')], cost_usd_total: 0,
    audit: { live_nodes: 1, top_level_holds: 0, no_overdraft: true, problems: [] },
    user_inbox_count: 0, user_inbox_newest: null, fable_lock: null,
    spend_frozen: false, storage_blocked: false, auto_resume: false,
    fable_limit_policy: 'freeze', fable_filter_policy: 'halt',
    cascade_hire: false, cascade_alloc: true, sandboxed: false,
    audience_requests: [], org_inbox: null, net: null,
  })
}

async function mountPinned(t: TestContext, withAccount: boolean,
  account: ServingAccount | null = null, tier = 'luna') {
  useFakeClock()
  localStorage.clear()
  forgetPins()
  const { OrgCanvas } = await import('../src/canvas/OrgCanvas')
  function Host() {
    const [payload] = useState(tree(withAccount, account, tier))
    return <OrgCanvas tree={payload} op={() => Promise.resolve({} as never)}
      slug="mine" toast={() => {}} mailEvt={null} />
  }
  const view = await mountView(<Host />, (el) => el)
  t.after(async () => { await view.unmount(); realClock(); localStorage.clear(); forgetPins() })
  await flush()
  await inAct(() => addPin('mine', 'worker', { x: 10, y: 10, w: 500, h: 500 }))
  await flush()
  const win = view.el.querySelector<HTMLElement>('.pinwin[data-id="worker"]')
  assert.ok(win, 'the pinned window rendered')
  return win!
}

test('the pinned Desk header wears the account card with the exact token', async (t: TestContext) => {
  const win = await mountPinned(t, true)
  const title = win.querySelector<HTMLElement>('.pinwin-title')!
  const badge = title.querySelector<HTMLElement>('.badge.serving-account')
  assert.ok(badge, 'the pinned title bar must carry the account card (RC4 omitted it)')
  assert.equal(badge!.textContent, 'default')
  // the token contract: never the provider-qualified spelling, never `primary`
  assert.doesNotMatch(badge!.textContent ?? '', /openai\/|primary/)
  // the same shared component: its detail reveal rides along
  assert.ok(title.querySelector('.serving-account-tip'), 'the hover/focus detail surface is present')
  // and the desk body inside the very same window still has its own copy —
  // the title-bar card ADDS a surface, it does not move one
  assert.ok(win.querySelector('.pinwin-body .cc-head-meta .badge.serving-account'),
    'the desk header inside the pinned body keeps its card')
})

test('a Fable agent on a Claude secondary wears the same card on node and pinned title', async (t: TestContext) => {
  // The provider-generic half: the backend now composes the field for every
  // multi-account provider, and the renderer surfaces are provider-blind —
  // the same shared component renders a Claude secondary's immutable id.
  const win = await mountPinned(t, true, claudeServing(), 'fable')
  const badge = win.querySelector<HTMLElement>('.pinwin-title .badge.serving-account')
  assert.ok(badge, 'the pinned title bar must carry the Claude account card')
  assert.equal(badge!.textContent, 'claude-4')
  assert.doesNotMatch(badge!.textContent ?? '', /claude\/|primary/)
  assert.ok(win.querySelector('.pinwin-body .cc-head-meta .badge.serving-account'),
    'the desk header inside the pinned body keeps its card for Claude too')
})

test('without the backend field the pinned Desk header shows nothing', async (t: TestContext) => {
  const win = await mountPinned(t, false)
  assert.equal(win.querySelector('.pinwin-title .badge.serving-account'), null)
  assert.equal(win.querySelector('.pinwin-title .serving-account-wrap'), null)
})

test('the card uses the compact badge typography of its neighbours in every context', () => {
  const css = readFileSync(path.join(__SRC_DIR__, 'styles.css'), 'utf8')
  const block = css.match(/button\.badge\.serving-account \{[^}]*\}/)?.[0]
  assert.ok(block, 'the serving-account button rule exists')
  // `font-size: inherit` is the RC4 oversize: this selector outweighs the
  // span badges' context sizes, so inheriting makes the card wear the CARD's
  // text size instead of the pill size beside it.
  assert.doesNotMatch(block!, /font-size:\s*inherit/,
    'the RC4 oversized-card regression: the button may not inherit its font size')

  const size = (pattern: RegExp) => {
    const match = css.match(pattern)
    assert.ok(match, `expected a rule matching ${pattern}`)
    return match![1]
  }
  // Each context override must exist and be IN STEP with the span badges'
  // size for the same context, so the card is exactly as compact as the
  // reserve/last-reserve pill it sits beside.
  assert.equal(size(/button\.badge\.serving-account \{[^}]*?font-size:\s*([\d.]+)px/),
    size(/(?:^|\n)\.badge \{[^}]*?font-size:\s*([\d.]+)px/))
  assert.equal(size(/\.sq-badges button\.badge\.serving-account \{[^}]*?font-size:\s*([\d.]+)px/),
    size(/\.sq-badges \.badge \{[^}]*?font-size:\s*([\d.]+)px/))
  assert.equal(size(/\.desk-body button\.badge\.serving-account \{[^}]*?font-size:\s*([\d.]+)px/),
    size(/\.desk-body \.badge \{[^}]*?font-size:\s*([\d.]+)px/))
})

test('the title-bar detail surface opens downward, away from the clipped window edge', () => {
  const css = readFileSync(path.join(__SRC_DIR__, 'styles.css'), 'utf8')
  // .pinwin is overflow:hidden and the title bar is its very first row: the
  // default upward tip would be clipped to nothing there.
  assert.match(css, /\.pinwin-title \.serving-account-tip \{[^}]*bottom:\s*auto;[^}]*top:\s*calc\(100% \+ 5px\);[^}]*\}/)
})
