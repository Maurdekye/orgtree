import {FakeServer,flush,inAct,installFetch,mountView} from './harness'
import test from 'node:test'
import type {TestContext} from 'node:test'
import assert from 'node:assert/strict'
import {OrgCanvas} from '../src/canvas/OrgCanvas'
import {ProjectInboxModal} from '../src/canvas/projectdesk'
import * as listeners from '../src/canvas/listeners'
import {AgentNavProvider} from '../src/canvas/agentnav'
import {CurrentOrg} from '../src/popout'
import {forgetModalOpenCache,forgetModalPins} from '../src/canvas/modalpin'
import {readPinSurfaces,removePinSurface} from '../src/canvas/pinspace'
import {resetConvos} from '../src/convo'
import {saveView,setStartView} from '../src/canvas/shared'
import type {CanvasNode} from '../src/canvas/shared'
import type {OpResult,TreePayload,Watchdog} from '../src/types'

// A project node's mail-queue badge opens the project mailbox at the folder
// its desk's queue card opens (docket project-node-s-mail-listeners-badge-
// opens-the-pr, USER 2026-10-29 22:40:18Z): the listeners folder while mail
// listeners are armed, else the inbox. S5 #49 had sent it to the project's
// EVENTS window, which lists event listeners, not the fair_queue ones.
const org='queue-badge',noop=()=>{},op=()=>Promise.resolve({} as OpResult)
const tick=async()=>{for(let i=0;i<6;i++)await flush()}
const dog=(kind:Watchdog['kind'],owner:string,name:string,state:Watchdog['state']='armed'):Watchdog=>
  ({id:owner+'/'+name,owner,name,kind,target:'sync',interval_s:5,state,at:'2026-10-29T07:00:00.000Z',fired:0,once:false,spent:false} as Watchdog)
const member={id:'sa',title:'sa',tier:'haiku',state:'live',busy:false,children:[]}
const project=():CanvasNode=>({id:'sync',title:'sync',kind:'project',state:'live',tier:'project',model_id:'',generation:1,
  seat:0,grant:0,free:0,scope:{tools:{},add_dirs:[]},configured_scope:{tools:{},add_dirs:[],event_listeners:true},
  parent:null,charter:'A rendezvous.',children:[member],lineage:[],turns:[],documents:[],audiences_held:[],mail_pending:3,mail_held:0,
  last_status:null,occupancy:0,context_window:0,busy:false,activity:null} as unknown as CanvasNode)
const treeOf=(node:CanvasNode,dogs:Watchdog[]):TreePayload=>({slug:org,name:org,roots:[node],dirs:[],tiers:{sol:2},audiences:[],
  credit_requests:[],audience_requests:[],watchdogs:dogs,audit:{live_nodes:1,top_level_holds:0,problems:[]},user_inbox_count:0,
  max_top_grant:1000,default_top_grant:50} as unknown as TreePayload)

const wipe=()=>{
  for(const s of readPinSurfaces().filter(s=>s.org===org))removePinSurface(s.key)
  localStorage.clear();forgetModalPins();forgetModalOpenCache()
}
/** every fetch answers; a mailbox read is empty. `mounted` views unmount BEFORE the window state is wiped: a mailbox
 *  window leaves its pin surface behind, and the next test's canvas would restore it */
function serve(t:TestContext){
  const had=globalThis.fetch,mounted:{unmount:()=>Promise<void>}[]=[]
  wipe();installFetch(new FakeServer());resetConvos()
  // a saved close camera, not the opening glide: the node must be at norm zoom (its badges are not drawn at mini) however
  // long the mount takes
  setStartView('remember');saveView(org,{x:0,y:0,z:1})
  const inner=globalThis.fetch
  globalThis.fetch=((input:RequestInfo|URL,init?:RequestInit)=>{
    if(/\/inbox$/.test(new URL(String(input),'http://localhost').pathname))
      return Promise.resolve(new Response(JSON.stringify({pending:[],delivered:[],sent:[],next_cursor:null}),{status:200}))
    return inner(input,init)
  }) as typeof fetch
  t.after(async()=>{
    for(const v of mounted.reverse())await v.unmount()
    await inAct(async()=>{wipe()});resetConvos();globalThis.fetch=had
  })
  return <V extends {unmount:()=>Promise<void>}>(v:V)=>{mounted.push(v);return v}
}
const folderOn=()=>[...document.querySelectorAll('.mail-folders > button.on')].map(b=>b.textContent?.replace(/\d+$/,'').trim())

