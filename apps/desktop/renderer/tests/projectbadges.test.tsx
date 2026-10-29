import {FakeServer,flush,inAct,installFetch,mountView} from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import {ProjectSquare} from '../src/canvas/projectcard'
import {AgentSurfaceRoutesProvider} from '../src/canvas/panelcorner'
import type {CanvasNode} from '../src/canvas/shared'
import type {OpResult,TreePayload,Watchdog} from '../src/types'

// UX symmetry audit 2026-10-29 #48 (ux09 S3) and #49 (ux09 S5): a project's
// norm node behaves like an agent's card and like its own desk — its expanded
// hire strip collapses when the pointer leaves, and its slot, listener and
// queue badges open the same views its desk header cards open.
const noop=()=>{}
const offer={enabled:true,installed:true,reason:null}
const seats={haiku:1,sonnet:2,opus:5}
const op=()=>Promise.resolve({} as OpResult)
const tick=async()=>{for(let i=0;i<5;i++)await flush()}
function project(extra:Partial<CanvasNode>={}):CanvasNode{
  return {id:'sync',title:'sync',kind:'project',state:'live',tier:'project',model_id:'',
    seat:0,grant:0,free:0,scope:{tools:{},add_dirs:[]},
    configured_scope:{tools:{},add_dirs:[],slots_capacity:3,event_listeners:true},
    parent:'boss',charter:'A rendezvous.',children:[{id:'sa',title:'sa',tier:'haiku',state:'live',busy:false,children:[]}],
    lineage:[],turns:[],audiences_held:[],mail_pending:3,mail_held:0,
    last_status:null,occupancy:0,context_window:0,busy:false,activity:null,...extra} as unknown as CanvasNode
}
const dog=(kind:Watchdog['kind'],owner:string,name:string):Watchdog=>
  ({id:owner+'/'+name,owner,name,kind,target:'sync',interval_s:5,state:'armed',at:'2026-10-29T07:00:00.000Z',fired:0,once:false,spent:false} as Watchdog)
const tree=({slug:'org',roots:[],watchdogs:[dog('project_listener','sa','ready'),dog('fair_queue','sb','mail')],
  slot_leases:[{project:'sync',agent:'sa',slot:1,lease:'l1',since:'2026-10-29T09:00:00.000Z',reminders:0}]} as unknown as TreePayload)
function serve(t:test.TestContext){const had=(globalThis as {fetch?:typeof fetch}).fetch;installFetch(new FakeServer());t.after(()=>{(globalThis as {fetch?:typeof fetch}).fetch=had})}
function card(log:string[],o:{zoom?:number;routes?:boolean;drag?:string[]}={}){
  const nd=project()
  const el=<ProjectSquare node={nd} pos={{x:0,y:0}} lod="norm" tree={tree} map={new Map([[nd.id,nd]])}
    dragging={false} isDrop={false} op={op} slug="org" toast={noop} zoom={o.zoom??1}
    hire={{claudeHire:offer}} seats={seats} onHire={noop} onNewProject={noop}
    onInbox={()=>{log.push('mail')}}
    onDragStart={()=>{o.drag?.push('drag')}} onDragMove={noop} onDragEnd={noop} onDragCancel={noop}/>
  return o.routes===false?el:<AgentSurfaceRoutesProvider value={{open:(kind,id)=>{log.push(`open:${kind}:${id}`)},show:noop}}>{el}</AgentSurfaceRoutesProvider>
}

