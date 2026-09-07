// bearerchip.test.tsx — a live knowledge bearer's card states its LIFECYCLE
// and its PROVENANCE as two separate things (user report 2026-08-28).
//
// The user looked at two cards side by side and asked why two piles of retired
// agents had not merged. One of them was not retired: it was a rehired
// knowledge bearer, live, mid-turn, running a test tier. "it looks retired...
// the ui is too similar. it needs to look more like a normal agent."
//
// Two halves to that defect. The STYLESHEET half — `.sq.bearer` applying a
// lifecycle wash that beat the tier stripe, the busy border and sat beside
// `.sq.archived`'s fade — is a cascade question and is measured in a real
// browser by tests/bearercard_probe.py, because jsdom does not resolve a
// cascade and an assertion about colour there would be theatre.
//
// This suite owns the MARKUP half, which jsdom can answer honestly:
//
//   §1 is the contract the stylesheet half depends on. The CSS fix is scoped
//      `.sq.bearer:not(.live)`, so it is only correct for as long as a live
//      bearer's card actually carries the `live` class alongside `bearer`. If
//      that class list ever changes shape, the wash silently comes back for
//      live agents and NO stylesheet test would notice — the sheet would still
//      be right, about a card that no longer exists.
//   §2-§5 are the chips. They used to be one `badge dim` in which the bearer
//      state STOOD IN for the lifecycle state: a live bearer's only chip read
//      `knowledge`, in the same grey, in the slot where every other card says
//      `archived`. Now the lifecycle chip appears on exactly the cards that
//      are not live, and the bearer mark is its own chip beside it.
//
// ANTI-VACUITY: §4 and §5 assert the plain (non-bearer) cards in both states
// with the same queries, so a §2/§3 pass cannot be a selector that matches
// nothing. §5 in particular fails if the lifecycle chip is dropped for
// everyone rather than un-swallowed.
//
// Run:  cd frontend && node tests/run.mjs bearerchip

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
 *  audpile/agentstray, trimmed to what OrgCanvas actually dereferences */
const asTree = (v: unknown) => v as TreePayload

interface FixNode {
  id: string
  state?: string
  /** knowledge | preserving — the field the card keys `bearer` on */
  bearer?: string | null
  /** predecessor sessions; a rehired bearer really has one, and it is what
   *  draws the layers badge and the `.sq.stack1` offset shadow */
  lineage?: number
  children?: FixNode[]
}

function mk(n: FixNode): unknown {
  return {
    id: n.id, title: n.id, tier: 'opus', model_id: 'opus',
    state: n.state ?? 'live',
    seat: 1, grant: 0, free: 0, ui_order: 0, cost_usd: 0, occupancy: null,
    context_window: null, charter: null, mail_pending: 0, limit_locked: false,
    last_status: null, prev_status: null, inflight_at: null, last_denials: [],
    turns: [], frozen: null, audiences_held: [],
    bearer_state: n.bearer ?? null,
    generation: 0, children: (n.children ?? []).map(mk),
    lineage: Array.from({ length: n.lineage ?? 0 }, (_, i) => ({
      id: `${n.id}@${i}`, generation: i, state: 'archived',
      bearer_state: 'knowledge', tier: 'opus',
    })),
    scope: { permission_mode: 'default', add_dirs: [], tools: {}, org_visibility: 'team' },
  }
}

function tree(roots: FixNode[]): TreePayload {
  return asTree({
    slug: 'mine', name: 'mine', workspace: null, dirs: [], max_top_grant: 1000,
    default_top_grant: 50, compact_at: 0, default_tools: null,
    default_visibility: 'team', default_effort: '', credit_requests: [],
    tiers: { haiku: 1, sonnet: 3, opus: 5, fable: 10 },
    audiences: [],
    roots: roots.map(mk), cost_usd_total: 0,
    audit: { live_nodes: roots.length, top_level_holds: 0, no_overdraft: true, problems: [] },
    user_inbox_count: 0, user_inbox_newest: null, fable_lock: null,
    spend_frozen: false, storage_blocked: false, auto_resume: false,
    fable_limit_policy: 'freeze', fable_filter_policy: 'halt',
    cascade_hire: false, cascade_alloc: true, sandboxed: false,
    audience_requests: [], org_inbox: null, net: null,
  })
}

/** The four cards under test, all mounted at once so one render answers every
 *  question and no assertion can be comparing two different mounts.
 *
 *  ⚠ THE TWO ARCHIVED CARDS HANG OFF DIFFERENT PARENTS ON PURPOSE. Two or more
 *  archived siblings collapse into a retired pile, and a buried member is not
 *  rendered as its own `.sq` — the first draft of this fixture put all four
 *  under `boss` and `bearer-arch` simply was not in the DOM, which reads as a
 *  markup failure and is not one. One archived child per parent, no pile.  */
