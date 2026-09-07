// queuedswitch.test.tsx — D-234's visible flag (user requirement 2026-09-03:
// "there should be some flag somewhere visible on the agent that it will occur
// next turn"). The card must WEAR a queued switch, naming the target tier, for
// as long as `pending_switch` is set — and wear nothing once it is not.
//
//   §1 the badge, with the target tier and WHEN, on the queued card
//   §2 the compact mark beside the tier letter
//   §3 anti-vacuity: the plain busy card carries neither
//
// Run:  cd frontend && node tests/run.mjs queuedswitch

import { flush, mountView, realClock, useFakeClock } from './harness'
import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import type { TreePayload } from '../src/types'

const noop = () => {}
const asTree = (v: unknown) => v as TreePayload

/** shaped like the payload, not type-checked into it — the fixture idiom of
 *  bearerchip/audpile, trimmed to what OrgCanvas actually dereferences */
function mk(id: string, extra: Record<string, unknown> = {}): unknown {
  return {
    id, title: id, tier: 'opus', model_id: 'opus', state: 'live',
    seat: 5, grant: 0, free: 0, ui_order: 0, cost_usd: 0, occupancy: null,
    context_window: null, charter: null, mail_pending: 0, limit_locked: false,
    last_status: null, prev_status: null, inflight_at: null, last_denials: [],
    turns: [], frozen: null, audiences_held: [], bearer_state: null,
    generation: 0, children: [], lineage: [],
    scope: { permission_mode: 'default', add_dirs: [], tools: {}, org_visibility: 'team' },
    ...extra,
  }
}

function tree(roots: unknown[]): TreePayload {
  return asTree({
    slug: 'mine', name: 'mine', workspace: null, dirs: [], max_top_grant: 1000,
    default_top_grant: 50, compact_at: 0, default_tools: null,
    default_visibility: 'team', default_effort: '', credit_requests: [],
    tiers: { haiku: 1, sonnet: 3, opus: 5, fable: 10, flash: 1, pro: 2 },
    audiences: [],
    roots, cost_usd_total: 0,
    audit: { live_nodes: roots.length, top_level_holds: 0, no_overdraft: true, problems: [] },
    user_inbox_count: 0, user_inbox_newest: null, fable_lock: null,
    spend_frozen: false, storage_blocked: false, auto_resume: false,
    fable_limit_policy: 'freeze', fable_filter_policy: 'halt',
    cascade_hire: false, cascade_alloc: true, sandboxed: false,
    audience_requests: [], org_inbox: null, net: null,
  })
}

test('D-234: the queued card wears "→ <tier> next turn"; the plain card wears nothing',
  async (t: TestContext) => {
    useFakeClock()
    const open: { unmount: () => Promise<void> }[] = []
    t.after(async () => {
      for (const m of open) { try { await m.unmount() } catch { /* gone */ } }
      realClock()
    })
    const { OrgCanvas } = await import('../src/canvas/OrgCanvas')
    const v = await mountView(
      <OrgCanvas tree={tree([
        mk('queued', {
          busy: true, inflight_at: '2026-09-03T10:00:00Z',
          pending_switch: { tier: 'flash', from: 'opus', by: '@user',
            at: '2026-09-03T10:00:00Z', crossing: true },
        }),
        mk('plain', { busy: true, inflight_at: '2026-09-03T10:00:00Z' }),
      ])} op={() => Promise.resolve({} as never)} slug="mine" toast={noop}
        mailEvt={null} />,
      (host) => host)
    open.push(v)
    await flush()
    const cards = new Map<string, HTMLElement>()
    for (const sq of v.el.querySelectorAll<HTMLElement>('.sq')) {
      const name = sq.querySelector('.name')?.textContent?.trim()
      if (name) cards.set(name, sq)
    }
    const q = cards.get('queued')
    const p = cards.get('plain')
    assert.ok(q && p, `fixture cards missing: ${[...cards.keys()].join(',')}`)
    const badge = q!.querySelector<HTMLElement>('.badge.queued')
    assert.ok(badge, '§1 the queued card wears no badge')
    assert.match(badge!.textContent ?? '', /flash/, '§1 the badge does not name the target tier')
    assert.match(badge!.textContent ?? '', /next turn/, '§1 the badge does not say WHEN')
    assert.match(badge!.title, /interrupt/i, '§1 the hover does not name the interrupt')
    assert.ok(q!.querySelector('.queued-mark'), '§2 no compact mark beside the tier letter')
    assert.equal(p!.querySelector('.badge.queued'), null,
      '§3 the plain card wears a badge it has no right to')
    assert.equal(p!.querySelector('.queued-mark'), null,
      '§3 the plain card wears a mark it has no right to')
  })