test('#49 the norm node badges are buttons opening the desk views, with the shortcut labels',async t=>{
  serve(t)
  const log:string[]=[],drag:string[]=[]
  const view=await mountView(card(log,{drag}),el=>el);t.after(()=>view.unmount());await inAct(tick)
  const sq=view.el.querySelector<HTMLElement>('.sq.project')!;assert.ok(sq,'the project norm node')
  const badge=(cls:string)=>sq.querySelector<HTMLElement>('.'+cls)
  for(const [cls,label] of [['project-slots-badge','slots of project sync'],['project-listeners-badge','events of project sync'],['project-queue-badge','events of project sync']] as const){
    const b=badge(cls);assert.ok(b,cls+' shows')
    assert.equal(b!.tagName,'BUTTON',cls+' is a button, as its desk card is')
    assert.equal(b!.getAttribute('aria-label'),label,cls+' carries its view\'s keyboard label, as the card shortcut does')
    assert.ok((b!.getAttribute('title')??'').length>0,cls+' keeps its facts on hover')
  }
  await inAct(()=>{badge('project-slots-badge')!.dispatchEvent(new MouseEvent('pointerdown',{bubbles:true,cancelable:true}))})
  assert.deepEqual(drag,[],'pressing a badge never starts a card drag')
  await inAct(()=>{(badge('project-slots-badge') as HTMLButtonElement).click()})
  await inAct(()=>{(badge('project-listeners-badge') as HTMLButtonElement).click()})
  await inAct(()=>{(badge('project-queue-badge') as HTMLButtonElement).click()})
  assert.deepEqual(log,['open:project-slots:sync','open:project-listeners:sync','open:project-listeners:sync'],
    'slots and listeners open their windows as the shortcuts do; the queue badge follows the desk card: listeners armed, so the listeners view')
})

test('#49 with nobody listening for its mail, the queue badge opens the project mailbox, as the desk card does',async t=>{
  serve(t)
  const log:string[]=[]
  const bare=({...tree,watchdogs:[dog('project_listener','sa','ready')]} as unknown as TreePayload)
  const nd=project()
  const view=await mountView(<AgentSurfaceRoutesProvider value={{open:(kind,id)=>{log.push(`open:${kind}:${id}`)},show:noop}}>
    <ProjectSquare node={nd} pos={{x:0,y:0}} lod="norm" tree={bare} map={new Map([[nd.id,nd]])}
      dragging={false} isDrop={false} op={op} slug="org" toast={noop} zoom={1}
      hire={{claudeHire:offer}} seats={seats} onHire={noop} onNewProject={noop}
      onInbox={()=>{log.push('mail')}}
      onDragStart={noop} onDragMove={noop} onDragEnd={noop} onDragCancel={noop}/>
  </AgentSurfaceRoutesProvider>,el=>el);t.after(()=>view.unmount());await inAct(tick)
  const q=view.el.querySelector<HTMLButtonElement>('.project-queue-badge')!
  assert.ok(q,'mail waiting still badges')
  assert.equal(q.getAttribute('aria-label'),'mailbox of project sync')
  await inAct(()=>{q.click()})
  assert.deepEqual(log,['mail'],'no mail listeners: the mailbox, as the desk queue card opens its inbox')
})

test('#49 without surface routes the badges stay passive facts, not dead buttons',async t=>{
  serve(t)
  const view=await mountView(card([],{routes:false}),el=>el);t.after(()=>view.unmount());await inAct(tick)
  for(const cls of ['project-slots-badge','project-listeners-badge']){
    const b=view.el.querySelector('.'+cls);assert.ok(b,cls+' still shows its fact')
    assert.equal(b!.tagName,'SPAN',cls+' is no button when this surface cannot open the view')
  }
})

test('#48 an expanded project hire strip collapses when the pointer leaves, like an agent\'s',async t=>{
  serve(t)
  const view=await mountView(card([],{zoom:0.5}),el=>el);t.after(()=>view.unmount());await inAct(tick)
  const sq=view.el.querySelector<HTMLElement>('.sq.project')!
  const strip=sq.querySelector<HTMLElement>('.hsof.hire-compact:not(.side)')!
  assert.ok(strip,'the compact bottom hire strip at this zoom')
  const expand=strip.querySelector<HTMLButtonElement>('.hire-expand')!
  await inAct(()=>{expand.click()})
  assert.equal(strip.classList.contains('is-expanded'),true,'the strip expands')
  assert.equal(expand.getAttribute('aria-expanded'),'true')
  await inAct(()=>{sq.dispatchEvent(new MouseEvent('pointerout',{bubbles:true,relatedTarget:document.body}))})
  assert.equal(strip.classList.contains('is-expanded'),false,'leaving the card collapses it, as NodeSquare clears its expanded edge')
  assert.equal(expand.getAttribute('aria-expanded'),'false')
  // and it can be expanded again afterwards
  await inAct(()=>{expand.click()})
  assert.equal(strip.classList.contains('is-expanded'),true,'expanding again still works')
})
