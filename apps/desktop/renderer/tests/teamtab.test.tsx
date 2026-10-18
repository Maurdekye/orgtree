import { FakeServer, flush, inAct, installFetch, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { DeskChat } from '../src/canvas/desk'
import { ProjectDesk } from '../src/canvas/projectdesk'
import { AgentTray, trayRows } from '../src/canvas/agenttray'
import { AgentSurfaceRoutesProvider } from '../src/canvas/panelcorner'
import { claimSurfaceRequests, forgetSurfaceRequests } from '../src/canvas/modalpin'
import { resetConvos } from '../src/convo'
import type { CanvasNode } from '../src/canvas/shared'
import type { TreePayload } from '../src/types'

const noop = () => {}
const op = async () => ({})
const refs = { world: { org: 'synthetic' }, onOpen: noop } as never
function fixture(project: boolean) {
  const make = (id: string, parent?: string, extra = {}) => ({ id, title: id, parent, tier: 'sol',
    generation: 1, state: 'live', children: [], turns: [], seat: 2, grant: 0, free: 0,
    scope: { tools: {}, add_dirs: [] }, ...extra } as CanvasNode)
  const root = make('team-root', 'outside', project ? { kind: 'project', tier: 'project' } : {})
  const nested = make('nested-project', root.id, { kind: 'project', tier: 'project' })
  const busy = make('busy-worker', nested.id, { busy: true })
  const idle = make('idle-worker', root.id)
  const old = make('retired-worker', root.id, { state: 'archived' })
  const other = make('unrelated-worker', 'outside', { busy: true })
  nested.children = [busy]; root.children = [nested, idle, old]
  const map = new Map([root, nested, busy, idle, old, other].map(n => [n.id, n]))
  const tree = { slug: 'synthetic', roots: [root, other] } as unknown as TreePayload
  return { root, busy, idle, map, tree }
}
const names = (el: Element) => [...el.querySelectorAll('.tray-row')].map(e => e.getAttribute('data-copy-agent-name'))

for (const project of [false, true]) test(`${project ? 'project' : 'agent'} Team tab reuses subtree rows, filter, active state and window routes`, async t => {
  installFetch(new FakeServer()); resetConvos(); localStorage.clear(); forgetSurfaceRequests()
  const f = fixture(project), picked: string[] = [], shown: unknown[] = []
  const routes = { open: noop, show: (kind: string, id: string) => shown.push([kind, id]) }
  const element = () => <AgentSurfaceRoutesProvider value={routes}>
    {project ? <ProjectDesk node={f.root} tree={f.tree} map={f.map} slug="synthetic" op={op} toast={noop} refs={refs} onJump={id => picked.push(id)} />
      : <DeskChat node={f.root} map={f.map} slug="synthetic" op={op} toast={noop} onJump={id => picked.push(id)} bare />}
  </AgentSurfaceRoutesProvider>
  const view = await mountView(element(), el => el)
  t.after(async () => { await view.unmount(); resetConvos() })
  const tab = view.el.querySelector<HTMLButtonElement>('[data-tab="team"]')
  assert.equal(!!tab, true, 'Team tab is offered')
  await inAct(async () => { tab!.click() })
  assert.deepEqual(names(view.el), ['team-root', 'nested-project', 'busy-worker', 'idle-worker'])
  const box = view.el.querySelector<HTMLInputElement>('.tray-filter')!
  assert.equal(!!box, true, 'same agents filter box')
  await inAct(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(box, 'busy')
    box.dispatchEvent(new Event('input', { bubbles: true }))
  })
  assert.deepEqual(names(view.el), ['team-root', 'nested-project', 'busy-worker'], 'ancestors remain as context, unrelated rows do not leak')
  await inAct(async () => { view.el.querySelector<HTMLInputElement>('[aria-label="Only active agents"]')!.click() })
  assert.deepEqual(names(view.el), ['team-root', 'nested-project', 'busy-worker'])
  f.busy.busy = false; f.root = { ...f.root }; f.map = new Map(f.map); f.map.set(f.root.id, f.root)
  await view.render(element()); await flush()
  assert.deepEqual(names(view.el), [], 'same feed update removes the inactive worker')
  const actions = [...view.el.querySelectorAll<HTMLButtonElement>('.panel-corner button')]
  assert.equal(actions.length, 3, 'shared pin/pop-out/modal controls')
  for (const [index, wanted] of [[0, 'pin'], [1, 'popout']] as const) {
    const got: string[] = []
    await inAct(async () => { actions[index].click() })
    claimSurfaceRequests('agent-team', 'synthetic', request => got.push(request))
    await flush()
    assert.deepEqual(got, [wanted])
    assert.deepEqual(shown.at(-1), ['agent-team', 'team-root'])
  }
})

test('the existing global list keeps unrelated rows', async () => {
  const f = fixture(false), rows = trayRows(f.map)
  assert.equal(rows.some(r => r.node.id === 'unrelated-worker'), true)
  const view = await mountView(<AgentTray map={f.map} rows={rows} query="" onQuery={noop}
    archived={false} onArchived={noop} onPick={noop} />, el => el)
  try { assert.equal(names(view.el).includes('unrelated-worker'), true) }
  finally { await view.unmount() }
})
