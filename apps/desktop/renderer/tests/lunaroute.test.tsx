// (the "Prefer reserve" tests were removed: the Luna prefer-reserve switch was dropped in 4.x, DECISIONS 31)
// item 12 — reserve-first Luna, the two UI surfaces the user asked for
// (spec 2026-09-04): a token on the desk header's SECOND ROW while a luna
// turn runs on the reserve pool, and a per-agent "Prefer reserve" checkbox
// (on by default; off = weekly first, reserve second) that is set at hire
// and editable later.
//
// ⚠ NARROWED 2026-09-16 (user: "dont show a card on a luna when it isnt
// running on reserve; only show a card when its on reserve"). The token is a
// RESERVE card and nothing else: a luna on the plan pool, one the provider
// rerouted off reserve, and one whose lane was never established all render
// NOTHING. `on_reserve` on the payload is the single gate — three-valued,
// and the renderer requires `true`, so `false` and `null` alike show no
// card. The renderer does not re-derive it from `route`/`pool`/`tier`;
// deriving it from the tier is the bug that produced the wrong card.
//
// These are REAL DOM tests (parent review 2026-09-05: source assertions do
// not prove a live render): the desk header is mounted, re-rendered on the
// same root through the live → last transition, and read; the gear and the
// draft modal are mounted and clicked, and the request they send is read.
//
// The label TEXT is the backend's (`codex_route.route_label`, pinned in
// tests/test_luna_reserve_card.py); the fixtures below carry the
// exact strings it emits so the desk cannot be shown rendering something
// the backend never sends.

import './harness'
import { FakeServer, flush, installFetch, mountView, realClock, useFakeClock } from './harness'
import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { DeskChat } from '../src/canvas/desk'
import { DraftScopeModal, NodeConfig } from '../src/canvas/modals'
import { USER } from '../src/canvas/shared'
import type { CanvasNode, DraftScope, DraftState } from '../src/canvas/shared'
import type { CodexRouteInfo, OpResult, ProviderInfo, TreePayload } from '../src/types'

const noop = () => {}
const op = () => Promise.resolve({} as OpResult)

// the receipt shapes the backend serves (`api.org_tree` → `codex_route`)
function route(extra: Partial<CodexRouteInfo>): CodexRouteInfo {
  return {
    route: 'reserve', pool: 'reserve', model: 'gpt-reserve', requested: 'luna',
    reason: 'granted', selection: 'preflight', prefer: 'reserve', outcome: null,
    reported_model: 'gpt-reserve', live: true, at: '2026-09-05T02:00:00Z',
    on_reserve: true, label: 'reserve', ...extra,
  }
}

function luna(extra: Partial<CanvasNode> = {}): CanvasNode {
  return {
    id: 'lx', state: 'live', tier: 'luna', model_id: 'luna', children: [],
    parent: 'superior', seat: 1, grant: 4, free: 1,
    scope: { tools: { mcp: [] }, add_dirs: [] },
    audiences_held: [], ...extra,
  }
}

function desk(n: CanvasNode) {
  const superior: CanvasNode = {
    id: 'superior', state: 'live', tier: 'sonnet', model_id: 'sonnet',
    children: [n], seat: 2, grant: 0, free: 0, scope: { tools: {}, add_dirs: [] },
  }
  return <DeskChat node={n} map={new Map([[n.id, n], ['superior', superior]])}
    op={op} slug="lunaroute" toast={noop} bare onJump={noop} />
}

const routeBadge = (el: HTMLElement) =>
  el.querySelector<HTMLElement>('.cc-head .cc-head-meta .badge[class*="route-"]')

