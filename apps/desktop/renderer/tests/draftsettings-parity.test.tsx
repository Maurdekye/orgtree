import { advance, FakeServer, flush, inAct, installFetch, mountView, realClock, useFakeClock } from './harness'
import { closeDraftSettings } from './draftclose.fixture'
import test from 'node:test'
import assert from 'node:assert/strict'
import { OrgCanvas } from '../src/canvas/OrgCanvas'
import { syncFastModes } from '../src/canvas/fastmode'
import { resetConvos } from '../src/convo'
import { CreditGrant } from '../src/canvas/creditgrant'
import type { CanvasNode } from '../src/canvas/shared'
import type { TreePayload } from '../src/types'

const tree = { slug: 'draft-parity', name: 'Synthetic', roots: [], dirs: [], tiers: { sol: 2, astra: 6 },
  default_tools: { bash: true, web: true, edit: true, subagents: true, mcp: [] },
  default_visibility: 'team', permission_mode: 'acceptEdits', default_top_grant: 12, max_top_grant: 100,
  cascade_hire: true, audiences: [], audience_requests: [], credit_requests: [], user_inbox_count: 0,
} as unknown as TreePayload
const panel = () => document.querySelector('.draft-scope')!
const row = (label: string) => [...panel().querySelectorAll('.set-row, .set-block')].find(r => r.querySelector('.set-label')?.textContent === label)!
async function click(el: Element | null | undefined) {
  assert.ok(el, 'required control exists')
  await inAct(async () => { (el as HTMLElement).click(); await flush() })
}
async function edit(el: Element | null | undefined, value: string) {
  assert.ok(el, 'required field exists')
  await inAct(async () => {
    if (el.tagName === 'SELECT') {
      (el as HTMLSelectElement).value = value
      el.dispatchEvent(new Event('change', { bubbles: true }))
    } else {
      const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype
      Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value)
      el.dispatchEvent(new Event('input', { bubbles: true }))
    }
    await flush()
  })
}

