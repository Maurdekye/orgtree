import { advance, FakeServer, flush, inAct, installFetch, mountView, realClock, useFakeClock } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { OrgCanvas } from '../src/canvas/OrgCanvas'
import { beginFirstUse, firstUseProgress, firstUseSent } from '../src/canvas/firstuse'
import { resetConvos } from '../src/convo'
import type { OpResult, TreePayload } from '../src/types'

const born = (id = 'lead') => ({ id, title: id, tier: 'sol', state: 'live', children: [],
  seat: 2, grant: 12, free: 12, generation: 0, scope: { tools: {}, add_dirs: [] },
  turns: [], audiences_held: [], lineage: [], last_denials: [], frozen: null })
async function click(el: Element | null | undefined) {
  assert.ok(el, 'intended control exists')
  await inAct(async () => { (el as HTMLElement).click(); await flush() })
}
async function setup(t: test.TestContext, history = false) {
  useFakeClock(); localStorage.clear(); installFetch(new FakeServer())
  const original = globalThis.fetch
  let resolve!: (r: OpResult) => void, reject!: (e: Error) => void, requests = 0
  const response = new Promise<OpResult>((yes, no) => { resolve = yes; reject = no })
  const data = { slug: 'first-use-race', name: 'Synthetic first-use race', roots: [], dirs: [], tiers: { sol: 2 },
    undo_history: history, default_top_grant: 12, max_top_grant: 100, cascade_hire: true,
    default_visibility: 'team', default_tools: {}, audiences: [], audience_requests: [], credit_requests: [],
    user_inbox_count: 0 } as unknown as TreePayload
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    if (String(url).endsWith('/gesture')) {
      assert.equal(JSON.parse(String(init?.body)).steps[0].op, 'hire')
      requests++
      const result = await response
      return new Response(JSON.stringify({ results: [result] }), { headers: { 'content-type': 'application/json' } })
    }
    return original(url, init)
  }) as typeof fetch
  beginFirstUse(data.slug)
  const render = (tree = data) => <OrgCanvas tree={tree} slug={data.slug} mailEvt={null} toast={() => {}}
    op={() => { requests++; return response }} />
  const view = await mountView(render(), el => el)
  t.after(async () => { await view.unmount(); resetConvos(); realClock(); globalThis.fetch = original })
  assert.equal(firstUseProgress(data.slug)?.step, 'token')
  await click(view.el.querySelector('.sq.user button.t-sol'))
  await advance(1200)
  assert.equal(firstUseProgress(data.slug)?.step, 'name')
  const input = view.el.querySelector<HTMLInputElement>('.sq.draft .df-name')!
  await inAct(() => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(input, 'lead')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  assert.equal(firstUseProgress(data.slug)?.step, 'hire')
  return { view, slug: data.slug, resolve, reject,
    submit: async () => { await click(view.el.querySelector('.df-foot button.primary')); assert.equal(requests, 1) },
    feed: (id = 'lead') => view.render(render({ ...data, roots: [born(id)] } as unknown as TreePayload)),
    progress: () => firstUseProgress(data.slug) }
}

for (const history of [false, true]) {
  test(`first-use response before feed advances and stays at message, history=${history}`, async t => {
    const c = await setup(t, history); await c.submit()
    await inAct(async () => { c.resolve({ node: 'lead' }); await flush() })
    assert.deepEqual(c.progress(), { step: 'message', agent: 'lead' })
    assert.ok(c.view.el.querySelector('.sq.draft'), 'response-first keeps the pending placeholder')
    await c.feed(); await advance(160)
    assert.equal(c.view.el.querySelector('.sq.draft'), null)
    assert.deepEqual(c.progress(), { step: 'message', agent: 'lead' })
  })
  test(`first-use feed before response advances at replacement and late response preserves completion, history=${history}`, async t => {
    const c = await setup(t, history); await c.submit()
    await c.feed(); await advance(160)
    assert.equal(c.view.el.querySelector('.sq.draft'), null, 'the actual hire replaced the draft before response')
    assert.deepEqual(c.progress(), { step: 'message', agent: 'lead' }, 'replacement is a successful hire, never cancellation')
    await inAct(() => firstUseSent(c.slug, 'lead'))
    assert.equal(c.progress()?.step, 'done')
    await inAct(async () => { c.resolve({ node: 'lead' }); await flush() })
    assert.equal(c.progress()?.step, 'done', 'late response never reopens a completed guide')
  })
}

test('first-use genuine draft cancellation returns to the token', async t => {
  const c = await setup(t)
  await click([...c.view.el.querySelectorAll('.df-foot button')].find(el => el.textContent?.includes('cancel')))
  assert.equal(c.view.el.querySelector('.sq.draft'), null)
  assert.equal(c.progress()?.step, 'token')
})

test('first-use refusal keeps the hire step editable until genuine cancellation', async t => {
  const c = await setup(t); await c.submit()
  await inAct(async () => { c.reject(Error('synthetic credit refusal')); await flush() })
  assert.equal(c.progress()?.step, 'hire')
  assert.equal(c.view.el.querySelector<HTMLInputElement>('.df-name')?.value, 'lead')
  await click([...c.view.el.querySelectorAll('.df-foot button')].find(el => el.textContent?.includes('cancel')))
  assert.equal(c.progress()?.step, 'token')
})

test('first-use unrelated feed update cannot advance the pending hire', async t => {
  const c = await setup(t); await c.submit()
  await c.feed('unrelated-agent'); await advance(160)
  assert.ok(c.view.el.querySelector('.sq.draft'))
  assert.equal(c.progress()?.step, 'hire')
  await inAct(async () => { c.resolve({ node: 'lead' }); await flush() })
  assert.deepEqual(c.progress(), { step: 'message', agent: 'lead' })
})
