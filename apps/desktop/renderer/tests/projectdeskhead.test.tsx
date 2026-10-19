// projectdeskhead.test.tsx — the project desk's HEADER CARDS (docket
// project-desk-header-cards-one-row-not-a-column-w, user 2026-10-19 19:02Z:
// "these header cards should be in a row not a column, also they should have
// color like they do on the zoom card").
//
// WHAT THIS FILE HOLDS THE CODE TO:
//   §1 one row: the cyan listener card, the magenta mail card, the amber
//      slots card and the ↑ superior link share ONE header meta row, on
//      every tab, and the superior link is not drawn a second time;
//   §2 the colours, with the real styles.css: each header card wears its
//      near-zoom badge's colours, outlined and filled, and never the generic
//      grey `.chip` (which, later in styles.css at equal specificity, used to
//      repaint the outlined cards).
//
// Run:  cd apps/desktop/renderer && node tests/run.mjs projectdeskhead

import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { FakeServer, flush, inAct, installFetch, mountView } from './harness'
import { ProjectDesk } from '../src/canvas/projectdesk'
import { ProjectSquare } from '../src/canvas/projectcard'
import type { SlotLease } from '../src/canvas/slots'
import type { CanvasNode, OpResult } from '../src/canvas/shared'
import type { TreePayload, Watchdog } from '../src/types'

declare const __SRC_DIR__: string
const css = readFileSync(path.join(__SRC_DIR__, 'styles.css'), 'utf8')
const noop = () => {}
const refs = { world: { org: 'org' }, onOpen: noop } as never

function project(scope: Record<string, unknown>, extra: Record<string, unknown> = {}): CanvasNode {
  return {
    id: 'sync', title: 'sync', tier: 'project', kind: 'project', state: 'live', model_id: '',
    seat: 0, grant: 0, free: 0, scope: { tools: {}, add_dirs: [] }, configured_scope: { tools: {}, add_dirs: [], ...scope },
    parent: 'boss', charter: 'A rendezvous.',
    children: [{ id: 'sa', title: 'sa', tier: 'haiku', state: 'live', busy: false, children: [] }],
    lineage: [], turns: [], audiences_held: [], mail_pending: 0, mail_held: 0,
    last_status: null, occupancy: 0, context_window: 0, busy: false, activity: null, ...extra,
  } as unknown as CanvasNode
}
const agent = (id: string): CanvasNode => ({
  id, state: 'live', tier: id === 'boss' ? 'opus' : 'haiku', model_id: 'haiku', children: [], seat: 1, grant: 0, free: 0,
  scope: { tools: {}, add_dirs: [] },
} as unknown as CanvasNode)
const dog = (kind: Watchdog['kind'], owner: string, name: string, extra: Partial<Watchdog> = {}): Watchdog =>
  ({ id: owner + '/' + name, owner, name, kind, target: 'sync', interval_s: 5, state: 'armed',
    at: '2026-10-19T07:00:00.000Z', fired: 0, once: false, spent: false, ...extra } as Watchdog)
const lease = (agentId: string, slot: number): SlotLease =>
  ({ project: 'sync', agent: agentId, slot, lease: 'l' + slot, since: '2026-10-19T09:00:00.000Z', reminders: 0 })

/** OUTLINED: one event listener (the dark count card), mail waiting with
 *  nobody listening (the outlined mail card), 2 of 3 slots held */
const outlined = {
  node: project({ slots_capacity: 3 }, { mail_pending: 3 }),
  dogs: [dog('project_listener', 'sa', 'ready')],
  leases: [lease('sa', 1), lease('sb', 2)],
}
/** FILLED: a listener watch (the bright x/y card), a mail listener (the
 *  filled mail card), the one slot held */
const filled = {
  node: project({ slots_capacity: 1 }),
  dogs: [dog('project_listener', 'sa', 'ready'), dog('listener_watch', 'boss', 'all-in', { count: 2 }),
    dog('fair_queue', 'sb', 'mail')],
  leases: [lease('sa', 1)],
}
type Fixture = typeof outlined

function serve(t: TestContext) {
  const had = (globalThis as { fetch?: typeof fetch }).fetch
  installFetch(new FakeServer())
  t.after(() => { (globalThis as { fetch?: typeof fetch }).fetch = had })
}
const treeOf = (f: Fixture) =>
  ({ slug: 'org', roots: [], watchdogs: f.dogs, slot_leases: f.leases } as unknown as TreePayload)
const mapOf = (f: Fixture) =>
  new Map([[f.node.id, f.node], ...['sa', 'sb', 'boss'].map((id) => [id, agent(id)] as [string, CanvasNode])])

