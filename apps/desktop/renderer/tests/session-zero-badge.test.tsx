import { FakeServer, inAct, installFetch, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { DeskChat } from '../src/canvas/desk'
import { NodeSquare } from '../src/canvas/cards'
import type { CanvasNode } from '../src/canvas/shared'
import { resetConvos } from '../src/convo'
import { fmtStamp } from '../src/timefmt'

const noop = () => {}
const node = (placement: unknown): CanvasNode => ({ id: 'worker', tier: 'sol', state: 'live',
  generation: 1, children: [], busy: true, seat: 2, grant: 0, free: 0,
  scope: { tools: {}, add_dirs: [], session: 'session0' }, session_placement: placement,
} as CanvasNode)
const desk = (n: CanvasNode) => <DeskChat node={n} map={new Map([[n.id,n]])}
  op={async () => ({})} slug="demo" toast={noop} bare />
const card = (n: CanvasNode) => <NodeSquare node={n} pos={{x:0,y:0}} lod="norm"
  focused={false} dragging={false} isDrop={false} seats={{sol:2}}
  map={new Map([[n.id,n]])} op={async () => ({})} slug="demo" toast={noop} pxc={1} zoom={1}
  compactAt={0.8} maxTop={0} cascadeAlloc onSpawn={noop} onSpawnSide={noop}
  onSpawnTop={noop} onConfig={noop} onInbox={noop} onLineage={noop} onOpenDoc={noop}
  onRecenter={noop} onJump={noop} onMailLink={noop} onWorkLink={noop}
  onDragStart={noop} onDragMove={noop} onDragEnd={noop} onDragCancel={noop} />
const reasons = [
  ['signed-out', 'The user is signed out of Windows'],
  ['helper-unreachable', "Orgtree's sign-in helper did not connect in time"],
  ['preference', "This agent's own choice (its session preference or a one-turn pick)"],
  ['background-work', 'Its CLI is still running background work'],
  [null, 'Runs in Windows Session 0'],
] as const
const at = '2026-10-22T08:00:00Z'

test.beforeEach(() => { localStorage.clear(); resetConvos(); installFetch(new FakeServer()) })
test.afterEach(() => resetConvos())
for (const [name,render,row] of [['desk',desk,'.cc-head-meta'],['zoom card',card,'.sq-badges']] as const) {
  test(`${name}: placement feed alone controls the Session 0 badge, reason, since and keyboard label`, async t => {
    const view = await mountView(render(node(null)), el => el)
    t.after(() => view.unmount())
    for (const placement of [undefined,null,{session:'signed-in',reason:null,at}]) {
      await view.render(render(node(placement)))
      assert.equal(view.el.querySelector('.session-0'),null,'saved preference is not placement evidence')
    }
    for (const [reason,description] of reasons) {
      await view.render(render(node({session:'session0',reason,at})))
      const badges = view.el.querySelectorAll<HTMLElement>('.badge.session-0')
      assert.equal(badges.length,1)
      const badge=badges[0]
      assert.equal(badge.parentElement,view.el.querySelector(row))
      assert.equal(badge.textContent,'Session 0')
      assert.equal(badge.title,`${description}\nSince ${fmtStamp(at)}`)
      assert.equal(badge.getAttribute('aria-label'),badge.title)
      assert.equal(badge.tabIndex,0)
      await inAct(() => badge.focus())
      assert.equal(document.activeElement,badge)
    }
    await view.render(render({...node({session:'session0',reason:null,at:null}),busy:false,proc_live:false}))
    assert.equal(view.el.querySelector<HTMLElement>('.session-0')?.title,'Runs in Windows Session 0')
    await view.render(render(node({session:'signed-in',reason:null,at})))
    assert.equal(view.el.querySelector('.session-0'),null,'a later tree update clears the badge')
  })
}
