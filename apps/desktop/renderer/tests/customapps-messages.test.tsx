import {flush,inAct,mountView} from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import {PanelHtml} from '../src/canvas/apps/host'
import {PANEL_PROTOCOL} from '../src/canvas/apps/sdk'
import type {CustomApp,CustomPanel} from '../src/canvas/apps/types'

// User 2026-10-26 md6edfebc1975: History holds only fired events agents can
// listen to and the copy starting and stopping. mcbcd7b3cb6c0 "Keep, separate":
// agent-to-app messages (orgtree_apps event, orgtree.emit) keep reaching
// orgtree.on, read from their own listing rather than from History.
const tick=async()=>{for(let i=0;i<4;i++)await flush()}
const app:CustomApp={id:'app1',name:'Counter',description:'',rev:1,width:360,height:280,capabilities:[],permissions:{},created_by:'maker',updated_at:'2026-01-01',definition:{name:'Counter',description:'',html:'<p>counter</p>',initial_state:{},capabilities:[],width:360,height:280}}
const copy=(event_seq:number):CustomPanel=>({id:'p1',app:'app1',label:'p1',open:true,running:true,rev:1,state:{},event_seq,placement:{mode:'float',x:40,y:40,width:360,height:280},updated_at:'2026-01-01',used_at:'2026-01-01'})

test('a running panel receives new agent and app messages from their own listing, never History rows',async t=>{
  Object.defineProperty(document,'hidden',{configurable:true,value:false});t.after(()=>{delete (document as unknown as Record<string,unknown>).hidden})
  let saved=copy(4)
  const calls:Record<string,any>[]=[],original=globalThis.fetch
  globalThis.fetch=async(raw,init)=>{
    const url=new URL(String(raw),'http://local'),input=init?.method==='POST'?JSON.parse(String(init.body)):JSON.parse(url.searchParams.get('request')??'{}');calls.push(input)
    if(url.pathname.endsWith('/apps/runtime'))return new Response(JSON.stringify({lease_ms:20000,stop:[],sample_epoch:0}),{headers:{'Content-Type':'application/json'}})
    let out:unknown
    if(input.action==='app_get')out=app
    else if(input.action==='panel_get')out=saved
    // A message (seq 5) and a History row (seq 6) arrived since the host mounted at seq 4.
    else if(input.action==='events')out=input.messages===true
      ?{panel:'p1',events:[{seq:5,name:'ping',payload:{n:1},actor:'worker',at:'2026-10-26T10:00:00Z'}].filter(e=>e.seq>(input.after??0)),next_cursor:null,oldest_retained:5}
      :{panel:'p1',events:[{seq:6,name:'panel.started',payload:{reason:'opened'},actor:'user',at:'2026-10-26T10:00:01Z'}].filter(e=>e.seq>(input.after??0)),next_cursor:null,oldest_retained:6}
    else throw Error('Unexpected '+JSON.stringify(input))
    return new Response(JSON.stringify(out),{headers:{'Content-Type':'application/json'}})
  };t.after(()=>{globalThis.fetch=original})
  const view=await mountView(<PanelHtml slug="messages-case" app={app} panel={saved}/>,el=>el);t.after(()=>view.unmount());await inAct(tick)
  const frame=view.el.querySelector('iframe')!;assert.ok(frame)
  const channel=JSON.parse(frame.srcdoc.match(/channel=("[^"]+")/)![1]!) as string
  const source=frame.contentWindow!,owner=frame.ownerDocument.defaultView!,answers:Record<string,unknown>[]=[]
  source.postMessage=value=>{answers.push(value as Record<string,unknown>)}
  await inAct(async()=>{const event=new owner.MessageEvent('message',{source,origin:'null',data:{protocol:PANEL_PROTOCOL,channel,id:'ready',method:'host.ready'}});Object.defineProperty(event,'ports',{value:[{postMessage:(value:Record<string,unknown>)=>answers.push(value),close:()=>{}}]});owner.dispatchEvent(event);await tick()})
  assert.ok(answers.some(a=>a.kind==='ready'),'the frame handshake completes')
  saved=copy(6)
  await inAct(async()=>{await view.render(<PanelHtml slug="messages-case" app={app} panel={saved}/>);await tick()})
  const delivered=answers.filter(a=>a.kind==='event'&&a.name!=='state.changed').map(({kind,name,payload})=>({kind,name,payload}))
  assert.deepEqual(delivered,[{kind:'event',name:'ping',payload:{n:1}}],'the new message reaches orgtree.on, and no History row does')
  const reads=calls.filter(c=>c.action==='events')
  assert.ok(reads.length>0&&reads.every(c=>c.messages===true&&c.after===4),'the host reads only the message listing, from where it mounted')
})
