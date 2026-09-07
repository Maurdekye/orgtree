// oneshotdog.test.tsx — D-200: one-shot dogs must remain visibly finite,
// including while paused and during their short post-fire spark tombstone.
//
// Run: cd frontend && node tests/run.mjs oneshotdog

import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { OrgCanvas } from '../src/canvas/OrgCanvas'
import { WatchdogPanel } from '../src/canvas/modals'
import type { TreePayload, Watchdog } from '../src/types'

const noop = () => {}
const asTree = (v: unknown) => v as TreePayload

function dog(id: string, state: Watchdog['state'], once = false, spent = false): Watchdog {
  return {
    id, owner: 'owner', name: id, kind: 'command', target: 'echo dog',
    interval_s: 15, state, at: '2026-08-30T00:00:00Z', fired: spent ? 1 : 0,
    once, spent, events: [],
  }
}

function tree(watchdogs: Watchdog[]): TreePayload {
  return asTree({
    slug: 'mine', name: 'mine', workspace: null, dirs: [], max_top_grant: 1000,
    default_top_grant: 50, compact_at: 0, default_tools: null,
    default_visibility: 'team', default_effort: '', credit_requests: [],
    tiers: { haiku: 1, sonnet: 2, opus: 5, fable: 10,
      'gpt-reserve': 0.2, luna: 0.2, terra: 2, sol: 5 },
    audiences: [], roots: [{
      id: 'owner', title: 'owner', tier: 'haiku', model_id: 'haiku', state: 'live',
      seat: 1, grant: 0, free: 0, ui_order: 0, cost_usd: 0, occupancy: null,
      context_window: null, charter: null, mail_pending: 0, limit_locked: false,
      last_status: null, prev_status: null, inflight_at: null, last_denials: [],
      turns: [], frozen: null, audiences_held: [], bearer_state: null,
      generation: 0, children: [], lineage: [],
      scope: { permission_mode: 'default', add_dirs: [], tools: {}, org_visibility: 'team' },
    }], cost_usd_total: 0,
    audit: { live_nodes: 1, top_level_holds: 0, no_overdraft: true, problems: [] },
    user_inbox_count: 0, user_inbox_newest: null, fable_lock: null,
    spend_frozen: false, storage_blocked: false, auto_resume: false,
    fable_limit_policy: 'freeze', fable_filter_policy: 'halt',
    cascade_hire: false, cascade_alloc: true, sandboxed: false,
    audience_requests: [], org_inbox: null, net: null, watchdogs,
  })
}

test('one-shot satellites carry the finite marker across armed, paused, and spark-tombstone states',
  async (t) => {
    const view = await mountView(
      <OrgCanvas tree={tree([
        dog('persistent', 'armed'), dog('once-armed', 'armed', true),
        dog('once-paused', 'paused', true), dog('once-spent', 'spent', true, true),
      ])} op={() => Promise.resolve({} as never)} slug="mine" toast={noop}
        mailEvt={{ from: 'dog:once-spent', to: 'owner', t: Date.now() }} />,
      (host) => host)
    t.after(() => view.unmount())
    await flush()

    const chips = new Map([...view.el.querySelectorAll('.wd-chip')].map((el) => [
      (el.querySelector('.wd-name')?.textContent ?? ''), el as HTMLElement,
    ]))
    assert.equal(chips.get('persistent')?.classList.contains('oneshot'), false,
      'ordinary persistent dogs remain solid and unmarked')
    for (const name of ['once-armed', 'once-paused', 'once-spent']) {
      const chip = chips.get(name)
      assert.ok(chip?.classList.contains('oneshot'), `${name} keeps the one-shot treatment`)
      assert.equal(chip?.querySelector('.wd-once')?.textContent, '1×')
    }
    assert.ok(chips.get('once-paused')?.classList.contains('paused'),
      'paused one-shots expose both their paused state and finite identity')
    assert.ok(chips.get('once-spent')?.classList.contains('spent'),
      'the tombstone stays drawable as a departing one-shot source for its spark')
    assert.equal(chips.get('once-spent')?.querySelector('.wd-glyph')?.textContent, '↗')
    await inAct(() => new Promise<void>((resolve) => setTimeout(resolve, 24)))
    assert.equal(view.el.querySelectorAll('circle.spark').length, 1,
      'the real dog:<id> fire event starts at the spent tombstone and reaches its owner')
  })

test('a persistent dog fire uses the same satellite-to-owner spark route', async (t) => {
  const view = await mountView(
    <OrgCanvas tree={tree([dog('persistent', 'armed')])}
      op={() => Promise.resolve({} as never)} slug="mine" toast={noop}
      mailEvt={{ from: 'dog:persistent', to: 'owner', t: Date.now() }} />,
    (host) => host)
  t.after(() => view.unmount())
  await inAct(() => new Promise<void>((resolve) => setTimeout(resolve, 24)))
  assert.equal(view.el.querySelectorAll('circle.spark').length, 1,
    'the direct route works at all, rather than only appearing to work from a tombstone')
})

test('a spent one-shot dog can explain its departure but offers no inert controls', async (t) => {
  const spent = dog('once-spent', 'spent', true, true)
  const view = await mountView(
    <WatchdogPanel slug="mine" dog={spent} toast={noop} close={noop} />, (host) => host)
  t.after(() => view.unmount())
  const text = view.el.textContent ?? ''
  assert.match(text, /one-shot dog/i)
  assert.match(text, /spark is travelling/i)
  assert.equal(view.el.querySelectorAll('button.danger').length, 0,
    'removing a tombstone is meaningless')
  assert.equal([...view.el.querySelectorAll('button')].some((b) =>
    /pause|resume/i.test(b.textContent ?? '')), false,
  'a spent dog cannot be paused or resumed')
})