test('the queue card names the folder it opens: listeners while any are armed, else the inbox',()=>{
  // read off the module so the suite still runs (and this fails) where the helper does not exist yet
  const mailQueueFolder=(listeners as unknown as Record<string,unknown>).mailQueueFolder as typeof listeners.mailQueueFolder
  assert.equal(typeof mailQueueFolder,'function','the shared helper exists')
  const {mailQueueCard}=listeners
  const armed=mailQueueCard('sync',3,0,false,[dog('fair_queue','sa','mail')])!
  const paused=mailQueueCard('sync',3,0,false,[dog('fair_queue','sa','mail','paused')])!
  const none=mailQueueCard('sync',3,0,false,[])!
  assert.equal(mailQueueFolder(armed),'listeners')
  assert.equal(mailQueueFolder(paused),'inbox','a paused listener takes no mail, so only the waiting mail shows')
  assert.equal(mailQueueFolder(none),'inbox')
})

test('a project mailbox window asked for the listeners folder opens on it, and follows a later request',async t=>{
  const own=serve(t)
  const nd=project(),tree=treeOf(nd,[dog('fair_queue','sa','mail')]),map=new Map([[nd.id,nd]])
  const show=(folder:{folder:string;seq:number}|null)=><ProjectInboxModal node={nd} slug={org} tree={tree} map={map} op={op} toast={noop}
    close={noop} folder={folder} />
  const view=own(await mountView(show({folder:'listeners',seq:1}),el=>el))
  await inAct(tick)
  assert.deepEqual(folderOn(),['listeners'],'the window opens on the folder it was asked for')
  await inAct(async()=>{document.querySelectorAll<HTMLButtonElement>('.mail-folders > button')[0]!.click()})
  assert.deepEqual(folderOn(),['inbox'],'the strip still works')
  await view.render(show({folder:'listeners',seq:2}))
  await inAct(tick)
  assert.deepEqual(folderOn(),['listeners'],'a new request while it is open brings the folder back')
})

test('the project node\'s mail-listeners badge opens the project mailbox at its listeners folder, not the events window',async t=>{
  const own=serve(t)
  const nd=project(),tree=treeOf(nd,[dog('fair_queue','sa','mail')])
  const view=await mountView(<CurrentOrg.Provider value={org}><AgentNavProvider>
    <OrgCanvas tree={tree} slug={org} op={op} toast={noop} mailEvt={null} /></AgentNavProvider></CurrentOrg.Provider>,el=>el)
  own(view)
  await inAct(async()=>{await flush(10)})
  const badge=view.el.querySelector<HTMLButtonElement>('.project-queue-badge')
  assert.ok(badge,'the queue badge is on the project node')
  await inAct(async()=>{badge!.click();await flush(8)})
  assert.equal(document.body.textContent?.includes('sync · events'),false,'the events window is not what it opens')
  assert.ok(document.querySelector('.mail-folders'),'the project mailbox opens')
  assert.deepEqual(folderOn(),['listeners'],'on its listeners folder')
})

test('with nobody listening, the badge opens the project mailbox at its inbox',async t=>{
  const own=serve(t)
  const nd=project(),tree=treeOf(nd,[])
  const view=await mountView(<CurrentOrg.Provider value={org}><AgentNavProvider>
    <OrgCanvas tree={tree} slug={org} op={op} toast={noop} mailEvt={null} /></AgentNavProvider></CurrentOrg.Provider>,el=>el)
  own(view)
  await inAct(async()=>{await flush(10)})
  const badge=view.el.querySelector<HTMLButtonElement>('.project-queue-badge')
  assert.ok(badge,'mail is waiting, so it badges')
  await inAct(async()=>{badge!.click();await flush(8)})
  assert.deepEqual(folderOn(),['inbox'])
})
