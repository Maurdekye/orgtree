import { FakeServer, flush, inAct, installFetch, mountView } from './harness'
import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { toggleOrRaiseModal, pinModal, forgetModalPins, forgetModalOpenCache, rememberModalOpen, pinnedModalBehind } from '../src/canvas/modalpin'
import { pinSurfaceKey, updatePinSurface, removePinSurface, readPinSurfaces } from '../src/canvas/pinspace'
import { registerWindow, openSurfaces } from '../src/windowlife'
import { DeskChat } from '../src/canvas/desk'
import { ProjectDesk } from '../src/canvas/projectdesk'
import { OrgCanvas } from '../src/canvas/OrgCanvas'
import { AgentNavProvider, useAgentNavRegistry } from '../src/canvas/agentnav'
import { resetConvos } from '../src/convo'
import type { CanvasNode } from '../src/canvas/shared'
import type { TreePayload } from '../src/types'
import type { MenuEntry, MenuItem } from '../src/canvas/contextmenu'

const org = 'panel-proof', noop = () => {}, op = async () => ({})
const rect = { x: 10, y: 10, w: 600, h: 400 }
const panels = [['inbox', 'node-inbox'], ['docket', 'agent-docket'], ['presented', 'agent-gallery'], ['team', 'agent-team']] as const
const refs = { world: { org }, onOpen: noop } as never
function setup(t: TestContext) {
  const oldFetch = globalThis.fetch
  installFetch(new FakeServer()); resetConvos(); localStorage.clear(); forgetModalPins(); forgetModalOpenCache()
  const inner = globalThis.fetch
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    if (/\/inbox$/.test(new URL(String(input), 'http://localhost').pathname))
      return Promise.resolve(new Response(JSON.stringify({ pending: [], delivered: [], sent: [], next_cursor: null }), { status: 200 }))
    return inner(input, init)
  }) as typeof fetch
  t.after(async () => {
    for (const s of readPinSurfaces().filter(s => s.org === org)) removePinSurface(s.key)
    await inAct(async () => { forgetModalPins(); localStorage.clear(); forgetModalOpenCache() })
    resetConvos(); globalThis.fetch = oldFetch
  })
}
function detached(t: TestContext, kind: string, agent?: string, scope = org, closed = false) {
  let raised = 0
  const remove = registerWindow({ id: `${scope}:${kind}`, kind, org: scope, editable: false,
    window: { closed, focus: noop } as unknown as Window, redock: noop,
    identity: () => agent ? { agent, generation: 1 } : undefined, reveal: () => { raised++ } })
  t.after(remove)
  return () => raised
}
function fixture(project: boolean) {
  const root = { id: 'worker', title: 'worker', generation: 1, state: 'live', tier: project ? 'project' : 'sol',
    ...(project ? { kind: 'project' } : {}), parent: null, children: [], turns: [], seat: 2, grant: 0, free: 0,
    scope: { tools: {}, add_dirs: [] } } as CanvasNode
  const tree = { slug: org, name: org, roots: [root], dirs: [], tiers: { sol: 2 }, audiences: [],
    credit_requests: [], audience_requests: [], audit: { live_nodes: 1, top_level_holds: 0, problems: [] },
    user_inbox_count: 0, max_top_grant: 1000, default_top_grant: 50 } as unknown as TreePayload
  return { root, tree, map: new Map([[root.id, root]]) }
}
const flatten = (entries: MenuEntry[]): MenuItem[] => entries.flatMap(e => e === 'sep' ? [] : [e, ...flatten(e.children ?? [])])

for (const kind of ['inbox', 'docket', 'gallery']) {
  test(`global ${kind} opener reveals its detached window without changing open state`, t => {
    setup(t); const raised = detached(t, kind), state: boolean[] = []
    toggleOrRaiseModal(kind, true, v => state.push(v), org)
    assert.equal(raised(), 1, 'native owning window was revealed')
    assert.deepEqual(state, [], 'no close/reopen or second panel')
  })
  test(`global ${kind} opener keeps an already top pinned window open`, t => {
    setup(t); pinModal(kind, rect, org); updatePinSurface(pinSurfaceKey(org, kind, true), org, rect, true)
    const state: boolean[] = []
    toggleOrRaiseModal(kind, true, v => state.push(v), org)
    assert.deepEqual(state, [], 'an open action never closes the pinned panel')
  })
}

