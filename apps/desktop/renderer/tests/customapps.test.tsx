import {flush,inAct,mountView} from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import {PanelHtml} from '../src/canvas/apps/host'
import {AppsButton,AppsWorkspace} from '../src/canvas/apps/ui'
import {PANEL_CSP,PANEL_PROTOCOL,panelDocument,panelRequest} from '../src/canvas/apps/sdk'
import type {CustomApp,CustomPanel} from '../src/canvas/apps/types'

const tick=async()=>{for(let i=0;i<4;i++)await flush()}
const app:CustomApp={id:'app1',name:'Counter',description:'Independent counters',rev:1,width:360,height:280,capabilities:[],permissions:{},created_by:'maker',updated_at:'2026-01-01',definition:{name:'Counter',description:'',html:'<button id="counter">Count</button>',initial_state:{count:2},capabilities:[],width:360,height:280}}
const make=(id:string,open=true):CustomPanel=>({id,app:'app1',label:id,open,rev:1,state:{count:4},event_seq:0,placement:{mode:'float',x:40,y:40,width:360,height:280},updated_at:'2026-01-01',used_at:id})
function server(slug:string,panels:CustomPanel[]){
  const calls:Record<string,unknown>[]=[],saved=new Map(panels.map(p=>[p.id,structuredClone(p)]));let next=10
  const original=globalThis.fetch
  globalThis.fetch=async(raw,init)=>{
    const url=new URL(String(raw),'http://local'),input=init?.method==='POST'?JSON.parse(String(init.body)):JSON.parse(url.searchParams.get('request')??'{}');calls.push(input)
    assert.equal(url.pathname,`/api/orgs/${slug}/apps`)
    let out:unknown
    if(input.action==='list')out={items:input.kind==='apps'?[app]:[...saved.values()].filter(p=>input.open===undefined||p.open===input.open).map(({state,...p})=>p),next_cursor:null}
    else if(input.action==='app_get')out=app
    else if(input.action==='panel_get')out=saved.get(input.panel)
    else if(input.action==='events')out={panel:input.panel,events:[],next_cursor:null,oldest_retained:null}
    else if(input.action==='panel_open'){
      let p=input.panel?saved.get(input.panel):!input.new?[...saved.values()].at(-1):undefined
      if(!p){p={...make('p'+next++),state:structuredClone(app.definition!.initial_state)};saved.set(p.id,p)}p.open=true;p.rev++;out=p
    }else if(input.action==='state_set'||input.action==='panel_update'){
      const p=saved.get(input.panel)!;if(input.expected_rev!==p.rev)return new Response('{"detail":"changed"}',{status:409,headers:{'Content-Type':'application/json'}})
      if(input.action==='state_set')p.state=input.state;else for(const name of ['label','open','placement'])if(name in input)(p as unknown as Record<string,unknown>)[name]=input[name]
      p.rev++;out=p
    }else throw Error('Unexpected '+JSON.stringify(input))
    return new Response(JSON.stringify(out),{status:200,headers:{'Content-Type':'application/json'}})
  }
  return{calls,saved,restore:()=>{globalThis.fetch=original}}
}

test('custom apps reject foreign frames, wrong channels, forged identity fields and network origins',()=>{
  const source={} as Window,other={} as Window,data={protocol:PANEL_PROTOCOL,channel:'nonce',id:'1',method:'state.get'}
  const event=(source:Window,origin='null',extra={})=>({source,origin,data:{...data,...extra}} as MessageEvent)
  assert.deepEqual(panelRequest(event(source),source,'nonce'),{id:'1',method:'state.get',args:undefined})
  assert.equal(panelRequest(event(other),source,'nonce'),null)
  assert.equal(panelRequest(event(source,'http://local'),source,'nonce'),null)
  assert.equal(panelRequest(event(source,'null',{channel:'other'}),source,'nonce'),null)
  assert.equal(panelRequest(event(source,'null',{as_user:true}),source,'nonce'),null)
  assert.equal(panelRequest(event(source,'null',{args:'x'.repeat(2*1024*1024+8192)}),source,'nonce'),null)
  const html=panelDocument('<script>window.agentMarkupRuns=true</script>','nonce')
  assert.ok(html.indexOf('Content-Security-Policy')<html.indexOf('window.agentMarkupRuns'))
  assert.match(PANEL_CSP,/connect-src 'none'/);assert.match(PANEL_CSP,/frame-src 'none'/);assert.match(PANEL_CSP,/form-action 'none'/)
})

