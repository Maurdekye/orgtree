import test from 'node:test'
import assert from 'node:assert/strict'
import { FakeServer, installFetch, mountView, inAct } from './harness'
import { OrgCanvas, agentTooltipInfo } from '../src/canvas/OrgCanvas'
import { ProjectSquare } from '../src/canvas/projectcard'
import { AgentNavProvider, useProvideAgentNav } from '../src/canvas/agentnav'
import { bunchTree, project } from './projectbunch-fixture'
import type { CanvasNode } from '../src/canvas/shared'
import type { TreePayload, Watchdog } from '../src/types'

// USER 2026-10-21 11:16:57Z and 11:17:42Z: one facts line from the
// card's counts; omit the name on name-visible targets, prefix icon links.
function fixture() {
  const node = { ...project('test-project'), charter: '# Test project',
    configured_scope: { slots_capacity: 2, mail_queue: 'ack', event_listeners: true },
    mail_pending: 4, mail_held: 1 } as unknown as CanvasNode
  const dog = (kind: Watchdog['kind'], i: number, extra = {}) => ({
    id: `worker/${kind}-${i}`, owner: 'worker', name: `${kind}-${i}`, kind,
    target: '@test-project', state: 'armed', at: '', ...extra,
  } as Watchdog)
  const dogs = [0, 1, 2].flatMap(i => [dog('project_listener', i), dog('fair_queue', i)])
  dogs.push(dog('listener_watch', 0, { count: 5 }), dog('project_listener', 9, { state: 'paused' }),
    dog('fair_queue', 9, { spent: true }), dog('project_listener', 10, { target: 'other-project' }))
  const tree = { ...bunchTree([node]), watchdogs: dogs,
    slot_leases: [{ project: node.id, agent: 'worker', slot: 1, slots: 1, lease: 'held', since: '' }] } as TreePayload
  return { node, tree }
}
const facts = 'Project · slots 1/2 held · listeners 3/5 · 1 listener watch · mail: 3 listeners · 4 q\'d · 1 in flight · # Test project'
const info = (node: CanvasNode, tree: TreePayload) => Reflect.apply(agentTooltipInfo, null,
  [node, [], null, undefined, undefined, tree])

test('project facts use active badge counts, excluding paused/spent/other-project dogs', () => {
  const { node, tree } = fixture()
  assert.deepEqual(info(node, tree), { title: facts })
})

test('facts change with current leases and watches; empty projects keep their existing summary', () => {
  const { node, tree } = fixture()
  tree.slot_leases![0]!.slots = 2
  tree.watchdogs = tree.watchdogs!.filter(w => w.kind !== 'listener_watch')
  assert.equal(info(node, tree).title, facts.replace('1/2 held', '2/2 held')
    .replace('listeners 3/5 · 1 listener watch', 'listeners 3'))
  assert.deepEqual(info({ ...node, configured_scope: {}, mail_pending: 0, mail_held: 0 },
    { ...tree, watchdogs: [], slot_leases: [] }), { title: 'Project · # Test project' })
})

test('near card/name and icon hovers share facts matching the rendered badges', async t => {
  const { node, tree } = fixture(), noop = () => {}
  function Card() {
    useProvideAgentNav(() => [], () => info(node, tree))
    return <ProjectSquare node={node} tree={tree} pos={{ x: 0, y: 0 }} lod="norm" slug={tree.slug}
      dragging={false} isDrop={false} op={async () => ({ ok: true } as never)} toast={noop} zoom={1} hire={{}}
      onHire={noop} onNewProject={noop} onInbox={noop} onDragStart={noop} onDragMove={noop} onDragEnd={noop} onDragCancel={noop} />
  }
  const v = await mountView(<AgentNavProvider><Card /></AgentNavProvider>, el => el)
  t.after(() => v.unmount())
  const card = v.el.querySelector<HTMLElement>('.sq.project')!
  for (const text of ['1/2 held', 'listeners 3/5', "3 listeners · 4 q'd · 1 in flight"])
    assert.ok([...card.querySelectorAll('.project-header-badges > span')].some(b => b.textContent === text), text)
  for (const target of [card, card.querySelector<HTMLElement>('.name')!, card.querySelector<HTMLElement>('.project-mark')!]) {
    await inAct(() => target.dispatchEvent(new MouseEvent('pointerover', { bubbles: true })))
    assert.equal(target.title, target.classList.contains('project-mark') ? `test-project\n${facts}` : facts)
  }
})

test('real canvas far-zoom hover omits the name and reads replacement feed facts', async t => {
  const original = globalThis.fetch
  installFetch(new FakeServer()); t.after(() => { globalThis.fetch = original })
  localStorage.clear(); localStorage.setItem('orgtree-start-zoom', '0')
  const { tree } = fixture()
  const render = () => <OrgCanvas tree={tree} slug={tree.slug} op={async () => ({ ok: true } as never)} toast={() => {}} mailEvt={null} />
  const v = await mountView(render(), el => el); t.after(() => v.unmount())
  const card = v.el.querySelector<HTMLElement>('.sq.project .project-mini')!
  assert.ok(card)
  await inAct(() => card.dispatchEvent(new MouseEvent('pointerover', { bubbles: true })))
  assert.equal(card.title, facts)
  // The registered lookup must read the replacement feed, not a captured tree.
  tree.slot_leases = []; tree.watchdogs = []
  await v.render(render())
  await inAct(() => card.dispatchEvent(new MouseEvent('pointerover', { bubbles: true })))
  assert.equal(card.title, "Project · slots 0/2 held · mail: 4 q'd · 1 in flight · # Test project")
})
