// Startup restoration through the real canvas and MovableSurface. The second
// document models adoption, not native window geometry or presentation.
import { FakeServer, flush, inAct, installFetch, JSDOM, mountView } from './harness'
import { installBridge } from './shellbridge'
import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { OrgCanvas } from '../src/canvas/OrgCanvas'
import { AgentNavProvider, useAgentNavRegistry } from '../src/canvas/agentnav'
import { CurrentOrg } from '../src/popout'
import { instanceKind } from '../src/modalkinds'
import { forgetModalOpenCache, forgetModalPins, pinModal, readModalOpen, rememberModalOpen } from '../src/canvas/modalpin'
import { readPinSurfaces, removePinSurface } from '../src/canvas/pinspace'
import { savedWindows, saveWindow, WINDOW_LAYOUT_KEY, windowLayoutKey } from '../src/windowlayout'
import { resetConvos } from '../src/convo'
import type { MenuEntry, MenuItem } from '../src/canvas/contextmenu'
import type { TreePayload } from '../src/types'

const org = 'project-restore', id = 'project-one', generation = 7
const kind = instanceKind('project-desk', id)
const noop = () => {}
const project = { id, title: id, generation, state: 'live', kind: 'project', tier: 'project',
  parent: null, children: [], turns: [], lineage: [], documents: [], audiences_held: [],
  seat: 0, grant: 0, free: 0, scope: { tools: {}, add_dirs: [] } }
const tree = (present = true): TreePayload => ({ slug: org, name: org, roots: present ? [project] : [],
  dirs: [], tiers: { sol: 2 }, audiences: [], credit_requests: [], audience_requests: [],
  audit: { live_nodes: present ? 1 : 0, top_level_holds: 0, problems: [] }, user_inbox_count: 0,
  max_top_grant: 1000, default_top_grant: 50 } as unknown as TreePayload)
const flatten = (entries: MenuEntry[]): MenuItem[] =>
  entries.flatMap(e => e === 'sep' ? [] : [e, ...flatten(e.children ?? [])])

function setup(t: TestContext) {
  localStorage.clear(); forgetModalPins(); forgetModalOpenCache(); resetConvos()
  const previousFetch = globalThis.fetch, previousOpen = window.open
  const previousBridge = Object.getOwnPropertyDescriptor(window, 'orgtreeDesktop')
  const previousObserver = globalThis.MutationObserver
  installBridge({})
  installFetch(new FakeServer())
  const child = new JSDOM('<!doctype html><html><head></head><body></body></html>', { url: 'http://localhost/' })
  const w = child.window as unknown as Window
  Object.defineProperties(w, { closed: { value: false, writable: true },
    screenX: { value: 120 }, screenY: { value: 80 }, outerWidth: { value: 800 }, outerHeight: { value: 600 } })
  w.focus = noop; w.requestAnimationFrame = () => 1; w.cancelAnimationFrame = noop
  const closeChild = w.close.bind(w)
  w.close = () => { (w as unknown as { closed: boolean }).closed = true }
  globalThis.MutationObserver = child.window.MutationObserver
  let opened = 0
  window.open = (() => { opened++; return w }) as typeof window.open
  const views: { unmount: () => Promise<void> }[] = []
  t.after(async () => {
    for (const view of views.reverse()) await view.unmount()
    for (const s of readPinSurfaces().filter(s => s.org === org)) removePinSurface(s.key)
    closeChild()
    globalThis.fetch = previousFetch; window.open = previousOpen
    globalThis.MutationObserver = previousObserver
    if (previousBridge) Object.defineProperty(window, 'orgtreeDesktop', previousBridge)
    else delete (window as unknown as { orgtreeDesktop?: unknown }).orgtreeDesktop
    localStorage.clear(); forgetModalPins(); forgetModalOpenCache(); resetConvos()
  })
  return { w, views, opened: () => opened }
}