const ORG: FixNode[] = [{
  id: 'boss',
  children: [
    {
      id: 'bearer-live',
      bearer: 'knowledge',
      lineage: 1,
      children: [
        { id: 'bearer-arch', state: 'archived', bearer: 'knowledge', lineage: 1 },
      ],
    },
    { id: 'plain-live', children: [{ id: 'plain-arch', state: 'archived' }] },
  ],
}]

async function cards(
  mount: (el: React.ReactElement) => Promise<{ el: HTMLElement }>,
): Promise<Map<string, HTMLElement>> {
  const { OrgCanvas } = await import('../src/canvas/OrgCanvas')
  const { el } = await mount(
    <OrgCanvas tree={tree(ORG)} op={() => Promise.resolve({} as never)}
      slug="mine" toast={noop} mailEvt={null} />)
  await flush()
  const out = new Map<string, HTMLElement>()
  for (const sq of el.querySelectorAll<HTMLElement>('.sq')) {
    const name = sq.querySelector('.name')?.textContent?.trim()
    if (name) out.set(name, sq)
  }
  // Name every card the suite needs UP FRONT rather than letting a §
  // dereference undefined: a missing card is a fixture fault, and it must not
  // be reportable as "the chips are wrong".
  for (const want of ['bearer-live', 'plain-live', 'bearer-arch', 'plain-arch']) {
    assert.ok(out.has(want),
      `fixture fault: ${want} did not render as a card — the DOM has `
      + `${[...out.keys()].join(', ') || '(nothing)'}`)
  }
  return out
}

/** the chips on one card, as [class, text] pairs */
function chipsOf(sq: HTMLElement): [string, string][] {
  return [...sq.querySelectorAll('.sq-badges > *')]
    .map((e) => [e.className, (e.textContent ?? '').trim()] as [string, string])
    // the layers/turn-ago/status chips are not this suite's business
    .filter(([c]) => !c.includes('stackbadge') && !c.includes('turnago')
      && !c.includes('statuschip'))
}

uiTest('§1 a LIVE bearer card carries `live` AND `bearer` — the class pair the '
  + 'stylesheet fix is scoped on', async ({ mount }) => {
  const c = await cards(mount)
  const cls = c.get('bearer-live')!.className.split(/\s+/)
  assert.ok(cls.includes('bearer'),
    `live bearer lost its \`bearer\` class: ${cls.join(' ')}`)
  assert.ok(cls.includes('live'),
    'live bearer no longer carries the `live` class — `.sq.bearer:not(.live)` '
    + 'would silently start washing LIVE agents again and the stylesheet '
    + `would still look correct: ${cls.join(' ')}`)
})

uiTest('§2 …and an ARCHIVED bearer carries `archived` and NOT `live`, so the '
  + 'wash still reaches it', async ({ mount }) => {
  const c = await cards(mount)
  const cls = c.get('bearer-arch')!.className.split(/\s+/)
  assert.ok(cls.includes('bearer') && cls.includes('archived'),
    `archived bearer: ${cls.join(' ')}`)
  assert.ok(!cls.includes('live'), `archived bearer claims to be live: ${cls.join(' ')}`)
})

uiTest('§3 a live bearer shows the bearer mark and NO lifecycle chip',
  async ({ mount }) => {
    const c = await cards(mount)
    const chips = chipsOf(c.get('bearer-live')!)
    assert.deepEqual(chips, [['badge bearermark', 'knowledge']],
      'a live bearer should say `knowledge` in its own chip and claim no '
      + 'lifecycle state at all')
  })

uiTest('§4 an archived bearer shows BOTH — `archived` first, then the mark',
  async ({ mount }) => {
    const c = await cards(mount)
    const chips = chipsOf(c.get('bearer-arch')!)
    assert.deepEqual(chips, [
      ['badge dim', 'archived'],
      ['badge bearermark', 'knowledge'],
    ], 'the lifecycle chip used to be swallowed by the bearer chip '
      + '(`archived · knowledge` in one grey badge) — they are two facts')
  })

uiTest('§5 CONTROL: the plain cards are unchanged — live shows no chip, '
  + 'archived shows exactly the lifecycle one', async ({ mount }) => {
  const c = await cards(mount)
  assert.deepEqual(chipsOf(c.get('plain-live')!), [],
    'a plain live agent should carry no lifecycle or bearer chip')
  assert.deepEqual(chipsOf(c.get('plain-arch')!), [['badge dim', 'archived']],
    'a plain archived agent must still say `archived` — if this is empty the '
    + 'lifecycle chip was dropped for everyone rather than un-swallowed, and '
    + '§3 would be passing for the wrong reason')
})
