// item 12 — reserve-first Luna, the two UI surfaces the user asked for
// (spec 2026-09-04): a token on the desk header's SECOND ROW while a luna
// turn runs on the reserve pool, and a per-agent "Prefer reserve" checkbox
// (on by default; off = weekly first, reserve second) that is set at hire
// and editable later.
//
// These are REAL DOM tests (parent review 2026-09-05: source assertions do
// not prove a live render): the desk header is mounted, re-rendered on the
// same root through the live → last transition, and read; the gear and the
// draft modal are mounted and clicked, and the request they send is read.
//
// The label TEXT is the backend's (`codex_route.route_label`, pinned in
// backend/tests/test_luna_reserve_route.py); the fixtures below carry the
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
    label: 'reserve', ...extra,
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
    op={op} slug="lunaroute" toast={noop} pub={false} bare onJump={noop} />
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

    // a direct luna running because reserve is out discloses it, and a
    // KNOWN reroute off reserve names where it actually ran
    await view.render(desk(luna({ busy: true, codex_route: route({
      route: 'direct', pool: 'plan', model: 'gpt-5.6-luna', reason: 'reserve-exhausted',
      live: true, label: 'direct · reserve out' }) })))
    await flush()
    const direct = routeBadge(view.el)!
    assert.equal(direct.textContent, 'direct · reserve out')
    assert.ok(direct.classList.contains('route-direct'))
    await view.render(desk(luna({ busy: true, codex_route: route({
      live: true, label: 'direct · rerouted off reserve', served_pool: 'plan',
      rerouted: { fromModel: 'gpt-reserve', toModel: 'gpt-5.6-luna', reason: 'x' } }) })))
    await flush()
    const rerouted = routeBadge(view.el)!
    assert.equal(rerouted.textContent, 'direct · rerouted off reserve')
    assert.ok(rerouted.classList.contains('route-direct'),
      'a reroute onto the direct model must wear the pool that RAN, not the one selected')
    assert.match(rerouted.title, /rerouted it to gpt-5\.6-luna \(the plan pool\)/)
    await view.render(desk(luna({ busy: false, codex_route: route({
      live: false, label: 'last: rerouted · pool unknown', served_pool: null,
      rerouted: { fromModel: 'gpt-reserve', toModel: 'gpt-9-mystery', reason: 'x' } }) })))
    await flush()
    const unknown = routeBadge(view.el)!
    assert.equal(unknown.textContent, 'last: rerouted · pool unknown')
    assert.ok(unknown.classList.contains('route-unknown'))
    assert.match(unknown.title, /no known pool/)

    // nothing to disclose (a plan-first luna on direct by preference; any
    // other tier): no token at all
    await view.render(desk(luna({ busy: false, codex_route: route({
      route: 'direct', pool: 'plan', reason: 'preferred', prefer: 'plan',
      live: false, label: null }) })))
    await flush()
    assert.equal(routeBadge(view.el), null, 'a null label must render no token')
    await view.render(desk(luna({ busy: false, codex_route: null })))
    await flush()
    assert.equal(routeBadge(view.el), null, 'no record, no token')
  })

// ------------------------------------------------------------ the checkbox

