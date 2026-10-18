import test from 'node:test'
import assert from 'node:assert/strict'
import { FakeServer, flush, inAct, installFetch, mountView } from './harness'
import { CurrentOrg } from '../src/popout'
import { ProjectSlotsModal } from '../src/canvas/slotspanel'
import { forgetModalPins, forgetModalOpenCache, forgetSurfaceRequests, isModalPinned, readModalOpen, requestSurfaceAction } from '../src/canvas/modalpin'
import type { CanvasNode } from '../src/canvas/shared'
import type { TreePayload } from '../src/types'
const noop=()=>{}
const node=(count=1)=>({id:'build',kind:'project',tier:'project',state:'live',generation:7,children:[],
  scope:{tools:{},add_dirs:[]},configured_scope:{tools:{},add_dirs:[],slots_capacity:count}} as unknown as CanvasNode)
function reset(){installFetch(new FakeServer());localStorage.clear();forgetModalPins();forgetModalOpenCache();forgetSurfaceRequests()}

test('standalone slots reuses its live view, handles disabled capacity and closes itself',async t=>{
  reset();let reads=0,closed=0
  const render=(n:CanvasNode)=><CurrentOrg.Provider value="slot-host"><ProjectSlotsModal slug="slot-host" nid={n.id}
    tree={{roots:[n]} as TreePayload} map={new Map([[n.id,n]])} op={async()=>{reads++;return{holders:[],line:[],history:[]}}}
    toast={noop} close={()=>closed++}/></CurrentOrg.Provider>
  const v=await mountView(render(node()),el=>el);t.after(async()=>{await v.unmount();reset()})
  await inAct(()=>flush(3));assert.equal(reads,1)
  assert.deepEqual([...document.querySelectorAll('.project-slots h4')].map(e=>e.textContent),['Holding','Line','Recent holds'])
  assert.ok(document.querySelector('button[title="Open in new window"]'),'standard pop-out control')
  await v.render(render(node(0)));assert.match(document.body.textContent??'',/This project has no concurrency slots/)
  assert.equal(document.querySelector('.project-slots')===null,true);assert.equal(reads,1)
  await inAct(()=>[...document.querySelectorAll<HTMLButtonElement>('button')].find(e=>e.textContent==='Close')!.click())
  assert.equal(closed,1)
})

test('slots uses the standard org-scoped pin and remembers its project generation',async t=>{
  reset();const n=node()
  const content=<CurrentOrg.Provider value="slot-host"><ProjectSlotsModal slug="slot-host" nid={n.id}
    tree={{roots:[n]} as TreePayload} map={new Map([[n.id,n]])} op={async()=>({holders:[],line:[],history:[]})} toast={noop} close={noop}/></CurrentOrg.Provider>
  const v=await mountView(content,el=>el);t.after(async()=>{await v.unmount();reset()})
  await inAct(async()=>{requestSurfaceAction('project-slots','slot-host','pin');await flush(3)})
  assert.equal(isModalPinned('project-slots','slot-host'),true)
  assert.equal(isModalPinned('project-slots','other-org'),false)
  const restored=readModalOpen('slot-host').find(r=>r.kind==='project-slots')
  assert.deepEqual(restored?.restore,{agent:'build',generation:7})
  assert.ok(document.querySelector('.modalpin-win'),'uses the shared pinned frame')
})
