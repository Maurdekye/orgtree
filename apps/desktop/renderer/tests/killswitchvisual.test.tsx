// killswitchvisual.test.tsx — the red safety treatment (user redesign
// 2026-09-13, docket make-the-killswitch-halt-the-whole-org):
//   · a LIVE halted agent's card wears .halted (cards.tsx pushes it for live
//     nodes only, so a retired card keeps its archived presentation);
//   · the org canvas wears .redalert whenever ANY live agent is halted, and
//     .killswitched exactly when the org latch is set — the stylesheet's
//     `.viewport.killswitched .sq.live` cascade is what paints every live
//     card red without a per-node class;
//   · the desk shows the red halted banner directly above the composer,
//     naming the durable state that holds the agent — its own halt, the org
//     killswitch, or both — read from OrgKillswitchContext (the popout-safe
//     path), and a retired desk never wears it;
//   · the shipped stylesheet actually carries those selectors, read back the
//     same way agentstray.test.tsx reads its rules.
// Run: node tests/run.mjs killswitchvisual

import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'
import { FakeServer, flush, inAct, installFetch, mountView } from './harness'
import { NodeSquare } from '../src/canvas/cards'
import { DeskChat, HaltedBanner, OrgKillswitchContext } from '../src/canvas/desk'
import type { CanvasNode } from '../src/canvas/shared'
import type { OpResult, TreePayload } from '../src/types'

declare const __SRC_DIR__: string

const noop = () => {}
const op = () => Promise.resolve({} as OpResult)
const seats = { haiku: 1, sonnet: 2, opus: 5, fable: 10, luna: .2 }
const hire = { enabled: true, installed: true, reason: null }
const halted = { phase: 'halted' as const, by: 'user', requested_at: '2026-09-12' }

function node(id: string, props: Partial<CanvasNode> = {}): CanvasNode {
  return {
    id, title: id, state: 'live', tier: 'haiku', model_id: 'haiku',
    seat: 1, grant: 0, free: 0, scope: { tools: {}, add_dirs: [] },
    children: [], lineage: [], turns: [], audiences_held: [],
    bearer_state: null, frozen: null, limit_locked: false,
    mail_pending: 0, last_status: null, prev_status: null, inflight_at: null,
    last_denials: [], occupancy: null, context_window: null, busy: false,
    proc_warm: false, proc_live: false, isBearerOf: null,
    generation: 0,
    ...props,
  } as unknown as CanvasNode
}

function card(n: CanvasNode, lod: 'mini' | 'norm' = 'norm') {
  return <NodeSquare key={n.id} node={n} pos={{ x: 0, y: 0 }} lod={lod} focused={false}
    dragging={false} isDrop={false} seats={seats} codexHire={hire}
    antigravityHire={hire} claudeHire={hire} map={new Map([[n.id, n]])}
    op={op} slug="redalert" toast={noop} pxc={1} zoom={lod === 'mini' ? .4 : .8}
    compactAt={.8} pub={false} maxTop={100} kioskRemaining={null}
    cascadeAlloc onSpawn={noop} onSpawnSide={noop} onSpawnTop={noop}
    onConfig={noop} onInbox={noop} onLineage={noop} onOpenDoc={noop}
    onRecenter={noop} onJump={noop} onMailLink={noop}
    onDragStart={noop} onDragMove={noop} onDragEnd={noop}
    onDragCancel={noop} onPin={noop} pinned={false} />
}

test('§1 a live halted card wears .halted; un-halted and archived never do', async () => {
  const view = await mountView(card(node('worker', { halt: halted })), (el) => el)
  try {
    const sq = () => view.el.querySelector('.sq')!
    assert.ok(sq().classList.contains('halted'), 'live + halt → .halted')
    await view.render(card(node('worker')))
    assert.ok(!sq().classList.contains('halted'), 'no halt → no .halted')
    await view.render(card(node('worker', { halt: halted, state: 'archived' })))
    assert.ok(!sq().classList.contains('halted'),
      'a retired card keeps its archived presentation (docket rev 4)')
    await view.render(card(node('worker', { halt: halted }), 'mini'))
    assert.ok(sq().classList.contains('halted'), 'the mini card shares the class list')
  } finally { await view.unmount() }
})

test('§2 HaltedBanner names the durable state that holds the agent', async () => {
  const view = await mountView(
    <HaltedBanner halt={null} killswitched={false} live />, (el) => el)
  const banner = () => view.el.querySelector('.halted-send-warning')
  try {
    assert.equal(banner(), null, 'nothing held → no banner')
    await view.render(<HaltedBanner halt={halted} killswitched={false} live />)
    assert.match(banner()!.textContent!, /explicitly unhalted/)
    await view.render(<HaltedBanner halt={{ ...halted, phase: 'halting' }}
      killswitched={false} live />)
    assert.match(banner()!.textContent!, /active turn settles/)
    await view.render(<HaltedBanner halt={null} killswitched live />)
    assert.match(banner()!.textContent!, /killswitch latched — every agent here is halted/i)
    await view.render(<HaltedBanner halt={halted} killswitched live />)
    assert.match(banner()!.textContent!, /individually halted AND the org killswitch/)
    await view.render(<HaltedBanner halt={halted} killswitched live={false} />)
    assert.equal(banner(), null, 'a retired desk keeps its archived presentation')
  } finally { await view.unmount() }
})