for (const history of [false, true]) test(`draft settings tabs persist all preferences and hire atomically, history=${history}`, async t => {
  useFakeClock(); installFetch(new FakeServer())
  syncFastModes([{ tiers: [{ tier: 'sol', fast_mode: true, fast_mode_versions: { '6.1': true, '6': false } }] }] as never)
  const before = globalThis.fetch
  const operations: Record<string, unknown>[] = []
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    if (String(url).endsWith('/gesture')) {
      const body = JSON.parse(String(init?.body)); operations.push(...body.steps)
      return new Response(JSON.stringify({ results: [{ node: 'proposed' }] }), { headers: { 'content-type': 'application/json' } })
    }
    return before(url, init)
  }) as typeof fetch
  const view = await mountView(<OrgCanvas tree={{ ...tree, undo_history: history }} slug={tree.slug} mailEvt={null} toast={() => {}}
    op={async o => { operations.push({ ...o }); return { node: 'proposed' } }} />, el => el)
  t.after(async () => { await view.unmount(); resetConvos(); realClock(); globalThis.fetch = before; syncFastModes([]) })
  await click(view.el.querySelector('.sq.user button.t-sol')); await advance(1200)
  await edit(view.el.querySelector('.df-name'), 'proposed')
  await click(view.el.querySelector('.df-gear'))
  assert.deepEqual([...panel().querySelectorAll('[role="tab"]')].map(el => el.textContent), ['Charter', 'Model', 'Scope', 'Tools'])
  assert.equal(panel().querySelector('[role="tab"][id$="history"]'), null)
  await edit(row('Instructions').querySelector('textarea'), 'Standing task')
  await edit(row('Team instructions').querySelector('textarea'), 'Shared task')
  await click(panel().querySelector('[aria-label="Subordinates may message each other"]'))
  await click(panel().querySelector('[role="tab"][id$="model"]'))
  await edit(panel().querySelector('[aria-label="Model version"]'), '6.1')
  await click(panel().querySelector('[aria-label="Fast mode"]'))
  await edit(panel().querySelector('[aria-label="Automatic account fallback"]'), 'off')
  await edit(row('Start fresh when needed').querySelector('select'), 'on')
  await edit(row('Conversation size').querySelector('input'), '40')
  await click(panel().querySelector('[role="tab"][id$="scope"]'))
  const credit = panel().querySelector('[role="slider"][aria-label="Credit grant"]')!
  assert.ok(credit, 'same credit editor is available before hire')
  await inAct(async () => {
    credit.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    credit.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowRight', bubbles: true })); await flush()
  })
  await edit(panel().querySelector('[aria-label="File and command access"]'), 'plan')
  await edit(panel().querySelector('[aria-label="Desktop session"]'), 'session0')
  await edit(panel().querySelector('[aria-label="Visible agents"]'), 'self')
  await click(panel().querySelector('[role="tab"][id$="tools"]'))
  await click(panel().querySelector('[aria-label="Disabled by Orgtree"]'))
  assert.equal(operations.length, 0, 'draft edits never mutate a live agent')
  assert.equal([...panel().querySelectorAll('button')].some(b => /^(save|apply)$/i.test(b.textContent?.trim() ?? '')), false)
  await closeDraftSettings(panel())
  await click(view.el.querySelector('.df-gear'))
  assert.equal((row('Instructions').querySelector('textarea') as HTMLTextAreaElement).value, 'Standing task')
  assert.equal((row('Team instructions').querySelector('textarea') as HTMLTextAreaElement).value, 'Shared task')
  assert.equal(panel().querySelector('[aria-label="Desktop session"]')?.getAttribute('value') ?? (panel().querySelector('[aria-label="Desktop session"]') as HTMLSelectElement).value, 'session0')
  assert.equal((panel().querySelector('[aria-label="Disabled by Orgtree"]') as HTMLInputElement).checked, true)
  await closeDraftSettings(panel())
  await click(view.el.querySelector('.df-foot button.primary'))
  assert.equal(operations.length, 1)
  const hire = operations[0]!
  for (const [key, value] of Object.entries({ tier: 'sol', grant: 13, charter: 'Standing task', team_charter: 'Shared task',
    peer_mail: false, model_version: '6.1', fast_mode: true, account_fallback: false,
    permission_mode: 'plan', session: 'session0', org_visibility: 'self' })) assert.equal(hire[key], value, key)
  assert.deepEqual(hire.auto_cheap_compact, { enabled: true, occ: .4 })
  assert.equal((hire.tools as Record<string, unknown>).orgtree_disabled, true)
})

test('shared live credit editor still reallocates once on commit and cancels unfinished changes', async t => {
  useFakeClock(); installFetch(new FakeServer())
  const node = { id: 'live', parent: null, tier: 'sol', seat: 2, grant: 12, free: 12, children: [] } as unknown as CanvasNode
  const calls: Record<string, unknown>[] = []
  const view = await mountView(<CreditGrant node={node} map={new Map([[node.id, node]])} tree={tree}
    op={async body => { calls.push({ ...body }); return { grant: 13 } }} />, el => el)
  t.after(async () => { await view.unmount(); realClock() })
  const slider = view.el.querySelector('[role="slider"]')!
  const key = async (type: string, key: string) => inAct(async () => { slider.dispatchEvent(new KeyboardEvent(type, { key, bubbles: true })); await flush() })
  await key('keydown', 'ArrowRight'); await key('keydown', 'Escape'); await key('keyup', 'ArrowRight')
  assert.equal(calls.length, 0)
  await key('keydown', 'ArrowRight'); await key('keyup', 'ArrowRight')
  assert.deepEqual(calls, [{ op: 'reallocate', node: 'live', delta: 1 }])
  assert.equal(slider.getAttribute('aria-valuenow'), '13')
})