for (const project of [false, true]) {
  test(`${project ? 'project' : 'agent'} desk tabs reveal matching detached panels and keep the local view`, async t => {
    setup(t); const f = fixture(project)
    const view = await mountView(project
      ? <ProjectDesk node={f.root} tree={f.tree} map={f.map} slug={org} op={op} toast={noop} refs={refs} />
      : <DeskChat node={f.root} map={f.map} slug={org} op={op} toast={noop} onJump={noop} bare />, el => el)
    t.after(() => view.unmount())
    for (const [tab, kind] of panels) {
      const raised = detached(t, kind, f.root.id)
      await inAct(() => view.el.querySelector<HTMLButtonElement>(`[data-tab="${tab}"]`)!.click())
      assert.equal(raised(), 1, `${tab}: revealed existing native window`)
      assert.equal(view.el.querySelector('[data-tab].on')?.getAttribute('data-tab'), project ? 'desk' : 'chat', 'local tab stays put')
    }
  })
  test(`${project ? 'project' : 'agent'} desk tabs raise matching pinned panels over a desk`, async t => {
    setup(t); const f = fixture(project)
    const view = await mountView(project
      ? <ProjectDesk node={f.root} tree={f.tree} map={f.map} slug={org} op={op} toast={noop} refs={refs} />
      : <DeskChat node={f.root} map={f.map} slug={org} op={op} toast={noop} onJump={noop} bare />, el => el)
    t.after(() => view.unmount())
    for (const [tab, kind] of panels) {
      pinModal(kind, rect, org); rememberModalOpen(kind, org, { agent: f.root.id, generation: 1 })
      updatePinSurface(pinSurfaceKey(org, kind, true), org, rect, true)
      updatePinSurface(pinSurfaceKey(org, 'covering-desk'), org, rect, false)
      assert.equal(pinnedModalBehind(kind, org), true, 'control starts behind')
      await inAct(() => view.el.querySelector<HTMLButtonElement>(`[data-tab="${tab}"]`)!.click())
      assert.equal(pinnedModalBehind(kind, org), false, `${tab}: on top of shared pin layer`)
      removePinSurface(pinSurfaceKey(org, 'covering-desk'))
    }
  })
}

test('shared node menu routes reveal existing inbox, docket and Team windows', async t => {
  setup(t); const f = fixture(false)
  let registry: ReturnType<typeof useAgentNavRegistry>
  function Probe() { registry = useAgentNavRegistry(); return null }
  const view = await mountView(<AgentNavProvider><OrgCanvas tree={f.tree} slug={org} op={op} toast={noop} mailEvt={null} /><Probe /></AgentNavProvider>, el => el)
  t.after(() => view.unmount()); await flush(2)
  for (const [label, kind] of [['Inbox', 'node-inbox'], ['Docket', 'agent-docket'], ['Team', 'agent-team']] as const) {
    const raised = detached(t, kind, f.root.id)
    const entry = flatten(registry!.current!(f.root.id)).find(e => e.label === label)
    assert.equal(!!entry, true, `${label}: canonical entry exists`)
    await inAct(() => entry!.onSelect())
    assert.equal(raised(), 1, `${label}: canonical route revealed its window`)
    assert.equal(openSurfaces().filter(s => s.kind === kind && s.org === org).length, 1, 'no duplicate registration')
  }
})

test('global opener ignores another organization and opens normally', t => {
  setup(t); const raised = detached(t, 'inbox', undefined, 'other-org'), state: boolean[] = []
  toggleOrRaiseModal('inbox', false, v => state.push(v), org)
  assert.equal(raised(), 0); assert.deepEqual(state, [true])
})
