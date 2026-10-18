import test from 'node:test'
import assert from 'node:assert/strict'
import { FakeServer, flush, inAct, installFetch, mountView } from './harness'
import { DeskChat } from '../src/canvas/desk'
import { NodeSquare } from '../src/canvas/cards'
import { ProjectDesk } from '../src/canvas/projectdesk'
import { syncProviderRegistries } from '../src/canvas/shared'
import type { CanvasNode } from '../src/canvas/shared'
import type { TreePayload } from '../src/types'
import { resetConvos } from '../src/convo'
const noop=()=>{}
const worker={id:'worker',tier:'sol',state:'live',dnd:true,busy:true,generation:1,model_id:'gpt-6.1-sol',
  children:[],seat:2,grant:0,free:0,scope:{tools:{},add_dirs:[],effort:'high'},configured_scope:{tools:{},add_dirs:[]},
  turns:[],lineage:[],audiences_held:[],mail_pending:0} as unknown as CanvasNode
function setup(){resetConvos();installFetch(new FakeServer());syncProviderRegistries({providers:[{id:'openai',tiers:[{tier:'sol',model:'gpt-6.1-sol',fast_mode:true,effort_levels:['low','medium','high']}]}]})}
test('card and desk put DND in token rows and urgent beside the top-row lightning',async t=>{
  setup();const map=new Map([[worker.id,worker]])
  const v=await mountView(<><NodeSquare node={worker} pos={{x:0,y:0}} lod="norm" focused={false}
    dragging={false} isDrop={false} seats={{used:2,total:4}} map={map} op={async()=>({})} slug="dnd-placement" toast={noop}
    pxc={1} zoom={1} compactAt={0.8} maxTop={0} cascadeAlloc onSpawn={noop} onSpawnSide={noop} onSpawnTop={noop}
    onConfig={noop} onInbox={noop} onLineage={noop} onOpenDoc={noop} onRecenter={noop} onJump={noop} onMailLink={noop}
    onDragStart={noop} onDragMove={noop} onDragEnd={noop} onDragCancel={noop}/>
    <DeskChat node={worker} map={map} slug="dnd-placement" op={async()=>({})} toast={noop} bare/></>,el=>el)
  t.after(async()=>{await v.unmount();resetConvos()});await inAct(async()=>{await flush(4)})
  const token=v.el.querySelector('.sq-badges .dnd-badge')
  assert.equal(token?.textContent,'DND')
  assert.ok(token?.classList.contains('badge'))
  assert.ok(token?.previousElementSibling?.classList.contains('effort-level'),'next to high effort')
  assert.equal(v.el.querySelector('.sq-meta .dnd-badge')===null,true)
  assert.equal(v.el.querySelector('.cc-head-meta .dnd-badge')?.textContent,'DND')
  const urgent=v.el.querySelector<HTMLButtonElement>('.cc-fast-row .cc-urgent-toggle')
  assert.ok(urgent,'urgent in composer top row')
  assert.ok(urgent.closest('.cc-fast-row')?.querySelector('.cc-fast'),'same row as the lightning')
  assert.equal(urgent.textContent,'!');await inAct(()=>urgent.click())
  assert.equal(urgent.getAttribute('aria-pressed'),'true');assert.ok(urgent.classList.contains('armed'))
})
test('project broadcast offers the same urgent button only with a DND recipient',async t=>{
  setup();const project={...worker,id:'build',kind:'project',tier:'project',dnd:false,busy:false,children:[worker]} as CanvasNode
  const v=await mountView(<ProjectDesk node={project} slug="dnd-project-placement" tree={{slug:'dnd-project-placement',roots:[project]} as unknown as TreePayload}
    map={new Map([[project.id,project],[worker.id,worker]])} op={async()=>({})} toast={noop}
    refs={{world:{org:'dnd-project-placement'},onOpen:noop} as never}/>,el=>el)
  t.after(async()=>{await v.unmount();resetConvos()});await inAct(async()=>{await flush(4)})
  assert.equal(v.el.querySelector('.cc-urgent-toggle')===null,true)
  await inAct(()=>v.el.querySelector<HTMLButtonElement>('.cc-broadcast-toggle')!.click())
  const urgent=v.el.querySelector<HTMLButtonElement>('.project-composer .cc-urgent-toggle')
  assert.ok(urgent);assert.equal(urgent.textContent,'!');await inAct(()=>urgent.click())
  assert.equal(urgent.getAttribute('aria-pressed'),'true')
  await inAct(()=>v.el.querySelector<HTMLButtonElement>('.cc-broadcast-toggle')!.click())
  assert.equal(v.el.querySelector('.cc-urgent-toggle')===null,true)
})
