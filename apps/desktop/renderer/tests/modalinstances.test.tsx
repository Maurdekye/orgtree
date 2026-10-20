// Several instances of one kind of modal coexist, one per target (docket
// several-instances-of-the-same-modal-team-slots-i). USER 2026-10-20
// 17:24:20Z: "different versions of the same modal (like the team modal for
// different agents / projects, the slots modal for different projects, the
// inbox modal for different agents, etc.) should be able to coexist. right now
// opening one replaces the other's position". Defaults approved by the
// coordinator 18:58:51Z (m5083ac2a0b30): a target reopens where it was last
// placed; a new target follows the kind's last placement, cascaded 28 px past
// open siblings, or opens centred; one centred instance per kind; one-off
// migration of the single-instance records to the target they showed.
//
// Everything here drives public surfaces only (the real canvas, its node menu,
// the desk tab corner and the stores' storage format), so the same file is the
// red run against the single-instance base.
import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { FakeServer, flush, inAct, installFetch, mountView } from './harness'
import { CurrentOrg } from '../src/popout'
import { forgetModalOpenCache, forgetModalPins, MODAL_OPEN_KEY, MODAL_PINS_KEY, modalPinKey,
  pinModal, readModalOpen, readModalPins, rememberModalOpen } from '../src/canvas/modalpin'
import { savedWindows, WINDOW_LAYOUT_KEY, windowLayoutKey } from '../src/windowlayout'
import { OrgCanvas } from '../src/canvas/OrgCanvas'
import { AgentNavProvider, useAgentNavRegistry } from '../src/canvas/agentnav'
import { AgentSurfaceRoutesProvider, PanelCorner } from '../src/canvas/panelcorner'
import { readPinSurfaces, removePinSurface } from '../src/canvas/pinspace'
import { resetConvos } from '../src/convo'
import type { MenuEntry, MenuItem } from '../src/canvas/contextmenu'
import type { CanvasNode } from '../src/canvas/shared'
import type { TreePayload } from '../src/types'

const org = 'multi', noop = () => {}
const R = { x: 40, y: 50, w: 520, h: 360 }
const step = (n: number) => ({ ...R, x: R.x + 28 * n, y: R.y + 28 * n })

function setup(t: TestContext) {
  const oldFetch = globalThis.fetch
  installFetch(new FakeServer()); resetConvos()
  localStorage.clear(); forgetModalPins(); forgetModalOpenCache()
  localStorage.setItem('orgtree-agent-shortcuts', '1')
  const inner = globalThis.fetch
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    if (/\/inbox$/.test(new URL(String(input), 'http://localhost').pathname))
      return Promise.resolve(new Response(JSON.stringify({ pending: [], delivered: [], sent: [], next_cursor: null }), { status: 200 }))
    return inner(input, init)
  }) as typeof fetch
  t.after(async () => {
    for (const s of readPinSurfaces().filter(s => s.org === org)) removePinSurface(s.key)
    await inAct(async () => { localStorage.clear(); forgetModalPins(); forgetModalOpenCache() })
    resetConvos(); globalThis.fetch = oldFetch
  })
}

const agent = (id: string, parent: string | null, children: CanvasNode[] = []) => ({
  id, title: id, generation: 1, state: 'live', tier: 'sol', kind: 'agent', parent, children, turns: [],
  seat: 2, grant: 0, free: 0, scope: { tools: {}, add_dirs: [] } }) as unknown as CanvasNode
function fixture(): TreePayload {
  const intern = agent('intern', 'report')
  const report = agent('report', 'worker', [intern])
  const worker = agent('worker', null, [report])
  return { slug: org, name: org, roots: [worker], dirs: [], tiers: { sol: 2 }, audiences: [],
    credit_requests: [], audience_requests: [], audit: { live_nodes: 3, top_level_holds: 0, problems: [] },
    user_inbox_count: 0, max_top_grant: 1000, default_top_grant: 50 } as unknown as TreePayload
}
const flatten = (entries: MenuEntry[]): MenuItem[] =>
  entries.flatMap(e => e === 'sep' ? [] : [e, ...flatten(e.children ?? [])])

