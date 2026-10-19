import { FakeServer, installFetch, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { DeskChat } from '../src/canvas/desk'
import { NodeSquare } from '../src/canvas/cards'
import { FastModeButton } from '../src/canvas/fastmodebutton'
import { syncProviderRegistries } from '../src/canvas/shared'
import type { CanvasNode } from '../src/canvas/shared'
import { resetConvos } from '../src/convo'

const noop = () => {}
const op = async () => ({})
const agent = (): CanvasNode => ({
  id: 'worker', tier: 'sol', state: 'live', generation: 1, children: [], busy: true,
  seat: 2, grant: 0, free: 0, model_id: 'gpt-6.1-sol',
  scope: { tools: {}, add_dirs: [], effort: 'high', fast_mode: true },
  effort_current: 'medium', effort_effective: 'high', pending_effort: 'high',
  fast_mode_current: false, account: 'openai/primary',
  pending_account: { account: 'openai/backup' }, pending_switch: { tier: 'luna' },
} as CanvasNode)
const desk = (node: CanvasNode) => <DeskChat node={node} map={new Map([[node.id,node]])}
  op={op} slug="org" toast={noop} bare />
const card = (node: CanvasNode) => <NodeSquare node={node} pos={{x:0,y:0}} lod="norm"
  focused={false} dragging={false} isDrop={false} seats={{sol:2,luna:1}}
  map={new Map([[node.id,node]])} op={op} slug="org" toast={noop} pxc={1} zoom={1}
  compactAt={0.8} maxTop={0} cascadeAlloc onSpawn={noop} onSpawnSide={noop}
  onSpawnTop={noop} onConfig={noop} onInbox={noop} onLineage={noop} onOpenDoc={noop}
  onRecenter={noop} onJump={noop} onMailLink={noop} onWorkLink={noop}
  onDragStart={noop} onDragMove={noop} onDragEnd={noop} onDragCancel={noop} />

test.beforeEach(() => {
  localStorage.clear(); resetConvos(); installFetch(new FakeServer())
  syncProviderRegistries({providers:[{id:'openai',tiers:[{tier:'sol',fast_mode:true}]}]})
})
test.afterEach(() => resetConvos())

for (const surface of ['desk','near card'] as const) test(`${surface}: all four pending cards share the header badge row`, async () => {
  const n=agent(), render=surface==='desk'?desk:card
  const v=await mountView(render(n),el=>el)
  try {
    const row=v.el.querySelector(surface==='desk'?'.cc-head-meta':'.sq-badges')!
    const badges=[...row.querySelectorAll<HTMLElement>('[data-next-turn]')]
    assert.deepEqual(badges.map(b=>b.dataset.nextTurn),['account','model','effort','fast'])
    assert.equal(badges.every(b=>b.parentElement===row&&b.classList.contains('queued')),true)
    assert.equal(v.el.querySelectorAll('[data-next-turn]').length,4,'one copy of each pending card')
    assert.equal(!!v.el.querySelector('.cc-controls [data-next-turn]'),false,'no pending card in the composer')
    assert.equal(row.querySelector('[data-next-turn="effort"]')?.getAttribute('title'),"worker's effort will change from medium to high next turn")
    assert.equal(row.querySelector('[data-effort-level]')?.textContent,'medium','retain current effort while waiting')
    await v.render(render({...n,pending_effort:null,pending_account:null,pending_switch:null,fast_mode_current:true}))
    assert.equal(!!v.el.querySelector('[data-next-turn]'),false,'reverting/applying queued changes clears every card')
  } finally {await v.unmount()}
})

test('the composer speed control keeps its toggle without rendering a pending card',async()=>{
  const v=await mountView(<FastModeButton node={agent()} slug="org" toast={noop}/>,el=>el)
  try {
    assert.equal(!!v.el.querySelector('[aria-label="Fast mode"]'),true)
    assert.equal(!!v.el.querySelector('[data-next-turn]'),false)
  } finally {await v.unmount()}
})

for (const next of [true,false]) test('pending speed '+next+' is highlighted distinctly until admission',async()=>{
  const n={...agent(),scope:{...agent().scope,fast_mode:next},fast_mode_current:!next}, control=(node:CanvasNode)=><FastModeButton node={node} slug="org" toast={noop}/>
  const v=await mountView(control(n),el=>el)
  try {
    assert.equal(!!v.el.querySelector('.cc-fast.on.queued-speed'),true)
    await v.render(control({...n,fast_mode_current:next}))
    assert.equal(!!v.el.querySelector('.cc-fast.on'),next)
    assert.equal(!!v.el.querySelector('.queued-speed'),false)
    await v.render(control({...n,scope:{...n.scope,fast_mode:false},fast_mode_current:false}))
    assert.equal(!!v.el.querySelector('.cc-fast.on'),false)
  } finally {await v.unmount()}
})
