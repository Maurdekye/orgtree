// listenerspanel.test.tsx — the Listeners tab gets the pin / pop-out / modal
// buttons the other desk tabs have (docket
// slots-tab-header-hold-n-slots-button-with-number; USER 2026-10-20 16:43Z:
// "1. add pin pop & modal buttons for this screen"): a `project-listeners`
// panel kind, shown standalone in the shared pin frame like the slots modal.
//
// WHAT THIS FILE HOLDS THE CODE TO:
//   §1 PanelCorner draws its three buttons for kind "project-listeners", named
//      for the project's listeners; the modal button asks the shell to open it
//   §2 ProjectListenersModal shows the project's listeners in the standard pin
//      frame, with the Register… trigger in its header and no inline strip;
//      a project whose event listeners are off says so instead
//   §3 the tab's header row carries Register… before the corner's buttons
//
// Run:  cd apps/desktop/renderer && node tests/run.mjs listenerspanel

import test from 'node:test'
import assert from 'node:assert/strict'
import { FakeServer, flush, inAct, installFetch, mountView } from './harness'
import { CurrentOrg } from '../src/popout'
import { AgentSurfaceRoutesProvider, PanelCorner } from '../src/canvas/panelcorner'
import { forgetModalOpenCache, forgetModalPins, forgetSurfaceRequests } from '../src/canvas/modalpin'
import { ProjectListenersModal } from '../src/canvas/listenerspanel'
import { ListenersView } from '../src/canvas/listenersdesk'
import type { CanvasNode, OpRequest, OpResult } from '../src/canvas/shared'
import type { TreePayload, Watchdog } from '../src/types'

const org = 'listeners-panel-synthetic'
const project = (extra: Record<string, unknown> = {}) =>
  ({ id: 'sync', kind: 'project', tier: 'project', state: 'live', children: [], configured_scope: { event_listeners: true }, ...extra }) as unknown as CanvasNode
const dog = (kind: Watchdog['kind'], owner: string, name: string, extra: Partial<Watchdog> = {}): Watchdog =>
  ({ id: owner + '/' + name, owner, name, kind, target: 'sync', interval_s: 5, state: 'armed',
    at: '2026-10-20T07:00:00.000Z', fired: 0, once: false, spent: false, ...extra } as Watchdog)
const serve = (requests: OpRequest[] = []) => async (req: OpRequest): Promise<OpResult> => {
  requests.push(req)
  return (req.op === 'listener_history' ? { history: [], history_next: null } : { ok: true }) as unknown as OpResult
}
async function reset(t: { after: (fn: () => void) => void }) {
  const fetch = globalThis.fetch; installFetch(new FakeServer())
  await inAct(() => { localStorage.clear(); forgetModalPins(); forgetModalOpenCache(); forgetSurfaceRequests() })
  t.after(() => { globalThis.fetch = fetch; localStorage.clear(); forgetModalPins(); forgetModalOpenCache(); forgetSurfaceRequests() })
}

test('§1 PanelCorner draws pin, pop-out and modal for project-listeners; the modal button opens the surface', async (t) => {
  await reset(t)
  const opened: [string, string][] = []
  const v = await mountView(<AgentSurfaceRoutesProvider value={{ open(kind, id) { opened.push([kind, id]) }, show() {} }}>
    <div className="desk-tabpanel"><PanelCorner kind="project-listeners" slug={org} nid="sync" /></div></AgentSurfaceRoutesProvider>, (el) => el)
  t.after(() => v.unmount())
  const labels = [...v.el.querySelectorAll<HTMLButtonElement>('.panel-corner-btn')].map((b) => b.getAttribute('aria-label'))
  assert.deepEqual(labels, ["pin sync's listeners as a window", "open sync's listeners in a new window", "open sync's listeners as a standalone modal"])
  await inAct(async () => { v.el.querySelectorAll<HTMLButtonElement>('.panel-corner-btn')[2]!.click() })
  assert.deepEqual(opened, [['project-listeners', 'sync']])
})

test('§2 the modal shows the listeners with Register… in its header', async (t) => {
  await reset(t)
  const node = project()
  const tree = { watchdogs: [dog('project_listener', 'sa', 'ready-a')], slot_leases: [] } as unknown as TreePayload
  const v = await mountView(<CurrentOrg.Provider value={org}>
    <ProjectListenersModal slug={org} nid="sync" map={new Map([['sync', node]])} tree={tree} op={serve()} toast={() => {}} close={() => {}} /></CurrentOrg.Provider>, (el) => el)
  t.after(() => v.unmount())
  await inAct(async () => { await flush(6) })
  const text = document.body.textContent ?? ''
  assert.match(text, /sync/)
  assert.match(text, /listeners/i)
  assert.ok(document.querySelector('.project-listeners'), 'the Listeners table')
  assert.ok(document.querySelector('[role="toolbar"] [data-action="register-menu"]'), 'Register… in the header toolbar')
  assert.ok(!document.querySelector('.user-reg-tools'), 'no inline strip')
})

test('§2 a project whose event listeners are off says so', async (t) => {
  await reset(t)
  const node = project({ configured_scope: {} })
  const v = await mountView(<CurrentOrg.Provider value={org}>
    <ProjectListenersModal slug={org} nid="sync" map={new Map([['sync', node]])} tree={{ watchdogs: [] } as unknown as TreePayload}
      op={serve()} toast={() => {}} close={() => {}} /></CurrentOrg.Provider>, (el) => el)
  t.after(() => v.unmount())
  await inAct(async () => { await flush(4) })
  assert.match(document.querySelector('[role="status"]')?.textContent ?? '', /off/i)
  assert.ok(!document.querySelector('.project-listeners'), 'no table while they are off')
})

test('§3 the tab\'s header row carries Register… before the corner\'s buttons', async (t) => {
  await reset(t)
  const corner = <span id="corner" className="panel-corner">corner</span>
  const v = await mountView(<ListenersView node={project()} dogs={[]} map={new Map()} op={serve()} toast={() => {}} actions={corner} />, (el) => el)
  t.after(() => v.unmount())
  await inAct(async () => { await flush(4) })
  const bar = v.el.querySelector<HTMLElement>('[role="toolbar"]')!
  assert.ok(bar, 'a header toolbar')
  const trigger = bar.querySelector('[data-action="register-menu"]')
  assert.ok(trigger, 'Register… in it')
  assert.ok(trigger.compareDocumentPosition(bar.querySelector('#corner')!) & 4, 'before the corner\'s buttons')
})