async function canvas(t: TestContext) {
  let registry: ReturnType<typeof useAgentNavRegistry>
  function Probe() { registry = useAgentNavRegistry(); return null }
  const view = await mountView(<CurrentOrg.Provider value={org}><AgentNavProvider>
    <OrgCanvas tree={fixture()} slug={org} op={async () => ({})} toast={noop} mailEvt={null} /><Probe />
  </AgentNavProvider></CurrentOrg.Provider>, el => el)
  t.after(() => view.unmount()); await flush(4)
  return {
    view,
    /** the node's own menu entry, the canonical route every opener shares */
    select: async (id: string, label: string) => inAct(async () => {
      const entry = flatten(registry!.current!(id)).find(e => e.label === label)
      assert.ok(entry, `${id}: the menu offers ${label}`)
      entry!.onSelect(); await flush(6)
    }),
  }
}
/** the instance panels on screen, by the target each one names */
const teams = () => [...document.querySelectorAll('[role="dialog"]')]
  .map(d => d.getAttribute('aria-label') ?? '').filter(l => l.endsWith(' · Team')).map(l => l.slice(0, -' · Team'.length)).sort()
const mails = () => [...document.querySelectorAll('.settings h3[data-copy-agent-name]')]
  .filter(h => /· mail$/.test(h.textContent ?? '')).map(h => h.getAttribute('data-copy-agent-name')).sort()
const dockets = () => [...document.querySelectorAll('h3.docket-membership-head[data-copy-agent-name]')]
  .map(h => h.getAttribute('data-copy-agent-name')).sort()
const pinOf = (kind: string) => readModalPins()[modalPinKey(kind, org)]?.rect ?? null

/** today's single-instance record: ONE pin and ONE open marker per kind,
 *  naming the target the window showed */
function legacyPinned(kind: string, target: string) {
  localStorage.setItem(MODAL_PINS_KEY, JSON.stringify({ [JSON.stringify([org, kind])]: { rect: R, z: 0 } }))
  localStorage.setItem(MODAL_OPEN_KEY, JSON.stringify([{ kind, org, restore: { agent: target, generation: 1 } }]))
  forgetModalPins(); forgetModalOpenCache()
}

// ------------------------------------------------------------ §1 migration
test('§1a a single pin and its open marker become the instance of the target it showed', t => {
  setup(t); legacyPinned('agent-team', 'worker')
  assert.deepEqual(pinOf('agent-team:worker'), R, 'the pin is the target\'s own')
  assert.deepEqual(readModalOpen(org).map(o => o.kind), ['agent-team:worker'], 'the open marker names its target')
  assert.equal(pinOf('agent-team'), null, 'the bare kind is no longer a pinned window')
})

test('§1b a watchdog record keys by its dog', t => {
  setup(t)
  localStorage.setItem(MODAL_PINS_KEY, JSON.stringify({ [JSON.stringify([org, 'watchdog'])]: { rect: R, z: 0 } }))
  localStorage.setItem(MODAL_OPEN_KEY, JSON.stringify([{ kind: 'watchdog', org, restore: { watchdog: 'dog-7' } }]))
  forgetModalPins(); forgetModalOpenCache()
  assert.deepEqual(pinOf('watchdog:dog-7'), R)
  assert.deepEqual(readModalOpen(org).map(o => o.kind), ['watchdog:dog-7'])
})

test('§1c a popped-out window row keys by the target in its restore; other rows are untouched', t => {
  setup(t)
  const rect = { x: 100, y: 80, width: 700, height: 500 }
  localStorage.setItem(WINDOW_LAYOUT_KEY, JSON.stringify([
    { key: windowLayoutKey('node-inbox', org), kind: 'node-inbox', org, open: true, rect, restore: { agent: 'worker', generation: 1 } },
    { key: windowLayoutKey('usage', org), kind: 'usage', org, open: true, rect },
  ]))
  const rows = savedWindows()
  assert.deepEqual(rows.map(r => [r.key, r.kind]), [
    [windowLayoutKey('node-inbox:worker', org), 'node-inbox:worker'],
    [windowLayoutKey('usage', org), 'usage'],
  ])
  assert.deepEqual(rows[0]!.restore, { agent: 'worker', generation: 1 }, 'the restore identity is kept')
})

// ---------------------------------------------------------- §2 coexistence
test('§2a Team: a second target opens beside the pinned first, cascaded from it', async t => {
  setup(t); legacyPinned('agent-team', 'worker')
  const c = await canvas(t)
  assert.deepEqual(teams(), ['worker'], 'the pinned Team window is restored')
  await c.select('report', 'Team')
  assert.deepEqual(teams(), ['report', 'worker'], 'both Team windows are on screen')
  assert.deepEqual(pinOf('agent-team:worker'), R, 'the first window kept its place')
  assert.deepEqual(pinOf('agent-team:report'), step(1), 'the second pins 28 px right and down')
  await c.select('intern', 'Team')
  assert.deepEqual(teams(), ['intern', 'report', 'worker'], 'and a third')
  assert.deepEqual(pinOf('agent-team:intern'), step(2), 'past every open sibling')
})