test('§3 the desk banner reads the org latch from context (the popout-safe path)', async () => {
  installFetch(new FakeServer())
  const n = node('worker')
  const view = await mountView(
    <OrgKillswitchContext.Provider value={true}>
      <DeskChat node={n} map={new Map([[n.id, n]])} slug="latched-org"
        op={op} toast={noop} pub={false} bare />
    </OrgKillswitchContext.Provider>, (el) => el)
  try {
    await flush()
    const banner = view.el.querySelector('.halted-send-warning')
    assert.ok(banner, 'the latched org shows the banner on every live desk')
    assert.match(banner!.textContent!, /killswitch latched/i)
  } finally { await view.unmount() }
})

test('§4 the un-latched desk banner follows the per-agent halt alone', async () => {
  installFetch(new FakeServer())
  const n = node('worker', { halt: halted })
  const view = await mountView(
    <OrgKillswitchContext.Provider value={false}>
      <DeskChat node={n} map={new Map([[n.id, n]])} slug="halted-agent"
        op={op} toast={noop} pub={false} bare />
    </OrgKillswitchContext.Provider>, (el) => el)
  try {
    await flush()
    const banner = view.el.querySelector('.halted-send-warning')
    assert.ok(banner, 'an individually halted live desk shows the banner')
    assert.match(banner!.textContent!, /explicitly unhalted/)
    assert.doesNotMatch(banner!.textContent!, /killswitch/i,
      'an individual halt never claims the org-wide killswitch state')
  } finally { await view.unmount() }
})

/** shaped like the payload, not type-checked into it — the agentstray idiom,
 *  trimmed to what OrgCanvas actually dereferences */
const asTree = (v: unknown) => v as TreePayload

function tree(roots: CanvasNode[], killswitch: { at: string; by: string } | null = null): TreePayload {
  return asTree({
    slug: 'mine', name: 'mine', workspace: null, dirs: [], max_top_grant: 1000,
    default_top_grant: 50, compact_at: 0, default_tools: null,
    default_visibility: 'team', default_effort: '', credit_requests: [],
    tiers: { haiku: 1, sonnet: 3, opus: 5, fable: 10 }, audiences: [],
    roots, cost_usd_total: 0,
    audit: { live_nodes: roots.length, top_level_holds: 0, no_overdraft: true, problems: [] },
    user_inbox_count: 0, user_inbox_newest: null, fable_lock: null,
    killswitch,
    spend_frozen: false, storage_blocked: false, auto_resume: false,
    fable_limit_policy: 'freeze', fable_filter_policy: 'halt',
    cascade_hire: false, cascade_alloc: true, sandboxed: false,
    audience_requests: [], org_inbox: null, net: null,
  })
}

test('§5 the canvas outline follows any-halt; .killswitched follows the latch alone', async () => {
  const { OrgCanvas } = await import('../src/canvas/OrgCanvas')
  const mountTree = (t: TreePayload) => mountView(
    <OrgCanvas tree={t} op={op} slug="mine" toast={noop} mailEvt={null} />, (el) => el)

  let view = await mountTree(tree([node('ceo'), node('cto')]))
  try {
    await flush()
    let vp = view.el.querySelector('.viewport')!
    assert.ok(!vp.classList.contains('redalert'), 'clean org → no outline')
    assert.ok(!vp.classList.contains('killswitched'), 'clean org → no latch class')
  } finally { await view.unmount() }

  view = await mountTree(tree([node('ceo'), node('cto', { halt: halted })]))
  try {
    await flush()
    const vp = view.el.querySelector('.viewport')!
    assert.ok(vp.classList.contains('redalert'),
      'one halted agent outlines the org (docket rev 4)')
    assert.ok(!vp.classList.contains('killswitched'),
      'an individual halt never claims the org-wide killswitch state')
  } finally { await view.unmount() }

  view = await mountTree(tree([node('ceo'), node('cto')],
    { at: '2026-09-13T09:00:00Z', by: 'USER' }))
  try {
    await flush()
    const vp = view.el.querySelector('.viewport')!
    assert.ok(vp.classList.contains('killswitched'), 'the latch marks the org')
    assert.ok(vp.classList.contains('redalert'),
      'a killswitch latch always outlines the org')
  } finally { await view.unmount() }

  // an ARCHIVED halted seat must not outline the org: the rule counts live
  // agents (retirement participates in admission, not in the red theme)
  view = await mountTree(tree([node('ceo'),
    node('old', { halt: halted, state: 'archived' })]))
  try {
    await flush()
    const vp = view.el.querySelector('.viewport')!
    assert.ok(!vp.classList.contains('redalert'),
      'a retired seat carrying a stale halt record does not outline the org')
  } finally { await view.unmount() }
})

test('§6 the shipped stylesheet carries the red-alert contract', () => {
  const css = readFileSync(path.join(__SRC_DIR__, 'styles.css'), 'utf8')
  for (const selector of [
    '.sq.halted, .viewport.killswitched .sq.live',
    '.sq.mini.halted, .viewport.killswitched .sq.live.mini',
    '.viewport.redalert',
    '.halted-send-warning',
    '.kill-release',
  ]) {
    assert.ok(css.includes(selector), `styles.css lost the "${selector}" rule`)
  }
  // the cascade must stay scoped to LIVE cards: retired cards keep their
  // archived presentation (docket rev 4)
  assert.ok(!/\.viewport\.killswitched \.sq[^.]/.test(css),
    'the killswitched cascade must target .sq.live, never bare .sq')
})
