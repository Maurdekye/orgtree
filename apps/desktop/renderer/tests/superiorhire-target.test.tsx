import { advance, FakeServer, flush, inAct, installFetch, mountView, realClock, useFakeClock } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { OrgCanvas } from '../src/canvas/OrgCanvas'
import { resetConvos } from '../src/convo'
import { rememberTier } from '../src/quickchat'
import type { OpRequest, TreePayload } from '../src/types'

const agent = (id: string, children: unknown[] = []) => ({ id, title: id, tier: 'sol', state: 'live',
  seat: 2, grant: 80, free: 70, generation: 0, children, turns: [], lineage: [], audiences_held: [],
  last_denials: [], scope: { tools: {}, add_dirs: [] }, frozen: null })
async function click(el: Element | null | undefined) {
  assert.equal(!!el, true, 'the intended control exists')
  await inAct(async () => { (el as HTMLElement).click(); await flush() })
}
async function setup(t: test.TestContext, history: boolean) {
  useFakeClock(); localStorage.clear(); installFetch(new FakeServer())
  const before = globalThis.fetch
  const requests: Record<string, unknown>[] = []
  const tree = { slug: 'superior-target', name: 'Synthetic', roots: [agent('boss', [agent('worker')])],
    dirs: [], tiers: { sol: 2 }, undo_history: history, default_top_grant: 50, max_top_grant: 1000,
    cascade_hire: true, default_visibility: 'team', default_tools: {},
    audiences: [], audience_requests: [], credit_requests: [], user_inbox_count: 0 } as unknown as TreePayload
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    if (String(url).endsWith('/gesture')) {
      const body = JSON.parse(String(init?.body)); requests.push(...body.steps)
      return new Response(JSON.stringify({ results: [{ node: 'manager' }] }), { headers: { 'content-type': 'application/json' } })
    }
    return before(url, init)
  }) as typeof fetch
  const v = await mountView(<OrgCanvas tree={tree} slug={tree.slug} mailEvt={null} toast={() => {}}
    op={async (body: OpRequest) => { requests.push(body as unknown as Record<string, unknown>); return { node: 'manager' } }} />, el => el)
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
  return { v, requests, card, submit }
}

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

test('the shared agent context-menu superior entry retains the same target through submission', async t => {
  const c = await setup(t, true)
  rememberTier('superior-target', 'sol')
  await inAct(() => c.card('boss').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 })))
  await flush(3)
  await click([...document.querySelectorAll<HTMLButtonElement>('.ctxmenu [role="menuitem"]')].find(el => /Hire a superior/.test(el.textContent ?? '')))
  await c.submit()
  assert.equal(c.requests[0].target, 'boss')
  assert.equal(c.requests[0].above, 'boss')
  assert.equal(c.requests.length, 1)
})

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
