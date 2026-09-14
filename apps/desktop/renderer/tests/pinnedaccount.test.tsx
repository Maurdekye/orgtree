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

async function mountCanvas(t: TestContext, withAccount: boolean,
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
  return view
}

async function mountPinned(t: TestContext, withAccount: boolean,
  account: ServingAccount | null = null, tier = 'luna') {
  const view = await mountCanvas(t, withAccount, account, tier)
  await inAct(() => addPin('mine', 'worker', { x: 10, y: 10, w: 500, h: 500 }))
  await flush()
  const win = view.el.querySelector<HTMLElement>('.pinwin[data-id="worker"]')
  assert.ok(win, 'the pinned window rendered')
  return win!
}

test('a pinned desk renders the account ID EXACTLY ONCE, in the token list', async (t: TestContext) => {
  const win = await mountPinned(t, true)

  // THE WHOLE POINT, stated as a count. Both halves matter: `1` and not `2`
  // is the duplicate being gone, and `1` and not `0` is the identity still
  // being there — a fix that deleted it everywhere would pass the first.
  assert.equal(win.querySelectorAll('.badge.serving-account').length, 1,
    'exactly one account ID on a pinned desk')

  // …and it is the TOKEN LIST's copy that survived, beside cost/cache/MCP —
  // not the title bar's. Asserting the count alone would let the two swap.
  const token = win.querySelector<HTMLElement>('.pinwin-body .cc-head-meta .badge.serving-account')
  assert.ok(token, 'the surviving card is the desk header token, beside its neighbours')
  assert.equal(win.querySelector('.pinwin-title .badge.serving-account'), null,
    'and the pinned title bar carries none (user report 2026-09-14, with a screenshot: '
    + 'a `default` pill against the agent name AND the intended one below)')

  // the token's own contract is untouched: the exact spelling, never the
  // provider-qualified form, never `primary`, and its detail reveal intact
  assert.equal(token!.textContent, 'default')
  assert.doesNotMatch(token!.textContent ?? '', /openai\/|primary/)
  assert.ok(win.querySelector('.pinwin-body .serving-account-tip'),
    'the hover/focus detail surface rides along as before')
})

test('a Fable agent on a Claude secondary wears exactly one card, in the token list', async (t: TestContext) => {
  // The provider-generic half: the backend now composes the field for every
  // multi-account provider, and the renderer surfaces are provider-blind —
  // the same shared component renders a Claude secondary's immutable id.
  const win = await mountPinned(t, true, claudeServing(), 'fable')
  assert.equal(win.querySelectorAll('.badge.serving-account').length, 1,
    'exactly once for a Claude secondary too — the duplicate was provider-blind, so this is')
  const token = win.querySelector<HTMLElement>('.pinwin-body .cc-head-meta .badge.serving-account')
  assert.ok(token, 'the desk header token carries the Claude account card')
  assert.equal(token!.textContent, 'claude-4')
  assert.doesNotMatch(token!.textContent ?? '', /claude\/|primary/)
  assert.equal(win.querySelector('.pinwin-title .badge.serving-account'), null)
})

test('without the backend field a pinned desk shows no account card at all', async (t: TestContext) => {
  const win = await mountPinned(t, false)
  // the gate is still the backend's: a null field renders nothing ANYWHERE in
  // the window, title bar and token list alike
  assert.equal(win.querySelectorAll('.badge.serving-account').length, 0)
  assert.equal(win.querySelector('.serving-account-wrap'), null)
  assert.equal(win.querySelector('.pinwin-title .badge.serving-account'), null)
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

test('the title bar carries no account styling to orphan', () => {
  const css = readFileSync(path.join(__SRC_DIR__, 'styles.css'), 'utf8')
  // This rule existed only to stop the TITLE BAR's tip being clipped by
  // `.pinwin`'s overflow:hidden. With no card there, it styled nothing — a
  // rule no surface can reach is a rule the next reader has to disprove.
  assert.doesNotMatch(css, /\.pinwin-title[^{]*\.serving-account/)
  // the card's own typography rules stay: they serve the canvas node and the
  // desk body, which is where the card still lives
  assert.match(css, /\.desk-body button\.badge\.serving-account \{/)
  assert.match(css, /\.sq-badges button\.badge\.serving-account \{/)
})


/** ⚠ THE CONTROL, and it is not decoration. "Renders exactly once" is
 *  satisfiable by deleting the account card from the app entirely, so the
 *  regression above is only worth something beside a test that fails if the
 *  identity stops being drawn where it is INTENDED. Same tree, same agent,
 *  nothing pinned: the canvas node must still wear it.
 *
 *  The other intentional surfaces — the near-zoom node, the unpinned Desk
 *  header's metadata row, far-zoom exclusion, the hover/focus detail — are
 *  held by servingaccount.test.tsx (§2a-§2m) and were not touched by this
 *  change. This is the cheap in-file guard against the obvious wrong fix. */
test('CONTROL: an UNPINNED desk still shows the account ID on its canvas node', async (t: TestContext) => {
  const view = await mountCanvas(t, true)
  const onNode = view.el.querySelector<HTMLElement>('.sq-badges .badge.serving-account')
  assert.ok(onNode, 'the canvas node card keeps its account ID — this change touched only the pinned title bar')
  assert.equal(onNode!.textContent, 'default')
  // and nothing was pinned, so no pinned window exists to have taken it
  assert.equal(view.el.querySelector('.pinwin'), null)
})

test('CONTROL: pinning MOVES nothing — the node keeps its card while pinned', async (t: TestContext) => {
  // The title-bar card was added as an extra surface, never as a relocation,
  // so removing it must not disturb the node's own. Asserted from the same
  // mount as the pinned window, which is the only way to see both at once.
  const win = await mountPinned(t, true)
  assert.ok(win.querySelector('.pinwin-body .cc-head-meta .badge.serving-account'),
    'the pinned desk shows it in the token list')
})