test('custom apps host binds state writes to one panel and never forwards arbitrary engine actions',async t=>{
  Object.defineProperty(document,'hidden',{configurable:true,value:false});t.after(()=>{delete (document as unknown as Record<string,unknown>).hidden})
  const fixture=server('sdk-case',[make('p1'),make('p2')]);t.after(fixture.restore)
  const view=await mountView(<PanelHtml slug="sdk-case" app={app} panel={make('p1')}/>,el=>el);t.after(()=>view.unmount());await inAct(tick)
  const frame=view.el.querySelector('iframe')!;assert.ok(frame);assert.equal(frame.getAttribute('sandbox'),'allow-scripts');assert.equal(frame.getAttribute('referrerpolicy'),'no-referrer')
  const channel=JSON.parse(frame.srcdoc.match(/channel=("[^"]+")/)![1]!) as string
  const source=frame.contentWindow!,owner=frame.ownerDocument.defaultView!,answers:Record<string,unknown>[]=[]
  source.postMessage=value=>{answers.push(value as Record<string,unknown>)}
  await inAct(tick)
  const send=async(id:string,method:string,args?:unknown,from:Window=source)=>inAct(async()=>{const event=new owner.MessageEvent('message',{source:from,origin:'null',data:{protocol:PANEL_PROTOCOL,channel,id,method,args}});if(method==='host.ready')Object.defineProperty(event,'ports',{value:[{postMessage:(value:Record<string,unknown>)=>answers.push(value),close:()=>{}}]});owner.dispatchEvent(event);await tick()})
  await send('ready','host.ready');assert.ok(answers.some(a=>a.kind==='ready'),'frame handshake must work after document adoption even without a new load event')
  await send('save','state.set',{count:9})
  assert.equal(fixture.saved.get('p1')!.state!.count,9);assert.equal(fixture.saved.get('p2')!.state!.count,4)
  const write=fixture.calls.find(c=>c.action==='state_set')!;assert.equal(write.panel,'p1');assert.equal(write.expected_rev,1)
  await send('engine','engine.call',{action:'publish',as_user:true})
  assert.match(String(answers.find(a=>a.id==='engine')?.error),/Unsupported app action/)
  assert.equal(fixture.calls.some(c=>c.action==='publish'||c.action==='engine.call'),false)
  const other=frame.ownerDocument.createElement('iframe');frame.ownerDocument.body.appendChild(other)
  await send('foreign','state.set',{count:100},other.contentWindow!);other.remove()
  assert.equal(fixture.saved.get('p1')!.state!.count,9)
  assert.equal(answers.some(a=>a.id==='foreign'),false)
})

test('custom apps menu opens a fresh independent copy, exposes JSON state and closes without deleting',async t=>{
  const fixture=server('menu-case',[make('old',false)]);t.after(fixture.restore)
  const view=await mountView(<><AppsButton slug="menu-case"/><AppsWorkspace slug="menu-case"/></>,el=>el);t.after(()=>view.unmount());await inAct(tick)
  const owner=view.el.ownerDocument
  const press=async(label:string)=>{const button=[...owner.querySelectorAll<HTMLButtonElement>('button')].find(b=>b.textContent?.trim()===label||b.getAttribute('aria-label')===label);assert.ok(button,`missing ${label}`);await inAct(async()=>{button.click();await tick()})}
  await press('Apps');await press('New panel for Counter')
  const fresh=[...fixture.saved.values()].find(p=>p.id!=='old')!;assert.ok(fresh);assert.equal(fresh.state!.count,2);assert.equal(fixture.saved.get('old')!.state!.count,4)
  assert.ok(owner.querySelector(`[data-custom-panel="${fresh.id}"]`))
  await press('Settings for '+fresh.label);await press('State…');await inAct(tick)
  assert.equal(JSON.parse(owner.querySelector<HTMLTextAreaElement>('textarea[aria-label="Panel JSON state"]')!.value).count,2)
  await press('Cancel');await press('close this window');await press('Close '+fresh.label)
  assert.equal(fixture.saved.has(fresh.id),true);assert.equal(fixture.saved.get(fresh.id)!.open,false)
  assert.equal(owner.querySelector(`[data-custom-panel="${fresh.id}"]`),null)
})