test('desk header row 2 wears the reserve token while the turn runs, then "last:" once it ended',
  async (t: TestContext) => {
    installFetch(new FakeServer())
    const live = luna({ busy: true, inflight_at: '2026-09-05T02:00:00Z',
      codex_route: route({ live: true, label: 'reserve' }) })
    const view = await mountView(desk(live), (el) => el)
    t.after(() => view.unmount())
    await flush()
    const head = view.el.querySelector('.cc-head')!
    // ROW 2, not row 1: the token sits in the metadata row beside "ran as"
    const badge = routeBadge(view.el)
    assert.ok(badge, 'no route token rendered in the header metadata row')
    assert.equal(badge!.textContent, 'reserve')
    assert.ok(badge!.classList.contains('route-reserve'))
    assert.ok(badge!.classList.contains('live'), 'a running reserve turn must be marked live')
    assert.equal(badge!.getAttribute('data-route-live'), '1')
    assert.equal(head.querySelector(':scope > .cc-head-top .badge[class*="route-"]'), null,
      'the token leaked into the top row')
    assert.match(badge!.title, /this turn was sent as gpt-reserve on the reserve pool/)

    // THE TRANSITION, on the same root: the turn ends, the backend flips the
    // record to not-live and prefixes the label — the token must follow
    const ended = luna({ busy: false,
      codex_route: route({ live: false, label: 'last: reserve', outcome: 'completed' }) })
    await view.render(desk(ended))
    await flush()
    const after = routeBadge(view.el)
    assert.ok(after, 'the token vanished after the turn instead of saying last')
    assert.equal(after!.textContent, 'last: reserve')
    assert.equal(after!.classList.contains('live'), false, 'a finished turn still marked live')
    assert.equal(after!.getAttribute('data-route-live'), '0')
    assert.match(after!.title, /last turn/)

    // A KNOWN REROUTE ONTO RESERVE still wears the card — the token is
    // about where the turn RAN, not where it was sent
    await view.render(desk(luna({ busy: true, codex_route: route({
      route: 'direct', pool: 'plan', model: 'gpt-5.6-luna', live: true,
      on_reserve: true, label: 'reserve · rerouted', served_pool: 'reserve',
      rerouted: { fromModel: 'gpt-5.6-luna', toModel: 'gpt-reserve', reason: 'x' } }) })))
    await flush()
    const onto = routeBadge(view.el)!
    assert.equal(onto.textContent, 'reserve · rerouted')
    assert.ok(onto.classList.contains('route-reserve'),
      'a reroute ONTO reserve must wear the pool that RAN, not the one selected')
    assert.match(onto.title, /rerouted it to gpt-reserve \(the reserve pool\)/)
  })

// ⚠ THE TICKET (user ruling 2026-09-16, docket
// `only-show-the-reserve-card-on-a-luna-agent-when`): "dont show a card on a
// luna when it isnt running on reserve; only show a card when its on
// reserve". Being a Luna was never the condition — a Luna spends the normal
// weekly limit whenever its reserve preference is off, the reserve lane is
// unavailable, or reserve is spent — and the card used to stay up through all
// of those, claiming a lane the agent was not on.
//
// Asserted at the RENDERER even though the backend already withholds the
// label, because the renderer's guard is the one that must not drift: it is
// what stops a future payload, a stale bundle or a hand-built fixture from
// putting a reserve card on a non-reserve agent.
test('the card is absent on every luna that is NOT on reserve, and on an unknown lane',
  async (t: TestContext) => {
    installFetch(new FakeServer())
    const view = await mountView(desk(luna({ codex_route: null })), (el) => el)
    t.after(() => view.unmount())
    await flush()
    assert.equal(routeBadge(view.el), null, 'no record, no token')

    // every way a luna falls through to the normal weekly limit. The backend
    // sends no label for these now; the payloads below carry the route facts
    // it still sends, and `on_reserve: false` is its answer.
    const offReserve: Partial<CodexRouteInfo>[] = [
      // reserve spent
      { route: 'direct', pool: 'plan', model: 'gpt-5.6-luna',
        reason: 'reserve-exhausted' },
      // the reserve lane is not granted on this account at all
      { route: 'direct', pool: 'plan', model: 'gpt-5.6-luna', reason: 'no-grant' },
      // the user turned the per-agent "Prefer reserve" box OFF
      { route: 'direct', pool: 'plan', model: 'gpt-5.6-luna', reason: 'preferred',
        prefer: 'plan' },
      // an api-key login holds no reserve grant
      { route: 'direct', pool: 'plan', model: 'gpt-5.6-luna', reason: 'login-kind' },
      // both pools out: sent to the preferred one, still not on reserve
      { route: 'direct', pool: 'plan', model: 'gpt-5.6-luna',
        reason: 'both-out:reserve-exhausted,direct-exhausted' },
      // the provider bounced the turn OFF reserve onto the direct model
      { served_pool: 'plan',
        rerouted: { fromModel: 'gpt-reserve', toModel: 'gpt-5.6-luna', reason: 'x' } },
    ]
    for (const r of offReserve) {
      for (const live of [true, false]) {
        await view.render(desk(luna({ busy: live, codex_route: route({
          ...r, live, on_reserve: false, label: null }) })))
        await flush()
        assert.equal(routeBadge(view.el), null,
          `a card survived on a luna that is not on reserve: ${r.reason ?? 'rerouted'} live=${live}`)
      }
    }

    // ⚠ UNKNOWN IS NOT THE SAME AS "NOT ON RESERVE", AND IT IS NOT ZERO. The
    // provider rerouted onto a model no pool is known for, so where the turn
    // ran was never established. It hides — a card here would be a confident
    // claim built on a reading nobody took, which is the same class of bug as
    // the one this ticket fixes — but it hides on an explicit `null`, not by
    // being mistaken for a negative reading.
    await view.render(desk(luna({ busy: true, codex_route: route({
      live: true, on_reserve: null, label: null, served_pool: null,
      rerouted: { fromModel: 'gpt-reserve', toModel: 'gpt-9-mystery', reason: 'x' } }) })))
    await flush()
    assert.equal(routeBadge(view.el), null, 'an unestablished lane must show no card')

    // and the renderer's own guard, independent of the backend: even handed a
    // label it must not render one unless the lane answer is exactly `true`
    for (const on of [false, null, undefined]) {
      await view.render(desk(luna({ busy: true, codex_route: route({
        live: true, on_reserve: on, label: 'reserve' }) })))
      await flush()
      assert.equal(routeBadge(view.el), null,
        `the renderer rendered a reserve card on on_reserve=${String(on)}`)
    }
    // ...and that the same guard still lets a real reserve turn through, so
    // the assertions above are not passing because nothing ever renders
    await view.render(desk(luna({ busy: true, codex_route: route({ live: true }) })))
    await flush()
    assert.equal(routeBadge(view.el)?.textContent, 'reserve',
      'the positive control stopped rendering — the checks above prove nothing')
  })

