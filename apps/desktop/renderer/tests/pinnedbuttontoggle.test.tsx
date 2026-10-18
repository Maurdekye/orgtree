import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { useState } from 'react'
import { FakeServer, flush, inAct, installFetch, mountView } from './harness'
import { CurrentOrg } from '../src/popout'
import { forgetModalOpenCache, forgetModalPins, isModalPinned, pinModal, PinFrame, readModalOpen,
  toggleOrRaiseModal, usePersistedModalOpen } from '../src/canvas/modalpin'
import { registerWindow, openSurfaces } from '../src/windowlife'
import { OrgCanvas } from '../src/canvas/OrgCanvas'
import { AgentNavProvider, useAgentNavRegistry } from '../src/canvas/agentnav'
import type { MenuEntry, MenuItem } from '../src/canvas/contextmenu'
import type { CanvasNode } from '../src/canvas/shared'
import type { TreePayload } from '../src/types'
import { pinSurfaceKey, removePinSurface, updatePinSurface } from '../src/canvas/pinspace'

const org = 'pin-toggle', rect = { x: 10, y: 20, w: 600, h: 400 }, noop = () => {}
function setup(t: TestContext) {
  localStorage.clear(); forgetModalPins(); forgetModalOpenCache(); installFetch(new FakeServer())
  t.after(() => { localStorage.clear(); forgetModalPins(); forgetModalOpenCache() })
}
function ButtonPanel({ kind }: { kind: string }) {
  const [open, setOpen] = useState(false)
  usePersistedModalOpen(kind, org, open)
  return <><button data-opener={kind} onClick={() => toggleOrRaiseModal(kind, open, setOpen, org)}>toggle {kind}</button>
    {open && <PinFrame kind={kind} title={kind} panel="settings" close={() => setOpen(false)}>
      <div data-body={kind}>{kind}</div>
    </PinFrame>}</>
}
for (const kind of ['docket', 'usage', 'usage-history', 'inbox', 'gallery', 'org-settings']) {
  test(`${kind}: its button hides an open pin, preserves its rectangle and sibling, and reopens`, async t => {
    setup(t); pinModal(kind, rect, org); pinModal('sibling', rect, org)
    const view = await mountView(<CurrentOrg.Provider value={org}><ButtonPanel kind={kind} /><ButtonPanel kind="sibling" /></CurrentOrg.Provider>, el => el)
    t.after(() => view.unmount())
    const press = async (name: string) => inAct(async () => { view.el.querySelector<HTMLButtonElement>(`[data-opener="${name}"]`)!.click(); await flush(4) })
    await press(kind); await press('sibling')
    assert.equal(openSurfaces().some(s => s.org === org && s.kind === kind), true, 'pin is genuinely mounted')
    await press(kind)
    assert.equal(openSurfaces().some(s => s.org === org && s.kind === kind), false, 'same button closes even behind a sibling')
    assert.equal(readModalOpen(org).some(s => s.kind === kind), false, 'close is durable')
    assert.equal(openSurfaces().some(s => s.org === org && s.kind === 'sibling'), true, 'other panel stays open')
    assert.equal(isModalPinned(kind, org), true, 'saved placement survives hiding')
    await press(kind)
    assert.equal(openSurfaces().some(s => s.org === org && s.kind === kind), true, 'next click reopens')
  })
}

test('an unpinned panel still opens, and a detached panel still receives focus', t => {
  setup(t)
  const sets: boolean[] = []
  toggleOrRaiseModal('usage', true, v => sets.push(v), org)
  assert.deepEqual(sets, [true], 'centred opening stays as before')
  pinModal('usage', rect, org)
  let focused = 0
  const remove = registerWindow({ id: 'detached-usage', kind: 'usage', org, editable: false,
    window: { closed: false, focus: noop } as unknown as Window, redock: noop, reveal: () => { focused++ } })
  t.after(remove)
  toggleOrRaiseModal('usage', true, v => sets.push(v), org)
  assert.equal(focused, 1); assert.deepEqual(sets, [true], 'detached activation does not close or remount')
})

const flatten = (entries: MenuEntry[]): MenuItem[] => entries.flatMap(e => e === 'sep' ? [] : [e, ...flatten(e.children ?? [])])
for (const [label, kind] of [['Inbox', 'node-inbox'], ['Team', 'agent-team'], ['Docket', 'agent-docket']] as const) {
  test(`the real node ${label} opener hides its own pin even behind another panel`, async t => {
    setup(t)
    const oldFetch = globalThis.fetch, inner = globalThis.fetch
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => /\/inbox$/.test(new URL(String(input), 'http://localhost').pathname)
      ? Promise.resolve(new Response(JSON.stringify({ pending: [], delivered: [], sent: [], next_cursor: null }), { status: 200 }))
      : inner(input, init)) as typeof fetch
    t.after(() => { globalThis.fetch = oldFetch })
    const root = { id: 'worker', title: 'worker', generation: 1, state: 'live', tier: 'sol', parent: null,
      children: [], turns: [], seat: 2, grant: 0, free: 0, scope: { tools: {}, add_dirs: [] } } as CanvasNode
    const tree = { slug: org, roots: [root], dirs: [], tiers: { sol: 2 }, audiences: [], credit_requests: [], audience_requests: [],
      audit: { live_nodes: 1, top_level_holds: 0, problems: [] }, user_inbox_count: 0, max_top_grant: 1000, default_top_grant: 50 } as unknown as TreePayload
    let registry: ReturnType<typeof useAgentNavRegistry>
    function Probe() { registry = useAgentNavRegistry(); return null }
    const view = await mountView(<CurrentOrg.Provider value={org}><AgentNavProvider><OrgCanvas tree={tree} slug={org} op={async () => ({})}
      toast={noop} mailEvt={null} /><Probe /></AgentNavProvider></CurrentOrg.Provider>, el => el)
    t.after(() => view.unmount()); await flush(3)
    const select = async () => inAct(async () => {
      flatten(registry!.current!('worker')).find(e => e.label === label)!.onSelect(); await flush(5)
    })
    await select(); await inAct(() => { pinModal(kind, rect, org) }); await flush(3)
    assert.equal(openSurfaces().some(s => s.org === org && s.kind === kind), true)
    const cover = pinSurfaceKey(org, 'covering-panel')
    await inAct(() => { updatePinSurface(cover, org, rect, false) })
    t.after(() => removePinSurface(cover))
    await select()
    assert.equal(openSurfaces().some(s => s.org === org && s.kind === kind), false, 'same node button closes its pinned panel')
    await select()
    assert.equal(openSurfaces().some(s => s.org === org && s.kind === kind), true, 'same opener reopens')
  })
}
