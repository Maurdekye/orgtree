import { advance, FakeServer, flush, inAct, installFetch, mountView, realClock, useFakeClock } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { OrgCanvas } from '../src/canvas/OrgCanvas'
import { resetConvos } from '../src/convo'
import type { OpRequest, TreePayload } from '../src/types'

const agent = (id: string, children: unknown[] = []) => ({ id, title: id, tier: 'sol', state: 'live',
  seat: 2, grant: 80, free: 70, generation: 0, children, turns: [], lineage: [], audiences_held: [],
  last_denials: [], scope: { tools: { bash: true, web: false, mcp: [] },
    add_dirs: [{ path: `D:/synthetic/${id}`, mode: 'ro' }], org_visibility: 'self' }, frozen: null })
// Mirror the engine's superior-insertion refusal, rather than accepting every
// request: scope belongs to the anchor; effort/account are independent choices.
const inheritedFields = ['add_dirs', 'tools', 'org_visibility', 'permission_mode']
function validateHire(body: Record<string, unknown>) {
  if (body.above) for (const key of inheritedFields) {
    if (body[key] != null) throw Error(`superior insertion inherits target scope; omit ${key}`)
  }
}
async function click(el: Element | null | undefined) {
  assert.equal(!!el, true, 'the intended control exists')
  await inAct(async () => { (el as HTMLElement).click(); await flush() })
}
async function setup(t: test.TestContext, history: boolean) {
  useFakeClock(); localStorage.clear(); installFetch(new FakeServer())
  const before = globalThis.fetch
  const requests: Record<string, unknown>[] = []
  const accepted: Record<string, unknown>[] = []
  const refused: string[] = []
  const accept = (body: Record<string, unknown>) => {
    requests.push(body)
    try { validateHire(body) } catch (e) { refused.push(String(e)); throw e }
    accepted.push(body)
    return { node: 'manager' }
  }
  const tree = { slug: 'superior-target', name: 'Synthetic', roots: [agent('boss', [agent('worker')])],
    dirs: [], tiers: { sol: 2 }, undo_history: history, default_top_grant: 50, max_top_grant: 1000,
    cascade_hire: true, default_visibility: 'team', default_tools: {},
    audiences: [], audience_requests: [], credit_requests: [], user_inbox_count: 0 } as unknown as TreePayload
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    if (String(url).includes('/api/accounts?')) return new Response(JSON.stringify({ accounts: [
      { id: 'openai-test', provider: 'openai', label: 'Synthetic account', standing: { state: 'ready' } },
    ] }), { headers: { 'content-type': 'application/json' } })
    if (String(url).endsWith('/gesture')) {
      const body = JSON.parse(String(init?.body))
      try {
        return new Response(JSON.stringify({ results: body.steps.map(accept) }), { headers: { 'content-type': 'application/json' } })
      } catch (e) {
        return new Response(JSON.stringify({ error: String(e) }), { status: 400, headers: { 'content-type': 'application/json' } })
      }
    }
    return before(url, init)
  }) as typeof fetch
  const v = await mountView(<OrgCanvas tree={tree} slug={tree.slug} mailEvt={null} toast={() => {}}
    op={async (body: OpRequest) => accept(body as unknown as Record<string, unknown>)} />, el => el)
  t.after(async () => { await v.unmount(); resetConvos(); realClock(); globalThis.fetch = before })
  const card = (name: string) => [...v.el.querySelectorAll('.sq')].find(el => el.querySelector('.name')?.textContent === name)!
  const submit = async () => {
    await advance(1200)
    const input = v.el.querySelector<HTMLInputElement>('.sq.draft .df-name')!
    assert.equal(!!input, true, 'a superior draft opened')
    await inAct(() => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(input, 'manager')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await click(v.el.querySelector('.sq.draft .df-foot .primary')); await flush()
  }
  return { v, requests, accepted, refused, card, submit }
}

test('superior fixture rejects every forbidden scope field but accepts effort/account', () => {
  for (const key of inheritedFields) assert.throws(() => validateHire({ above: 'worker', [key]: {} }), /inherits target scope/)
  assert.doesNotThrow(() => validateHire({ above: 'worker', effort: 'low', account: 'openai-test' }))
})