function tree(preferReserve = true): TreePayload {
  return {
    slug: 'org', dirs: [], tiers: {
      haiku: 1, sonnet: 2, opus: 5, fable: 10, luna: 0.2, terra: 2, sol: 5,
    }, max_top_grant: 100, default_effort: '', effort_default: 'high',
    cascade_hire: true, sandboxed: false,
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

test('gear: "Prefer reserve" is on by default for a luna, explains the pool order, and saves its state',
  async (t: TestContext) => {
    useFakeClock(); installFetch(new FakeServer())
    const posts = captureBodies()
    const n = luna({ scope: { tools: { mcp: [] }, add_dirs: [], permission_mode: 'acceptEdits',
      org_visibility: 'team' } })
    const view = await mountView(gear(n), (el) => el)
    t.after(async () => { await view.unmount(); realClock() })
    await flush()
    const cb = box(view.el)
    assert.ok(cb, 'no Prefer-reserve checkbox in a luna gear')
    assert.equal(cb!.checked, true, 'absent on the wire must render ON (the default)')
    assert.match(hint(view.el), /reserve pool first/, 'on: reserve first, weekly second')
    assert.match(hint(view.el), /fall back to normal weekly/)
    const { act } = await import('react')
    await act(async () => { cb!.click() })
    assert.equal(box(view.el)!.checked, false)
    assert.match(hint(view.el), /weekly Luna usage first/, 'off: weekly first, reserve second')
    assert.match(hint(view.el), /fall back to reserve/, 'off must NOT disable the fallback')
    // save → the scope request carries the box
    const save = [...view.el.querySelectorAll<HTMLButtonElement>('button')]
      .find((b) => b.textContent === 'save')!
    await act(async () => { save.click() })
    await flush()
    const scopePost = posts.find((p) => /\/nodes\/lx\/scope$/.test(p.url))
    assert.ok(scopePost, `no scope request sent: ${posts.map((p) => p.url).join(', ')}`)
    assert.equal(scopePost!.body.prefer_reserve, false, 'the saved scope must carry the box OFF')
  })

test('gear: a persisted OFF preference opens OFF, and saving without touching it keeps it',
  async (t: TestContext) => {
    useFakeClock(); installFetch(new FakeServer())
    const posts = captureBodies()
    const n = luna({ scope: { tools: { mcp: [] }, add_dirs: [], permission_mode: 'acceptEdits',
      org_visibility: 'team', prefer_reserve: false } })
    const view = await mountView(gear(n), (el) => el)
    t.after(async () => { await view.unmount(); realClock() })
    await flush()
    assert.equal(box(view.el)!.checked, false, 'a stored false must render unchecked')
    assert.match(hint(view.el), /weekly Luna usage first/)
    const { act } = await import('react')
    const save = [...view.el.querySelectorAll<HTMLButtonElement>('button')]
      .find((b) => b.textContent === 'save')!
    await act(async () => { save.click() })
    await flush()
    const scopePost = posts.find((p) => /\/nodes\/lx\/scope$/.test(p.url))!
    assert.equal(scopePost.body.prefer_reserve, false, 'an untouched OFF must be saved as OFF')
    const reset = [...view.el.querySelectorAll<HTMLButtonElement>('button')]
      .find((b) => b.textContent?.includes('use app default'))!
    await act(async () => { reset.click() })
    assert.equal(box(view.el)!.checked, true, 'reset shows the app default')
    posts.length = 0
    await act(async () => { save.click() })
    await flush()
    const resetPost = posts.find((p) => /\/scope$/.test(p.url))!
    assert.equal(resetPost.body.clear_prefer_reserve, true,
      'reset clears the explicit override')
    assert.equal('prefer_reserve' in resetPost.body, false,
      'reset does not replace the inherited value with an explicit one')
    // changing the reset checkbox creates a fresh explicit OFF override
    await act(async () => { box(view.el)!.click() })
    posts.length = 0
    await act(async () => { save.click() })
    await flush()
    assert.equal(posts.find((p) => /\/scope$/.test(p.url))!.body.prefer_reserve, false)
  })

test('gear: the checkbox belongs to luna only', async (t: TestContext) => {
  useFakeClock(); installFetch(new FakeServer())
  const n = luna({ tier: 'sol', model_id: 'sol', scope: { tools: { mcp: [] }, add_dirs: [],
    permission_mode: 'acceptEdits', org_visibility: 'team' } })
  const view = await mountView(gear(n), (el) => el)
  t.after(async () => { await view.unmount(); realClock() })
  await flush()
  assert.equal(box(view.el), null, 'a non-luna gear must not show the reserve box')
})

test('missing per-agent preference uses the app default while explicit ON stays ON',
  async (t: TestContext) => {
    useFakeClock(); installFetch(new FakeServer())
    const posts = captureBodies()
    const missing = luna()
    const offView = await mountView(gear(missing, false), (el) => el)
    t.after(async () => { await offView.unmount(); realClock() })
    await flush()
    assert.equal(box(offView.el)?.checked, false,
      'a missing preference must render the app-wide OFF default')
    const save = [...offView.el.querySelectorAll<HTMLButtonElement>('button')]
      .find((b) => b.textContent === 'save')!
    const { act } = await import('react')
    await act(async () => { save.click() })
    await flush()
    const scopePost = posts.find((p) => /\/nodes\/lx\/scope$/.test(p.url))!
    assert.equal('prefer_reserve' in scopePost.body, false,
      'saving an untouched inherited value must leave it absent')

    await offView.render(gear(missing, true))
    await flush()
    assert.equal(box(offView.el)?.checked, true,
      'a missing preference must follow a later app-default flip')

    const explicit = luna({ scope: { tools: { mcp: [] }, add_dirs: [], prefer_reserve: true } })
    await offView.render(gear(explicit, false))
    await flush()
    assert.equal(box(offView.el)?.checked, true,
      'an explicit per-agent ON preference must override the app default')
  })

test('draft initializer reflects the app-wide OFF default', async (t: TestContext) => {
  useFakeClock(); installFetch(new FakeServer())
  const saved: DraftScope[] = []
  const view = await mountView(
    <DraftScopeModal draft={{ parent: null, tier: 'luna' }} map={new Map()}
      tree={tree(false)} scope={null} onSave={(s) => saved.push(s)} close={noop} />,
    (el) => el)
  t.after(async () => { await view.unmount(); realClock() })
  await flush()
  const body = document.body as unknown as HTMLElement
  const cb = box(body)
  assert.equal(cb?.checked, false, 'draft with no preference uses app-wide OFF')
  const apply = [...body.querySelectorAll<HTMLButtonElement>('button')]
    .find((b) => b.textContent === 'apply')!
  const { act } = await import('react')
  await act(async () => { apply.click() })
  assert.equal('prefer_reserve' in (saved.at(-1) ?? {}), false,
    'draft preserves an absent preference when untouched')
})

test('draft modal: a luna hire stages the box ON by default and applies what was chosen',
  async (t: TestContext) => {
    useFakeClock(); installFetch(new FakeServer())
    const saved: DraftScope[] = []
    const draft = (tier: string): DraftState => ({ parent: null, tier })
    const modal = (tier: string) =>
      <DraftScopeModal draft={draft(tier)} map={new Map()} tree={tree()} scope={null}
        onSave={(s) => saved.push(s)} close={noop} />
    const view = await mountView(modal('luna'), (el) => el)
    t.after(async () => { await view.unmount(); realClock() })
    await flush()
    // the draft modal PORTALS into <body> (it lives inside the scaled world
    // transform otherwise), so it is read off the document, not the host
    const body = document.body as unknown as HTMLElement
    const cb = box(body)
    assert.ok(cb, 'a luna draft must offer the box')
    assert.equal(cb!.checked, true, 'on by default')
    const { act } = await import('react')
    const apply = () => [...body.querySelectorAll<HTMLButtonElement>('button')]
      .find((b) => b.textContent === 'apply')!
    await act(async () => { apply().click() })
    assert.equal('prefer_reserve' in (saved.at(-1) ?? {}), false,
      'untouched: inherited ON stays absent')
    await act(async () => { cb!.click() })
    assert.equal(box(body)!.checked, false)
    await act(async () => { apply().click() })
    assert.equal(saved.at(-1)?.prefer_reserve, false, 'unticked: applied OFF')
    // another tier's draft neither shows nor sends it
    await view.render(modal('sonnet'))
    await flush()
    assert.equal(box(body), null)
    await act(async () => { apply().click() })
    assert.equal('prefer_reserve' in (saved.at(-1) ?? {}), false,
      'a non-luna draft must not carry the field')
  })

// the draft's `USER` import keeps the harness's parent semantics honest for
// a top-level hire (parent null is the user)
void USER