function saved(g: number | undefined = generation) {
  saveWindow({ key: windowLayoutKey(kind, org), kind, org, open: true,
    restore: { agent: id, ...(g === undefined ? {} : { generation: g }) },
    rect: { x: 120, y: 80, width: 800, height: 600 } })
}

async function canvas(t: TestContext, fixture: ReturnType<typeof setup>, present = true) {
  let registry: ReturnType<typeof useAgentNavRegistry>
  const notices: string[] = []
  function Probe() { registry = useAgentNavRegistry(); return null }
  const view = await mountView(<CurrentOrg.Provider value={org}><AgentNavProvider>
    <OrgCanvas tree={tree(present)} slug={org} op={async () => ({})}
      toast={messages => { notices.push(...messages) }} mailEvt={null} /><Probe />
  </AgentNavProvider></CurrentOrg.Provider>, el => el)
  fixture.views.push(view)
  await inAct(async () => { await flush(10) })
  return { view, notices, select: async (label: string) => {
    const item = flatten(registry!.current!(id)).find(e => e.label === label)
    assert.ok(item, `project menu offers ${label}`)
    await inAct(async () => { item.onSelect(); await flush(10) })
  } }
}
const unavailable = (notices: string[]) => notices.some(s => s.includes('generation that is no longer available'))

test('a saved project desk reopens in its pop-out with generation metadata and no false toast', async t => {
  const f = setup(t); saved()
  const c = await canvas(t, f)
  assert.equal(f.opened(), 1, 'startup launches the saved project window')
  assert.equal(!!f.w.document.querySelector('.project-desk-modal'), true, 'the project desk is adopted')
  assert.equal(unavailable(c.notices), false)
  assert.deepEqual(savedWindows().find(r => r.kind === kind)?.restore, { agent: id, generation },
    'the desk shell preserves the generation when it captures the restored window')
})

test('a legacy generation-less project desk reopens for a live project and upgrades its metadata', async t => {
  const f = setup(t)
  saved()
  const rows = savedWindows().map(r => ({ ...r, restore: { agent: id } }))
  localStorage.setItem(WINDOW_LAYOUT_KEY, JSON.stringify(rows))
  const c = await canvas(t, f)
  assert.equal(f.opened(), 1, 'the old alpha record restores its still-live project')
  assert.equal(!!f.w.document.querySelector('.project-desk-modal'), true)
  assert.equal(unavailable(c.notices), false, 'a legacy project record is not a lost generation')
  assert.deepEqual(savedWindows().find(r => r.kind === kind)?.restore, { agent: id, generation })
})

for (const [label, present, g] of [['missing project', false, undefined], ['changed generation', true, generation - 1]] as const) {
  test(`a saved project desk with a ${label} is skipped and keeps the unavailable toast`, async t => {
    const f = setup(t)
    saved(g)
    if (!present) localStorage.setItem(WINDOW_LAYOUT_KEY,
      JSON.stringify(savedWindows().map(r => ({ ...r, restore: { agent: id } }))))
    const c = await canvas(t, f, present)
    assert.equal(f.opened(), 0)
    assert.equal(document.querySelector('.project-desk-modal') === null, true)
    assert.equal(unavailable(c.notices), true)
  })
}

test('opening a pinned project desk writes its generation and the pin restores on remount', async t => {
  const f = setup(t)
  const c = await canvas(t, f)
  pinModal(kind, { x: 40, y: 50, w: 520, h: 360 }, org)
  await c.select('Desk')
  assert.equal(!!document.querySelector('.project-desk-modal'), true, 'the control opens the project desk')
  assert.deepEqual(readModalOpen(org).find(r => r.kind === kind)?.restore, { agent: id, generation },
    'the canvas writes the full identity into the open marker')
  await c.view.unmount(); f.views.splice(f.views.indexOf(c.view), 1)
  forgetModalPins(); forgetModalOpenCache()
  const reloaded = await canvas(t, f)
  assert.equal(!!document.querySelector('.project-desk-modal'), true, 'the pinned project desk reopens')
  assert.equal(unavailable(reloaded.notices), false)
})