for (const target of ['boss', 'worker']) for (const history of [true, false]) {
  for (const choice of ['apply', 'effort', 'account']) {
    test(`superior ${target}, history=${history}: gear ${choice} preserves inherited scope and allowed choices`, async t => {
      const c = await setup(t, history)
      await click(c.card(target).querySelector('.hsof.side-t button.t-sol'))
      await advance(1200)
      await click(c.v.el.querySelector('.sq.draft .df-gear'))
      const panel = document.body.querySelector('.pinframe[data-kind="draft-scope"]')
        ?? [...document.body.querySelectorAll('.settings')].find(el => el.textContent?.includes('applied with the hire'))
        ?? document.body
      if (choice === 'effort') {
        const bar = panel.querySelector('[role="slider"]')
        assert.ok(bar, 'effort remains editable')
        await inAct(() => bar.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true })))
      }
      if (choice === 'account') {
        const select = panel.querySelector<HTMLSelectElement>('select[aria-label="Account"]')
        assert.ok(select, 'account remains editable')
        await inAct(() => { select.value = 'openai-test'; select.dispatchEvent(new Event('change', { bubbles: true })) })
      }
      await click([...panel.querySelectorAll('button')].find(el => el.textContent === 'apply'))
      await c.submit()
      assert.deepEqual(c.refused, [], 'the request passes the engine inheritance contract')
      assert.equal(c.accepted.length, 1, 'one successful atomic hire')
      const body = c.accepted[0]
      assert.equal(body.above, target)
      assert.equal(body.parent, target === 'boss' ? null : 'boss')
      for (const key of inheritedFields) assert.equal(body[key], undefined, `${key} is inherited at hire`)
      if (choice === 'effort') assert.equal(body.effort, 'low')
      if (choice === 'account') assert.equal(body.account, 'openai-test')
    })
  }
}

for (const target of ['boss', 'worker']) test(`superior ${target} gear identifies its target's inherited scope`, async t => {
  const c = await setup(t, true)
  await click(c.card(target).querySelector('.hsof.side-t button.t-sol'))
  await advance(1200)
  await click(c.v.el.querySelector('.sq.draft .df-gear'))
  const note = document.body.querySelector('.draft-scope-inherited')
  assert.ok(note)
  assert.match(note.textContent ?? '', new RegExp(`inherited from ${target} when hired`))
  assert.equal(document.body.querySelector('input[placeholder="Add a folder path"]'), null)
  assert.equal(document.body.querySelector('select[aria-label="Visible agents"]'), null)
  assert.equal(document.body.querySelector('[aria-label="Refresh MCP servers, skills and instructions"]'), null)
  assert.ok(document.body.querySelector('select[aria-label="Account"]'))
  assert.ok(document.body.querySelector('[role="slider"]'))
})

test('subordinate gear keeps editable scope and submits its staged grants', async t => {
  const c = await setup(t, false)
  await click(c.card('boss').querySelector('.hsof:not(.side) button.t-sol'))
  await advance(1200)
  await click(c.v.el.querySelector('.sq.draft .df-gear'))
  assert.equal(document.body.querySelector('.draft-scope-inherited'), null)
  const visibility = document.body.querySelector<HTMLSelectElement>('select[aria-label="Visible agents"]')!
  assert.ok(visibility)
  await inAct(() => { visibility.value = 'subtree'; visibility.dispatchEvent(new Event('change', { bubbles: true })) })
  await click([...document.body.querySelectorAll('button')].find(el => el.textContent === 'apply'))
  await c.submit()
  assert.equal(c.accepted.length, 1)
  assert.deepEqual(c.accepted[0].add_dirs, [{ path: 'D:/synthetic/boss', mode: 'ro' }])
  assert.equal(c.accepted[0].org_visibility, 'subtree')
  assert.equal((c.accepted[0].tools as Record<string, unknown>).bash, true)
})

for (const target of ['boss', 'worker']) {
  test(`superior draft above ${target === 'boss' ? 'a root agent' : 'a nested agent'} preserves the operation anchor through undo history`, async t => {
    const c = await setup(t, true)
    await click(c.card(target).querySelector('.hsof.side-t button.t-sol')); await c.submit()
    assert.equal(c.requests.length, 1, 'one atomic hire, no subsequent move')
    assert.equal(c.requests[0].hire_type, 'superior')
    assert.equal(c.requests[0].target, target, 'history keeps the child below the insertion')
    assert.equal(c.requests[0].above, target, 'the engine operation receives the same anchor')
    assert.equal(c.requests[0].parent, target === 'boss' ? null : 'boss')
  })
}

test('without undo history the superior draft keeps the existing atomic above operation', async t => {
  const c = await setup(t, false)
  await click(c.card('boss').querySelector('.hsof.side-t button.t-sol')); await c.submit()
  assert.equal(c.requests.length, 1)
  assert.equal(c.requests[0].above, 'boss')
  assert.equal(c.requests[0].parent, null)
})

test('a subordinate hire stays subordinate and never acquires a superior target', async t => {
  const c = await setup(t, true)
  await click(c.card('boss').querySelector('.hsof:not(.side) button.t-sol')); await c.submit()
  assert.equal(c.requests.length, 1)
  assert.equal(c.requests[0].parent, 'boss')
  assert.equal(c.requests[0].above, undefined)
  assert.equal(c.requests[0].target, undefined)
})
