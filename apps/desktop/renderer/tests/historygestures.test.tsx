import { advance, FakeServer, flush, inAct, installFetch, mountView, realClock, useFakeClock } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { NodeConfig } from '../src/canvas/modals'
import { OrgCanvas } from '../src/canvas/OrgCanvas'
import { resetConvos } from '../src/convo'
import type { CanvasNode } from '../src/canvas/shared'
import type { ToastUndo, TreePayload } from '../src/types'

function node(id: string, children: unknown[] = []): CanvasNode {
  return { id, title: id, tier: 'haiku', model_id: 'haiku', state: 'live', parent: 'USER',
    seat: 1, grant: 10, free: 10, ui_order: 0, cost_usd: 0, occupancy: null,
    context_window: null, charter: '', team_charter: '', mail_pending: 0, limit_locked: false,
    last_status: null, prev_status: null, inflight_at: null, last_denials: [],
    turns: [], frozen: null, audiences_held: [], bearer_state: null, generation: 0,
    children, lineage: [], account: 'claude-4',
    scope: { permission_mode: 'default', add_dirs: [], tools: {}, org_visibility: 'team' },
  } as unknown as CanvasNode
}
function tree(roots: CanvasNode[]): TreePayload {
  return { slug: 'gesture-org', name: 'fixture', workspace: null, dirs: [], max_top_grant: 1000,
    default_top_grant: 50, compact_at: 0, default_tools: null, default_visibility: 'team', default_effort: '',
    tiers: { haiku: 1, sonnet: 3, opus: 5, fable: 10 }, audiences: [], roots, cost_usd_total: 0,
    credit_requests: [], audience_requests: [], audit: { live_nodes: roots.length, top_level_holds: 0, no_overdraft: true, problems: [] },
    user_inbox_count: 0, user_inbox_newest: null, fable_lock: null, auto_resume: false,
    fable_limit_policy: 'freeze', fable_filter_policy: 'halt', cascade_hire: false, cascade_alloc: true,
    org_inbox: null, net: null, undo_history: { rev: 1, undo: null, redo: null },
  } as unknown as TreePayload
}

test('retool: settings Save sends account and scope as one gesture and preserves queued disclosures and the journal toast', async t => {
  const original = globalThis.fetch, posts: { path: string; body: Record<string, unknown> }[] = [], messages: string[] = []
  let undo: ToastUndo | undefined, closed = 0
  t.after(() => { globalThis.fetch = original })
  globalThis.fetch = (async (url, init) => {
    const path = new URL(String(url), 'http://localhost').pathname
    if (init?.method === 'POST') posts.push({ path, body: JSON.parse(String(init.body)) })
    return new Response(JSON.stringify(path === '/api/accounts' ? { accounts: [{ id: 'claude-4', provider: 'claude', standing: { state: 'ready' } }] }
      : path.endsWith('/gesture') ? { results: [{ node: 'alice', queued: true, account: 'claude/primary' }, { warnings: ['scope saved'] }],
        history_entry: { id: 12, kind: 'retool', label: 'Settings: alice' } }
      : { servers: [], turns: [], warnings: [] }))
  }) as typeof fetch
  const alice = node('alice')
  const view = await mountView(<NodeConfig node={alice} map={new Map([['alice', alice]])} tree={tree([alice])}
    slug="gesture-org" op={async () => { throw Error('settings escaped its atomic gesture') }}
    toast={(lines, action) => { messages.push(...lines); if (action && typeof action !== 'function') undo = action }} close={() => { closed++ }} />, el => el)
  t.after(() => view.unmount())
  await inAct(async () => { await flush(6) })
  const account = view.el.querySelector<HTMLSelectElement>('select[aria-label="Account"]')!
  assert.ok(account)
  await inAct(() => { account.value = 'claude/primary'; account.dispatchEvent(new Event('change', { bubbles: true })) })
  const save = [...view.el.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent?.trim() === 'save')!
  await inAct(async () => { save.click(); await flush(6) })
  assert.equal(posts.length, 1); assert.equal(posts[0]?.path, '/api/orgs/gesture-org/gesture')
  const steps = posts[0]!.body.steps as Record<string, unknown>[]
  assert.equal(steps.length, 2); assert.deepEqual(steps[0], { op: 'account', node: 'alice', account: 'claude/primary' })
  assert.equal(steps[1]?.op, 'scope'); assert.equal(steps[1]?.node, 'alice')
  assert.equal(typeof posts[0]?.body.request_id, 'string')
  assert.ok(messages.some(line => /queued/.test(line))); assert.ok(messages.includes('scope saved'))
  assert.equal(undo?.label, 'Undo'); assert.equal(closed, 1)
})

