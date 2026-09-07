import { flush, inAct, mountView, realClock, useFakeClock } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { DocGalleryModal } from '../src/canvas/gallery'
import { InboxPanel } from '../src/App'
import { BASE } from '../src/api'
import { addPending, resetConvos, useConvo } from '../src/convo'
import type { Convo } from '../src/convo'
import type { TreePayload } from '../src/types'
declare const __SRC_DIR__: string
const fixture=(variant:string)=>JSON.parse(readFileSync(path.resolve(__SRC_DIR__,'../tests/fixtures/events',variant+'.json'),'utf8'))
const noop=()=>{}

export function replyCases(profile:'operator'|'public') {
  for(const surface of ['document','mail'] as const) test(profile+' '+surface+' sends identity, retains failed draft, and binds its own accepted ghost',async t=>{
    assert.equal(BASE,profile==='public'?'/k/visitor':'','positive control: API profile')
    useFakeClock();resetConvos()
    let fail=true, snapshot:Convo|null=null
    const requests:{url:string,body:unknown}[]=[], notices:string[][]=[]
    const target=surface==='mail'?{kind:'mail',org:'mine',box:'user',id:'m1'}:{kind:'document',org:'mine',id:'d1'}
    const item={id:'d1',node:'alpha',title:'Client title must not be sent',at:'2026-09-06T12:00:00Z',node_state:'live',evicted:false}
    const mail={id:'m1',from:'alpha',kind:'message',at:'2026-09-06T12:00:00Z',body:'Client quote must not be sent'}
    const f=fixture('reply.'+surface)
    const event={...f[profile==='public'?'public':'private'],actor:{kind:'user',id:'user'},body:'Same draft'}
    globalThis.fetch=(async (input,init)=>{
      const url=String(input), method=init?.method??'GET'
      const response=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}})
      if(method==='POST'&&url.endsWith('/nodes/alpha/message')) {
        requests.push({url,body:JSON.parse(String(init?.body))})
        return fail?response({detail:'target no longer exists'},422):response({id:'accepted-id',ref:'@mail:mine/node/alpha/accepted-id',deferred:true,...(profile==='public'?{ev_public:event}:{ev:event})})
      }
      if(url.endsWith('/documents'))return response({documents:[item]})
      if(url.endsWith('/documents/d1'))return response({...item,body:'Document body'})
      if(url.endsWith('/inbox'))return response({pending:[],delivered:[mail],sent:[]})
      return response({})
    }) as typeof fetch
    function Probe(){snapshot=useConvo('mine','alpha');return null}
    const tree={slug:'mine',roots:[],audiences:[],credit_requests:[],asks:[],tiers:{},fable_lock:null} as unknown as TreePayload
    const view=await mountView(<><Probe/>{surface==='document'
      ?<DocGalleryModal slug="mine" toast={v=>notices.push(v)} close={noop}/>
      :<InboxPanel slug="mine" tree={tree} toast={v=>notices.push(v)} close={noop} jumpTo={null}/>}</>,h=>h)
    t.after(async()=>{await view.unmount();resetConvos();realClock()})
    await flush();await inAct(()=>{(view.el.querySelector('.mailrow') as HTMLElement).click()});await flush()
    const textarea=view.el.querySelector('.mail-reply textarea') as HTMLTextAreaElement
    assert.ok(textarea,'real reply composer rendered')
    let earlier=0
    await inAct(()=>{
      earlier=addPending('mine','alpha','Same draft')
      Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value')!.set!.call(textarea,'Same draft')
      textarea.dispatchEvent(new Event('input',{bubbles:true}))
    });await flush()
    const send=view.el.querySelector('.mail-reply button') as HTMLButtonElement
    await inAct(()=>send.click());await flush()
    assert.deepEqual(requests[0].body,{text:'Same draft',target},'no client title/sender/gist/at or legacy reply_to')
    assert.equal(textarea.value,'Same draft','refusal preserves the draft')
    assert.deepEqual(snapshot!.pending.map(g=>g.id),[earlier],'refusal removed only its own identical-text ghost')
    assert.match(notices.flat().join(' '),/target no longer exists/)
    fail=false;await inAct(()=>send.click());await flush()
    assert.equal(textarea.value,'','accepted reply clears draft')
    assert.deepEqual(snapshot!.pending.map(g=>g.mailId),[undefined,'accepted-id'],'deferred typed response still binds durable identity')
    assert.equal(requests.length,2,'positive control: refusal followed by accepted retry')
  })
}
