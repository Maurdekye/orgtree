import {advance,flush,inAct,mountView,useFakeClock,realClock} from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import {NodeSquare} from '../src/canvas/cards'
import {AgentWorkstate,TrayStatus,TurnStatusBanner,isUsageFrozen,deriveTurnState} from '../src/canvas/desk'
import type {CanvasNode} from '../src/canvas/shared'
import type {TreeFrozen} from '../src/types'
const noop = () => {}
const op = () => Promise.resolve({ ok: true } as any)
const toast = () => {}
const seats = { haiku: 1, sonnet: 2, opus: 5, fable: 10,
  'gpt-reserve': 0.2, luna: 0.2, terra: 2, sol: 5, flash: 1, pro: 2 }
const hire = { enabled: true, installed: true, reason: null }

function makeNode(overrides: Partial<CanvasNode> = {}): CanvasNode {
  return {
    id: 'test-agent',
    title: 'test-agent',
    state: 'live',
    tier: 'haiku',
    model_id: 'haiku',
    proc_warm: true,
    proc_live: true,
    proc_relaunch: false,
    proc_relaunch_reason: null,
    busy: false,
    waiting: false,
    children: [],
    seat: 1,
    grant: 0,
    free: 0,
    occupancy: 500,
    context_window: 1000,
    scope: { tools: {}, add_dirs: [] },
    ...overrides,
  }
}

function renderCard(node: CanvasNode, mapMode = false) {
  return mountView(
    <NodeSquare
      node={node}
      pos={{ x: 0, y: 0 }}
      lod={mapMode ? 'map' : 'norm'}
      mapMode={mapMode}
      focused={false}
      dragging={false}
      isDrop={false}
      seats={seats}
      codexHire={hire}
      antigravityHire={hire}
      claudeHire={hire}
      map={new Map([[node.id, node]])}
      op={op}
      slug="org"
      toast={noop}
      pxc={1}
      zoom={1}
      compactAt={0.8}
      pub={false}
      maxTop={0}
      kioskRemaining={null}
      cascadeAlloc
      onSpawn={noop}
      onSpawnSide={noop}
      onSpawnTop={noop}
      onConfig={noop}
      onInbox={noop}
      onLineage={noop}
      onOpenDoc={noop}
      onRecenter={noop}
      onJump={noop}
      onMailLink={noop}
      onDragStart={noop}
      onDragMove={noop}
      onDragEnd={noop}
      onDragCancel={noop}
    />,
    (el) => el
  )
}


const freeze=(until:number|null):TreeFrozen=>({at:null,until:null,until_ts:until,error:null,limit:true})
test('usage freeze takes presentation precedence; execution and recorded status are untouched',async()=>{
 const n=makeNode({busy:true,waiting:true,phase:'compacting',frozen:freeze(null),last_status:{status:'working',summary:'real report',at:'2026-01-01'} as any})
 const before=JSON.stringify(n)
 assert.equal(deriveTurnState(n),'compacting','execution classification is unchanged')
 const v=await renderCard(n)
 try{assert.equal(v.el.querySelector('.sq-workstate .sq-idle')?.textContent,'Frozen');assert.equal(v.el.querySelectorAll('.sq-workstate .cc-spin').length,0)}finally{await v.unmount()}
 assert.equal(JSON.stringify(n),before)
 for(const f of [{...freeze(12),connection:true,limit:false},{...freeze(12),cause:'auth'},{...freeze(12),cause:'balance'},{...freeze(12),spend:true}])assert.equal(isUsageFrozen({...n,frozen:f}),false)
 assert.equal(isUsageFrozen({...n,limit_locked:true}),false)
 assert.equal(isUsageFrozen({...n,state:'retired'}),false)
})
test('shared timer updates all presentations without props or SSE; expiry stays Frozen and clear restores report',async t=>{
 useFakeClock(); const n=makeNode({frozen:freeze(Date.now()/1000+3),last_status:{status:'working',summary:'original',at:'2026-01-01'} as any})
 const contents=(node:CanvasNode)=><div><AgentWorkstate node={node}/><TrayStatus node={node}/><TurnStatusBanner state="idle" recordedState={node.last_status?.status} frozen={isUsageFrozen(node)?node.frozen:null}/></div>
 const v=await mountView(contents(n),e=>e)
 t.after(async()=>{await v.unmount();realClock()})
 assert.equal(v.el.querySelectorAll('.usage-freeze-status').length,3)
 assert.ok([...v.el.querySelectorAll('.usage-freeze-status')].every(e=>e.textContent==='Frozen0:03'))
 await advance(1000)
 assert.ok([...v.el.querySelectorAll('.usage-freeze-status')].every(e=>e.textContent==='Frozen0:02'))
 await advance(3000)
 assert.ok([...v.el.querySelectorAll('.usage-freeze-status')].every(e=>e.textContent==='Frozenreset due'))
 await v.render(contents({...n,frozen:freeze(Date.now()/1000+60)}));assert.match(v.el.textContent??'',/1:00/)
 for(const bad of [null,NaN,Infinity,-1]){await v.render(contents({...n,frozen:freeze(bad)}));assert.ok([...v.el.querySelectorAll('.usage-freeze-status')].every(e=>e.textContent==='Frozen'));assert.match(v.el.querySelector('.usage-freeze-status')?.getAttribute('title')??'',/unknown/)}
 await v.render(contents({...n,frozen:null}));assert.equal(v.el.querySelectorAll('.usage-freeze-status').length,0);assert.equal(v.el.querySelector('.turn-status-label')?.textContent,'Working')
 await v.render(contents({...n,frozen:null,busy:true}));assert.match(v.el.textContent??'',/Active/)
})