test('retire from settings exposes the committed journal entry instead of a guessed rehire', async t => {
  const original = globalThis.fetch, ops: unknown[] = []
  let undo: ToastUndo | undefined
  t.after(() => { globalThis.fetch = original })
  globalThis.fetch = (async () => new Response(JSON.stringify({ accounts: [], servers: [], turns: [] }))) as typeof fetch
  const alice = node('alice')
  const view = await mountView(<NodeConfig node={alice} map={new Map([['alice', alice]])} tree={tree([alice])}
    slug="gesture-org" op={async body => { ops.push(body); return { history_entry: { id: 13, kind: 'retire', label: 'Retire alice' } } }}
    toast={(_lines, action) => { if (action && typeof action !== 'function') undo = action }} close={() => {}} />, el => el)
  t.after(() => view.unmount())
  const retire = [...view.el.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent?.trim().startsWith('retire'))!
  assert.ok(retire)
  await inAct(() => retire.click())
  const confirm = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(b => b.textContent?.trim() === 'retire')!
  assert.ok(confirm)
  await inAct(async () => { confirm.click(); await flush(5) })
  assert.deepEqual(ops, [{ op: 'retire', node: 'alice' }]); assert.equal(undo?.label, 'Undo')
})

test('canvas hire gestures', { concurrency: 1 }, async t => {
  for (const placement of ['right', 'top'] as const) await t.test(`hire ${placement} is one transaction using the newborn reference or superior hire`, { timeout: 15000 }, async st => {
    useFakeClock(); resetConvos()
    const original = globalThis.fetch
    installFetch(new FakeServer()); const fixtureFetch = globalThis.fetch
    const posts: Record<string, unknown>[] = [], legacy: unknown[] = []
    globalThis.fetch = (async (url, init) => {
      if (String(url).endsWith('/gesture')) {
        posts.push(JSON.parse(String(init?.body)))
        return new Response(JSON.stringify({ results: [{ node: 'born' }], history_entry: { id: 14, kind: 'hire', label: 'Hire born' } }))
      }
      return fixtureFetch(url, init)
    }) as typeof fetch
    const boss = node('boss')
    const view = await mountView(<OrgCanvas tree={tree([boss])} slug="gesture-org" mailEvt={null}
      op={async body => { legacy.push(body); return { node: 'born' } }} toast={() => {}} />, el => el)
    st.after(async () => { await view.unmount(); resetConvos(); realClock(); globalThis.fetch = original })
    await inAct(async () => { await flush(5) })
    const card = [...view.el.querySelectorAll('.sq')].find(c => c.querySelector('.name')?.textContent === 'boss')!
    const chip = card.querySelector<HTMLButtonElement>(`.hsof.side.side-${placement[0]} button.t-haiku`)!
    assert.ok(chip, 'real side/superior chip exists')
    await inAct(async () => { chip.click(); await flush(5) }); await advance(200)
    const input = view.el.querySelector<HTMLInputElement>('input.df-name')!
    assert.ok(input)
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
    await inAct(async () => {
      setter.call(input, 'born'); input.dispatchEvent(new Event('input', { bubbles: true })); await flush(3)
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await flush(5)
    })
    assert.equal(posts.length, 1); assert.deepEqual(legacy, [])
    const steps = posts[0]!.steps as Record<string, unknown>[]
    assert.equal(steps[0]?.op, 'hire'); assert.equal(steps[0]?.name, 'born')
    if (placement === 'right') {
      assert.equal(steps.length, 2); assert.deepEqual(steps[1], { op: 'reorder', node: '$0.node', after: 'boss' })
    } else {
      assert.equal(steps.length, 1); assert.equal(steps[0]?.hire_type, 'superior'); assert.equal(steps[0]?.target, 'boss')
    }
  })
})
