import test from 'node:test'
import assert from 'node:assert/strict'
import { mountView, inAct } from './harness'
import { agentTooltipInfo } from '../src/canvas/OrgCanvas'
import { ProjectSquare } from '../src/canvas/projectcard'
import { AgentNavProvider, useProvideAgentNav } from '../src/canvas/agentnav'
import { ProjectLink } from '../src/canvas/identity'
import { useContextMenu } from '../src/canvas/contextmenu'
import { bunchTree, project } from './projectbunch-fixture'
import type { CanvasNode } from '../src/canvas/shared'
import type { Watchdog } from '../src/types'

// USER 2026-10-21 15:56:03Z, :42Z and :49Z: name alone exactly when
// no coloured fact chips would render in the project header, at every zoom.
const id = 'empty-project'
const dog = (kind: Watchdog['kind'], extra = {}) => ({ id: `worker/${kind}`, owner: 'worker',
  name: kind, kind, state: 'armed', target: id, at: '', ...extra } as Watchdog)
const cases = [
  { label: 'empty', patch: {}, dogs: [], chips: [], title: id },
  { label: 'summary is not a chip', patch: { charter: '# Summary only' }, dogs: [], chips: [], title: id },
  { label: 'ACK mode with no mail', patch: { configured_scope: { mail_queue: 'ack' } }, dogs: [], chips: [], title: id },
  { label: 'enabled events without listeners', patch: { configured_scope: { event_listeners: true } }, dogs: [], chips: [], title: id },
  { label: 'inactive listeners', patch: {}, dogs: [dog('project_listener', { state: 'paused' }), dog('listener_watch', { spent: true, count: 3 }), dog('fair_queue', { state: 'paused' })], chips: [], title: id },
  { label: 'retired marker is not a coloured fact chip', patch: { state: 'archived', charter: '# Old summary' }, dogs: [], chips: [], title: id },
  { label: 'slots', patch: { configured_scope: { slots_capacity: 2 } }, dogs: [], chips: ['0/2 held'], title: '0/2 held' },
  { label: 'queued mail', patch: { mail_pending: 2 }, dogs: [], chips: ["2 q'd"], title: "2 q'd" },
  { label: 'ACK in flight', patch: { configured_scope: { mail_queue: 'ack' }, mail_held: 1 }, dogs: [], chips: ['1 in flight'], title: '1 in flight' },
  { label: 'mail listener', patch: {}, dogs: [dog('fair_queue')], chips: ['1 listener'], title: '1 listener' },
  { label: 'event listener', patch: {}, dogs: [dog('project_listener')], chips: ['listeners 1'], title: 'listeners 1' },
  { label: 'listener watch', patch: {}, dogs: [dog('listener_watch', { count: 3 })], chips: ['listeners 0/3'], title: 'listeners 0/3' },
]
for (const c of cases) test(`project name-only hover matches rendered chips: ${c.label}`, async t => {
  const node = { ...project(id), configured_scope: {}, ...c.patch } as unknown as CanvasNode
  const tree = { ...bunchTree([node]), watchdogs: c.dogs, slot_leases: [] }, noop = () => {}
  const info = () => agentTooltipInfo(node, [], null, undefined, undefined, tree)
  function View() {
    useProvideAgentNav(() => [], info)
    const menu = useContextMenu()
    return <>{(['norm', 'mini'] as const).map(lod => <ProjectSquare key={lod} node={node} tree={tree}
      pos={{ x: 0, y: 0 }} lod={lod} slug={tree.slug} dragging={false} isDrop={false}
      op={async () => ({ ok: true } as never)} toast={noop} zoom={1} hire={{}} seats={{}}
      onHire={noop} onNewProject={noop} onInbox={noop} retiredCount={1} onRetired={noop}
      onDragStart={noop} onDragMove={noop} onDragEnd={noop} onDragCancel={noop} />)}
      <ProjectLink id={id} onFocus={noop} />
      <button className="fallback-menu" onClick={e => menu.open(e, [{ label: 'Project…', agentTooltipId: id, onSelect: noop }])}>Menu</button>{menu.node}</>
  }
  const v = await mountView(<AgentNavProvider><View /></AgentNavProvider>, el => el)
  t.after(() => v.unmount())
  const card = v.el.querySelector<HTMLElement>('.sq.project:not(.mini)')!
  const chips = [...card.querySelectorAll('.project-slots-badge,.project-listeners-badge,.project-queue-badge')].map(el => el.textContent)
  assert.deepEqual(chips, c.chips, 'observe the actual header, excluding its grey retired badge')
  assert.equal(info()?.title, c.title)
  if (chips.length) assert.equal(info()?.title, chips.join(' · '), 'facts are exactly the rendered chip text')
  assert.equal(info()?.title === id, chips.length === 0, 'fallback iff no coloured header chips')
  const targets = [card, card.querySelector<HTMLElement>('.name')!, card.querySelector<HTMLElement>('.project-mark')!,
    v.el.querySelector<HTMLElement>('.project-mini')!, v.el.querySelector<HTMLElement>('.ref-ready')!]
  await inAct(() => v.el.querySelector<HTMLButtonElement>('.fallback-menu')!.click())
  targets.push(document.querySelector<HTMLElement>(`.ctxmenu [data-agent-tooltip="${id}"]`)!)
  for (const el of targets) {
    assert.ok(el)
    await inAct(() => el.dispatchEvent(new MouseEvent('pointerover', { bubbles: true })))
    const prefix = chips.length > 0 && el.hasAttribute('data-agent-tooltip-name-first') ? `${id}\n` : ''
    assert.equal(el.title, prefix + c.title, el.className)
  }
})