test('§2b Mail: a second agent\'s mailbox opens beside the pinned first', async t => {
  setup(t); legacyPinned('node-inbox', 'worker')
  const c = await canvas(t)
  assert.deepEqual(mails(), ['worker'])
  await c.select('report', 'Mail')
  assert.deepEqual(mails(), ['report', 'worker'])
  assert.deepEqual(pinOf('node-inbox:worker'), R)
  assert.deepEqual(pinOf('node-inbox:report'), step(1))
})

test('§2c Docket: a second agent\'s docket opens beside the pinned first', async t => {
  setup(t); legacyPinned('agent-docket', 'worker')
  const c = await canvas(t)
  assert.deepEqual(dockets(), ['worker'])
  await c.select('report', 'Docket')
  assert.deepEqual(dockets(), ['report', 'worker'])
  assert.deepEqual(pinOf('agent-docket:report'), step(1))
})

test('§2d a centred instance gives way to the next target; one centred per kind', async t => {
  setup(t)
  const c = await canvas(t)
  await c.select('worker', 'Team')
  assert.deepEqual(teams(), ['worker'])
  assert.equal(pinOf('agent-team:worker'), null, 'never pinned: centred')
  await c.select('report', 'Team')
  assert.deepEqual(teams(), ['report'], 'the centred one is replaced, not stacked')
})

test('§2e opening the same target again keeps one window', async t => {
  setup(t); legacyPinned('agent-team', 'worker')
  const c = await canvas(t)
  await c.select('report', 'Team')
  await c.select('worker', 'Team'); await c.select('report', 'Team')
  assert.deepEqual(teams(), ['report', 'worker'], 'no duplicates, nothing closed')
})

test('§2f a node\'s own button hides only its own pinned window', async t => {
  setup(t); legacyPinned('agent-docket', 'worker')
  const c = await canvas(t)
  await c.select('report', 'Docket')
  assert.deepEqual(dockets(), ['report', 'worker'])
  const button = c.view.el.querySelector<HTMLButtonElement>('[aria-label="Docket for worker"]')
  assert.ok(button, 'the card\'s docket button')
  await inAct(async () => { button!.click(); await flush(4) })
  assert.deepEqual(dockets(), ['report'], 'worker\'s closed, report\'s stays')
  assert.deepEqual(pinOf('agent-docket:worker'), R, 'its placement is kept for next time')
  await inAct(async () => { button!.click(); await flush(4) })
  assert.deepEqual(dockets(), ['report', 'worker'], 'and it comes back where it was')
})

// ---------------------------------------------------- §3 every target's own
test('§3a every pinned instance comes back at start-up', async t => {
  setup(t)
  pinModal('agent-team:worker', R, org); pinModal('agent-team:report', step(3), org)
  rememberModalOpen('agent-team:worker', org, { agent: 'worker', generation: 1 })
  rememberModalOpen('agent-team:report', org, { agent: 'report', generation: 1 })
  await canvas(t)
  assert.deepEqual(teams(), ['report', 'worker'])
  assert.deepEqual(pinOf('agent-team:report'), step(3), 'each at its own place')
})

test('§3b a target reopens where it was last pinned, not at the cascade', async t => {
  setup(t); legacyPinned('agent-team', 'worker')
  pinModal('agent-team:report', { ...R, x: 300, y: 200 }, org)
  const c = await canvas(t)
  await c.select('report', 'Team')
  assert.deepEqual(pinOf('agent-team:report'), { ...R, x: 300, y: 200 })
})

test('§3c each desk tab corner reads its own target\'s pin', async t => {
  setup(t); pinModal('agent-team:worker', R, org)
  const routes = { open: noop, show: noop }
  const view = await mountView(<CurrentOrg.Provider value={org}><AgentSurfaceRoutesProvider value={routes}>
    <div data-corner="worker"><PanelCorner kind="agent-team" slug={org} nid="worker" /></div>
    <div data-corner="report"><PanelCorner kind="agent-team" slug={org} nid="report" /></div>
  </AgentSurfaceRoutesProvider></CurrentOrg.Provider>, el => el)
  t.after(() => view.unmount())
  const pressed = (who: string) => view.el.querySelector(`[data-corner="${who}"] [aria-pressed]`)?.getAttribute('aria-pressed')
  assert.equal(pressed('worker'), 'true', 'worker\'s Team is pinned')
  assert.equal(pressed('report'), 'false', 'report\'s Team is not')
})