// ------------------------------------------------------------ the checkbox

function tree(preferReserve = true): TreePayload {
  return {
    slug: 'org', dirs: [], tiers: {
      haiku: 1, sonnet: 2, opus: 5, fable: 10, luna: 0.2, terra: 2, sol: 5,
    }, max_top_grant: 100, default_effort: '', effort_default: 'high',
    cascade_hire: true,
    prefer_reserve_default: preferReserve,
  } as unknown as TreePayload
}

function codexProvider(): ProviderInfo {
  return {
    id: 'openai', label: 'Codex', cli: 'Codex CLI', tiers: [],
    status: { installed: true, connected: true, kind: 'chatgpt' },
    hire_enabled: true, reason: null,
  }
}

/** record every request body the modal sends, on top of the harness stub */
function captureBodies(): { url: string; body: Record<string, unknown> }[] {
  const posts: { url: string; body: Record<string, unknown> }[] = []
  const real = globalThis.fetch as unknown as
    (url: string, init?: { body?: string }) => Promise<unknown>
  ;(globalThis as unknown as { fetch: unknown }).fetch =
    (url: string, init?: { body?: string }) => {
      if (init?.body) posts.push({ url: String(url), body: JSON.parse(init.body) })
      return real(url, init)
    }
  return posts
}

function gear(n: CanvasNode, preferReserve = true) {
  return <NodeConfig node={n} map={new Map([[n.id, n]])} tree={tree(preferReserve)} slug="org"
    op={op} toast={noop} codexProvider={codexProvider()} close={noop} />
}

const box = (el: HTMLElement) => el.querySelector<HTMLInputElement>('.prefer-reserve input')
const hint = (el: HTMLElement) =>
  [...el.querySelectorAll('.hub-hint')].map((x) => x.textContent ?? '')
    .find((x) => x.includes('turns use')) ?? ''

test('gear: the checkbox belongs to luna only', async (t: TestContext) => {
  useFakeClock(); installFetch(new FakeServer())
  const n = luna({ tier: 'sol', model_id: 'sol', scope: { tools: { mcp: [] }, add_dirs: [],
    permission_mode: 'acceptEdits', org_visibility: 'team' } })
  const view = await mountView(gear(n), (el) => el)
  t.after(async () => { await view.unmount(); realClock() })
  await flush()
  assert.equal(box(view.el), null, 'a non-luna gear must not show the reserve box')
})

test('account fallback gear inherits org default, saves OFF and can return to inheritance', async t => {
  useFakeClock(); installFetch(new FakeServer())
  const posts = captureBodies()
  const n = luna()
  const settings = { ...tree(), account_fallback_default: true }
  const view = await mountView(<NodeConfig node={n} map={new Map([[n.id, n]])}
    tree={settings} slug="org" op={op} toast={noop}
    codexProvider={codexProvider()} close={noop} />, el => el)
  t.after(async () => { await view.unmount(); realClock() })
  await flush()
  const select = view.el.querySelector<HTMLSelectElement>('[aria-label="Automatic account fallback"]')!
  assert.ok(select)
  assert.equal(select.value, '')
  assert.match(select.selectedOptions[0].textContent || '', /Org default \(on\)/)
  const { act } = await import('react')
  const save = [...view.el.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === 'save')!
  await act(async () => {
    select.value = 'off'
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await act(async () => { save.click(); await flush() })
  const off = posts.find(p => /\/scope$/.test(p.url))!
  assert.equal(off.body.account_fallback, false)
  assert.equal(off.body.clear_account_fallback, undefined)
  posts.length = 0
  await act(async () => {
    select.value = ''
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await act(async () => { save.click(); await flush() })
  const inherited = posts.find(p => /\/scope$/.test(p.url))!
  assert.equal(inherited.body.clear_account_fallback, true)
  assert.equal(inherited.body.account_fallback, undefined)
})