async function desk(t: TestContext, f: Fixture) {
  serve(t)
  const jumps: string[] = []
  const view = await mountView(<ProjectDesk node={f.node} slug="org" tree={treeOf(f)} map={mapOf(f)}
    onJump={(id) => jumps.push(id)} op={() => Promise.resolve({} as OpResult)} toast={noop} refs={refs} />, (el) => el)
  t.after(() => view.unmount())
  await inAct(() => flush(3))
  return { view, jumps }
}
async function nearCard(t: TestContext, f: Fixture) {
  const view = await mountView(
    <ProjectSquare node={f.node} pos={{ x: 0, y: 0 }} lod="norm" tree={treeOf(f)} map={mapOf(f)}
      dragging={false} isDrop={false} op={() => Promise.resolve({} as OpResult)} slug="org" toast={noop} zoom={1}
      hire={{ tiers: [] } as never} seats={{}} onHire={noop} onNewProject={noop} onInbox={noop}
      onDragStart={noop} onDragMove={noop} onDragEnd={noop} onDragCancel={noop} />, (el) => el)
  t.after(() => view.unmount())
  return view
}
function stylesheet(t: TestContext) {
  const style = document.createElement('style')
  style.textContent = css
  document.head.appendChild(style)
  t.after(() => style.remove())
}

/* ─── §1 one row ─────────────────────────────────────────────────────────── */

test('§1 the listener, mail and slots cards and the ↑ superior link share one header row, on every tab', async (t) => {
  const { view, jumps } = await desk(t, outlined)
  const head = view.el.querySelector('.cc-head')!
  const rows = [...head.querySelectorAll('.cc-head-meta')].filter((r) => r.parentElement === head)
  assert.equal(rows.length, 1, 'one meta row under the title row, not one row per card')
  const row = rows[0]!
  const kinds = [...row.children].map((c) => c.classList.contains('project-listeners-card') ? 'listeners'
    : c.classList.contains('project-queue-card') ? 'mail'
      : c.classList.contains('project-slots-card') ? 'slots'
        : c.querySelector('.desk-nav-chip') || c.classList.contains('desk-nav-chip') ? 'superior' : c.className)
  assert.deepEqual(kinds, ['listeners', 'mail', 'slots', 'superior'], 'the order the user saw, in one row')
  assert.match(row.textContent ?? '', /listeners 1/)
  assert.match(row.textContent ?? '', /3 q'd/)
  assert.match(row.textContent ?? '', /slots 2\/3/)
  assert.match(row.textContent ?? '', /boss/)
  assert.equal(view.el.querySelectorAll('.desk-nav-chip[data-copy-agent-name="boss"]').length, 1,
    'the superior link is not drawn a second time (the summary keeps its down cards for members)')
  await inAct(async () => { row.querySelector<HTMLElement>('.desk-nav-chip')!.click(); await flush(2) })
  assert.deepEqual(jumps, ['boss'], 'the superior link still jumps')
  // the header row is the header's: it stays while another tab is open
  await inAct(async () => { view.el.querySelector<HTMLButtonElement>('.cc-tabs button[data-tab="docket"]')!.click(); await flush(2) })
  assert.equal(view.el.querySelector('.cc-tabs button[data-tab="docket"]')?.classList.contains('on'), true)
  const again = view.el.querySelector('.cc-head > .cc-head-meta')
  assert.ok(again?.querySelector('.desk-nav-chip'), 'the superior link stays in the row on the docket tab')
  assert.ok(again?.querySelector('.project-slots-card'), 'and the cards with it')
})

test('§1 no header row while the project has no card and no superior to show', async (t) => {
  const bare = { node: project({}, { parent: null }), dogs: [] as Watchdog[], leases: [] as SlotLease[] }
  const { view } = await desk(t, bare)
  assert.equal(view.el.querySelector('.cc-head .cc-head-meta'), null)
})

/* ─── §2 the colours ─────────────────────────────────────────────────────── */

/** the colours a card paints with; jsdom keeps var() references, which is
 *  exactly what the comparison needs (selectors, specificity and order still
 *  come from its CSSOM) */
const paint = (el: Element) => {
  const s = window.getComputedStyle(el)
  return { color: s.color, background: s.backgroundColor, border: s.borderTopColor }
}
const pairs = [
  ['listeners', '.project-listeners-card', '.project-listeners-badge'],
  ['mail', '.project-queue-card', '.project-queue-badge'],
  ['slots', '.project-slots-card', '.project-slots-badge'],
] as const

for (const [label, f] of [['outlined', outlined], ['filled', filled]] as const) {
  test(`§2 ${label}: every header card wears its near-zoom badge's colours, never the grey chip`, async (t) => {
    stylesheet(t)
    const { view } = await desk(t, f)
    const near = await nearCard(t, f)
    for (const [kind, cardSel, badgeSel] of pairs) {
      const card = view.el.querySelector(`.cc-head ${cardSel}`)
      const badge = near.el.querySelector(badgeSel)
      assert.ok(card, `${label} ${kind}: the header card`)
      assert.ok(badge, `${label} ${kind}: the near-zoom badge`)
      const got = paint(card!), want = paint(badge!)
      assert.notEqual(got.color, 'var(--dim)', `${label} ${kind}: not the grey chip text (got ${got.color})`)
      assert.deepEqual(got, want, `${label} ${kind}: the header card paints as the near-zoom badge`)
    }
  })
}

test('§2 the generic chip class is not on the header cards (its grey is what hid their colours)', async (t) => {
  const { view } = await desk(t, outlined)
  for (const [kind, cardSel] of pairs) {
    const card = view.el.querySelector(`.cc-head ${cardSel}`)
    assert.ok(card, kind)
    assert.equal(card!.classList.contains('chip'), false, `${kind} card`)
  }
})
