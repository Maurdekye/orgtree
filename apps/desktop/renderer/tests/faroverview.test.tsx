import { inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { useState } from 'react'
import { NodeSquare, UserNode } from '../src/canvas/cards'
import type { CanvasNode } from '../src/canvas/shared'
import { Z_MINI } from '../src/canvas/shared'
import type { OpResult } from '../src/types'
const noop = () => {}
const op = () => Promise.resolve({} as OpResult)
const seats = {haiku:1,sonnet:2,opus:5}
const hire = {enabled:true,installed:true,reason:null}
interface Sink {spawned:string[];downs:string[]}
function node(): CanvasNode {
  return {
    id: 'target', title: 'target', state: 'live', tier: 'haiku', model_id: 'haiku',
    seat: 1, grant: 0, free: 0, scope: { tools: {}, add_dirs: [] },
    children: [], lineage: [], turns: [], audiences_held: [],
    bearer_state: null, frozen: null, limit_locked: false, mail_pending: 0,
    last_status: { status: 'working', summary: 'fixture', at: '' },
    prev_status: null, inflight_at: null, last_denials: [],
    occupancy: 100, occupancy_est: false, context_window: 1000,
    busy: false, activity: null, proc_warm: true, proc_live: true,
    proc_relaunch: false, proc_relaunch_reason: null, isBearerOf: undefined,
  } as unknown as CanvasNode
}

function card(lod:'mini'|'norm',sink:Sink={spawned:[],downs:[]}) {
  const nd = node()
  nd.documents = [{id:"plan",title:"Plan",format:"markdown",at:"2026-10-13T00:00:00Z",bytes:10},{id:"html",title:"Mockup",format:"html",at:"2026-10-13T00:00:01Z",bytes:20}] as CanvasNode["documents"]
  return mountView(
    <NodeSquare node={nd} pos={{ x: 0, y: 0 }} lod={lod} focused={false}
      dragging={false} isDrop={false} seats={seats} codexHire={hire}
      antigravityHire={hire} claudeHire={hire}
      map={new Map([[nd.id, nd]])} op={op} slug="org" toast={noop}
      pxc={1} zoom={lod === 'mini' ? 0.24 : 0.8} compactAt={0.8}
      maxTop={0} cascadeAlloc
      onSpawn={(t) => sink.spawned.push(`b:${t}`)}
      onSpawnSide={(t, side) => sink.spawned.push(`${side}:${t}`)}
      onSpawnTop={(t) => sink.spawned.push(`t:${t}`)}
      onConfig={noop} onInbox={noop} onLineage={noop} onOpenDoc={noop}
      onRecenter={noop} onJump={noop} onMailLink={noop}
      onDragStart={(_e, id) => sink.downs.push(id)}
      onDragMove={noop} onDragEnd={noop} onDragCancel={noop} />,
    (el) => el)
}

test('side markdown and HTML presentation cards disappear only at mini',async(t)=>{
  const near=await card('norm');const far=await card('mini')
  t.after(()=>near.unmount());t.after(()=>far.unmount())
  assert.equal(near.el.querySelectorAll('.doc-chip').length,2,'normal control has both retained attachments')
  assert.equal(far.el.querySelector('.doc-chips'),null,'no hidden hit target or focusable attachment remains')
  assert.ok(far.el.querySelector('.sq-far-tier'),'agent identity survives')
  assert.equal(far.el.querySelectorAll('.hsof').length,4,'hire controls retain far behaviour')
})
test('switchboard credit bar disappears below the exact shared boundary and returns',async(t)=>{
  const set:{current:((z:number)=>void)|null}={current:null}
  function Host(){const [zoom,change]=useState(Z_MINI);set.current=change;return <UserNode
    pos={{x:0,y:0}} isDrop={false} stats={{circ:8,seats:2,free:6}} seats={seats}
    codexHire={hire} antigravityHire={hire} claudeHire={hire}
    pxc={1} zoom={zoom} focused={false} eyeW={124} posX={()=>0} map={new Map()}
    op={op} slug="far-proof" toast={noop} onSpawn={noop} onMailLink={noop} onWorkLink={noop}/>}
  const v=await mountView(<Host/>,el=>el);t.after(()=>v.unmount())
  assert.ok(v.el.querySelector('.cbar-inf-wrap'),'boundary remains normal')
  await inAct(()=>set.current!(Z_MINI-0.001))
  assert.equal(v.el.querySelector('.cbar-inf-wrap'),null,'hover detail and bar both removed')
  assert.ok(v.el.querySelector('.eye'),'switchboard identity survives')
  await inAct(()=>set.current!(Z_MINI))
  assert.ok(v.el.querySelector('.cbar-inf-wrap'),'restored without remounting switchboard')
  assert.match(v.el.querySelector('.cbar-tip')!.textContent!,/circulation8seats2free6/)
})
