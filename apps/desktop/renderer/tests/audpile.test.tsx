// audpile.test.tsx — audience lines into a RETIRED PILE (user bug 2026-08-24):
// several pile members holding a user audience each drew their own orange
// line, and because buried members sit at EXACTLY their front card's position
// (layout assigns them the front's coordinates), the strokes were fully
// coincident — the stacked alpha made that region far too bright. The ruling:
// draw at most ONE actual audience line from a pile, not N lines overlaid.
//
// ⚠ What this suite can and cannot prove (jsdom does no layout, and "too
// bright" is not a DOM property): it verifies the EDGE COUNT — exactly one
// `path.aud-line` for a pile however many members hold an audience — and that
// genuinely distinct lines still draw one each. Whether the result LOOKS
// right is verified by a human on a live canvas, as with everything visual.
//
// ANTI-VACUITY: §2 asserts the opposite direction (two live holders → two
// lines) with the same counter, so §1/§3 cannot be passing because the
// counter finds nothing at all.
//
// Run:  cd frontend && node tests/run.mjs audpile

import { flush, mountView, realClock, useFakeClock } from './harness'
import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import type { TreePayload } from '../src/types'

const noop = () => {}

function uiTest(name: string,
  body: (k: { mount: (el: React.ReactElement)
    => Promise<{ el: HTMLElement }> }) => Promise<void>): void {
  test(name, async (t: TestContext) => {
    useFakeClock()
    const open: { unmount: () => Promise<void> }[] = []
    t.after(async () => {
      for (const m of open) { try { await m.unmount() } catch { /* gone */ } }
      realClock()
    })
    await body({
      mount: async (el) => {
        const v = await mountView(el, (host) => host)
        open.push(v)
        return { el: v.el }
      },
    })
  })
}

/** shaped like the payload, not type-checked into it — the fixture idiom of
 *  mailwire/agentstray, trimmed to what OrgCanvas actually dereferences */
const asTree = (v: unknown) => v as TreePayload

interface FixNode { id: string; state?: string; children?: FixNode[] }

function mk(n: FixNode): unknown {
  return {
    id: n.id, title: n.id, tier: 'haiku', model_id: 'haiku',
    state: n.state ?? 'live',
    seat: 1, grant: 0, free: 0, ui_order: 0, cost_usd: 0, occupancy: null,
    context_window: null, charter: null, mail_pending: 0, limit_locked: false,
    last_status: null, prev_status: null, inflight_at: null, last_denials: [],
    turns: [], frozen: null, audiences_held: [], bearer_state: null,
    generation: 0, children: (n.children ?? []).map(mk), lineage: [],
    scope: { permission_mode: 'default', add_dirs: [], tools: {}, org_visibility: 'team' },
  }
}

function tree(roots: FixNode[],
  audiences: { grantor: string; grantee: string }[]): TreePayload {
  return asTree({
    slug: 'mine', name: 'mine', workspace: null, dirs: [], max_top_grant: 1000,
    default_top_grant: 50, compact_at: 0, default_tools: null,
    default_visibility: 'team', default_effort: '', credit_requests: [],
    tiers: { haiku: 1, sonnet: 3, opus: 5, fable: 10 },
    audiences: audiences.map((a) => ({
      ...a, granted_at: '2026-08-24T00:00:00Z', reason: '',
    })),
    roots: roots.map(mk), cost_usd_total: 0,
    audit: { live_nodes: roots.length, top_level_holds: 0, no_overdraft: true, problems: [] },
    user_inbox_count: 0, user_inbox_newest: null, fable_lock: null,
    spend_frozen: false, storage_blocked: false, auto_resume: false,
    fable_limit_policy: 'freeze', fable_filter_policy: 'halt',
    cascade_hire: false, cascade_alloc: true, sandboxed: false,
    audience_requests: [], org_inbox: null, net: null,
  })
}

async function audLineCount(
  mount: (el: React.ReactElement) => Promise<{ el: HTMLElement }>,
  roots: FixNode[], audiences: { grantor: string; grantee: string }[],
): Promise<number> {
  const { OrgCanvas } = await import('../src/canvas/OrgCanvas')
  const { el } = await mount(
    <OrgCanvas tree={tree(roots, audiences)} op={() => Promise.resolve({} as never)}
      slug="mine" toast={noop} mailEvt={null} />)
  await flush()
  return el.querySelectorAll('path.aud-line').length
}

// a boss with three retired reports: r1..r3 pile up (≥2 archived siblings),
// the default front is the LAST archived child (r3), so r1/r2 are buried —
// both sitting at r3's exact coordinates
const PILED = [{
  id: 'boss',
  children: [
    { id: 'r1', state: 'archived' },
    { id: 'r2', state: 'archived' },
    { id: 'r3', state: 'archived' },
  ],
}]

uiTest('§1 two buried pile members with audiences draw ONE line, not two',
  async ({ mount }) => {
    const n = await audLineCount(mount, PILED,
      [{ grantor: '@user', grantee: 'r1' }, { grantor: '@user', grantee: 'r2' }])
    assert.equal(n, 1,
      `${n} audience lines drawn for one pile — coincident strokes stack `
      + 'their alpha and the pile glows (the 2026-08-24 bug)')
  })

uiTest('§2 CONTROL: two LIVE holders still draw two lines (collapse is pile-scoped)',
  async ({ mount }) => {
    const n = await audLineCount(mount,
      [{ id: 'boss', children: [{ id: 'l1' }, { id: 'l2' }] }],
      [{ grantor: '@user', grantee: 'l1' }, { grantor: '@user', grantee: 'l2' }])
    assert.equal(n, 2,
      'distinct visible grantees must keep their own lines — if this is 1, '
      + 'the dedupe is collapsing by something broader than the drawn pair, '
      + 'and if §1 passed it passed vacuously')
  })

uiTest('§3 front holder + buried holder in one pile still draw ONE line',
  async ({ mount }) => {
    // r3 fronts the pile AND holds an audience; r1 is buried with its own —
    // the pair collapses to the same drawn endpoints and must stay one line
    const n = await audLineCount(mount, PILED,
      [{ grantor: '@user', grantee: 'r3' }, { grantor: '@user', grantee: 'r1' }])
    assert.equal(n, 1,
      `${n} audience lines drawn when the front card and a buried member `
      + 'both hold one — the buried holder must fold into the front\'s line')
  })
