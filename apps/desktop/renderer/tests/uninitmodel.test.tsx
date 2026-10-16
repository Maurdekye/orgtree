import { advance, FakeServer, flush, installFetch, mountView, realClock, useFakeClock } from './harness'
import { act } from 'react'
import test from 'node:test'
import assert from 'node:assert/strict'
import { OrgCanvas } from '../src/canvas/OrgCanvas'
import { DraftNode } from '../src/canvas/cards'
import { resetConvos } from '../src/convo'
import type { TreePayload } from '../src/types'

const noop = () => {}
const tree = {
  slug: 'draft-model', name: 'Draft model', roots: [], dirs: [], tiers: { haiku: 1, sol: 2, astra: 6 },
  default_top_grant: 12, max_top_grant: 100, cascade_hire: true,
  audiences: [], audience_requests: [], credit_requests: [], user_inbox_count: 0,
  default_visibility: 'team', default_tools: {},
} as unknown as TreePayload

async function click(el: Element | null) {
  assert.ok(el, 'required control exists')
  await act(async () => { (el as HTMLButtonElement).click(); await flush() })
}
async function type(el: Element | null, value: string) {
  assert.ok(el, 'required field exists')
  const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true })); await flush()
  })
}
const menuItem = (tier: string) => [...document.querySelectorAll('button[role="menuitem"]')]
  .find(b => b.textContent?.startsWith(tier)) ?? null

test('draft model picker', { timeout: 30000 }, async t => {
  await t.test('icon selection reaches final canvas hire and preserves the draft form', async t => {
    useFakeClock(); installFetch(new FakeServer())
    const ops: Record<string, unknown>[] = []
    const v = await mountView(<OrgCanvas tree={tree} slug={tree.slug} toast={noop} mailEvt={null}
      op={async o => { ops.push(o); return { node: 'chosen-model' } }} />, el => el)
    t.after(async () => { await v.unmount(); resetConvos(); realClock() })
    await click(v.el.querySelector('.sq.user button.t-haiku'))
    await advance(200)
    await type(v.el.querySelector('.df-name'), 'chosen-model')
    await type(v.el.querySelector('.df-charter'), 'Keep these standing notes.')
    await click(v.el.querySelector('.df-head button.tier'))
    assert.ok(menuItem('sol'), 'icon opens the shared model picker')
    assert.equal(ops.length, 0, 'opening a picker does not create or switch an agent')
    await click(menuItem('sol'))
    assert.equal((v.el.querySelector('.df-name') as HTMLInputElement).value, 'chosen-model')
    assert.equal((v.el.querySelector('.df-charter') as HTMLTextAreaElement).value, 'Keep these standing notes.')
    assert.ok(v.el.querySelector('.sq.draft.prov-openai'), 'draft provider theme changes')
    assert.ok(v.el.querySelector('.df-head button.tier.t-sol'), 'selected icon changes')
    await click(v.el.querySelector('.df-foot button.primary'))
    assert.equal(ops.length, 1)
    assert.equal(ops[0]!.op, 'hire')
    assert.equal(ops[0]!.tier, 'sol')
    assert.equal(ops[0]!.grant, 12)
    assert.equal(ops[0]!.charter, 'Keep these standing notes.')
    assert.equal(ops[0]!.parent, null)
  })

  await t.test('Escape dismisses the picker and leaves the uninitialized hire intact', async t => {
    useFakeClock(); installFetch(new FakeServer())
    let cancelled = false
    const v = await mountView(<DraftNode pos={{ x: 0, y: 0 }} draft={{ parent: null, tier: 'haiku' }}
      tree={tree} seats={tree.tiers!} map={new Map()} maxTop={100} defaultTop={12} zoom={1} pxc={1}
      onConfirm={noop} onCancel={() => { cancelled = true }} onTierChange={noop} />, el => el)
    t.after(async () => { await v.unmount(); realClock() })
    await click(v.el.querySelector('.df-head button.tier'))
    assert.ok(menuItem('sol'))
    await act(async () => {
      document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
      await flush()
    })
    assert.equal(document.querySelector('[role="menu"]') === null, true)
    assert.equal(cancelled, false, 'picker Escape must not cancel the draft')
  })

  await t.test('a subordinate keeps placement and permissions while dropping a previous-provider account', async t => {
    useFakeClock(); installFetch(new FakeServer())
    const ops: Record<string, unknown>[] = []
    const branch = { ...tree, roots: [{
      id: 'boss', title: 'boss', tier: 'haiku', state: 'live', children: [],
      seat: 1, grant: 30, free: 30, cost_usd: 0, occupancy: null, turns: [],
      frozen: null, last_denials: [], audiences_held: [], lineage: [], generation: 0,
      scope: { permission_mode: 'default', add_dirs: [], tools: { bash: false }, org_visibility: 'team' },
    }] } as unknown as TreePayload
    const v = await mountView(<OrgCanvas tree={branch} slug={tree.slug} toast={noop} mailEvt={null}
      op={async o => { ops.push(o); return { node: 'kept-child' } }} />, el => el)
    t.after(async () => { await v.unmount(); resetConvos(); realClock() })
    const boss = [...v.el.querySelectorAll('.sq:not(.user)')].find(el => el.querySelector('.name')?.textContent === 'boss')
    assert.ok(boss)
    await click(boss.querySelector('.hsof:not(.side) button.t-haiku'))
    await advance(200)
    await type(v.el.querySelector('.df-name'), 'kept-child')
    await click(v.el.querySelector('.df-gear'))
    const visibility = document.querySelector('select[aria-label="Visible agents"]') as HTMLSelectElement
    assert.ok(visibility)
    await act(async () => { visibility.value = 'self'; visibility.dispatchEvent(new Event('change', { bubbles: true })); await flush() })
    await click([...document.querySelectorAll('button')].find(b => b.textContent === 'apply') ?? null)
    await click(v.el.querySelector('.df-head button.tier'))
    await click(menuItem('sol'))
    await click(v.el.querySelector('.df-foot button.primary'))
    assert.equal(ops.length, 1)
    assert.equal(ops[0]!.tier, 'sol')
    assert.equal(ops[0]!.parent, 'boss')
    assert.equal(ops[0]!.grant, 0)
    assert.equal(ops[0]!.org_visibility, 'self')
    assert.equal((ops[0]!.tools as { bash: boolean }).bash, false)
    assert.deepEqual(ops[0]!.add_dirs, [])
    assert.equal('account' in ops[0]!, false, 'a staged Claude account must not reach a Codex hire')
  })

  await t.test('picker follows existing provider offer gates and cannot choose a disabled model', async t => {
    useFakeClock(); installFetch(new FakeServer())
    const picks: string[] = []
    const v = await mountView(<DraftNode pos={{ x: 0, y: 0 }} draft={{ parent: null, tier: 'haiku' }}
      tree={tree} seats={tree.tiers!} map={new Map()} maxTop={100} defaultTop={12} zoom={1} pxc={1}
      onConfirm={noop} onCancel={noop} onTierChange={tier => picks.push(tier)}
      hires={{ codexHire: { installed: true, enabled: false, reason: 'sign in first' },
        antigravityHire: { installed: false, enabled: false, reason: 'not installed' } }} />, el => el)
    t.after(async () => { await v.unmount(); realClock() })
    await click(v.el.querySelector('.df-head button.tier'))
    const sol = menuItem('sol') as HTMLButtonElement
    assert.ok(sol)
    assert.equal(sol.disabled, true)
    assert.match(sol.title, /sign in first/)
    assert.equal(menuItem('flash') === null, true)
    await click(sol)
    assert.deepEqual(picks, [])
  })
})
