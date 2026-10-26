import {flush,inAct,mountView} from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import {PanelHtml} from '../src/canvas/apps/host'
import {AppsButton,AppsWorkspace} from '../src/canvas/apps/ui'
import {PANEL_CSP,PANEL_PROTOCOL,panelRequest} from '../src/canvas/apps/sdk'
import type {CustomApp,CustomPanel} from '../src/canvas/apps/types'

const tick=async()=>{for(let i=0;i<5;i++)await flush()}
function fixture(t:test.TestContext,open=true,running=true){
 const app:CustomApp={id:'timer',name:'Timer',description:'Background timer',rev:1,permission_rev:1,width:360,height:280,capabilities:[],permissions:{},created_by:'maker',updated_at:'',definition:{name:'Timer',description:'',html:'<p>Timer runs</p>',initial_state:{},capabilities:[],width:360,height:280}}
 const panel={id:'clock',app:'timer',label:'Clock',rev:1,open,running,run_generation:1,state:{},event_seq:0,placement:{mode:'float',x:40,y:40,width:360,height:280},linked_agents:[],used_at:'',updated_at:''} as CustomPanel&{running:boolean;run_generation:number}
 const original=globalThis.fetch,calls:Record<string,any>[]=[]
 Object.defineProperty(document,'hidden',{configurable:true,value:false})
 globalThis.fetch=async(raw,init)=>{const url=new URL(String(raw),'http://local'),input=init?.method==='POST'?JSON.parse(String(init.body)):JSON.parse(url.searchParams.get('request')??'{}');calls.push(input);let out:unknown
  if(input.action==='list')out={items:input.kind==='apps'?[app]:[panel].filter(p=>(input.open===undefined||p.open===input.open)&&(input.running===undefined||p.running===input.running)),next_cursor:null,new_count:0}
  else if(input.action==='app_get')out=app
  else if(input.action==='panel_get')out=panel
  else if(input.action==='events')out={events:[],next_cursor:null}
  else if(input.action==='panel_update'){Object.assign(panel,input);panel.rev++;out=panel}
  else if(input.action==='panel_start'){panel.running=true;panel.rev++;out=panel}
  else if(input.action==='panel_stop'){panel.running=false;panel.open=false;panel.run_generation++;panel.rev++;out=panel}
  else if(input.action==='runtime')out={items:[],next_cursor:null}
  else if(input.action==='session_close')out={closed:true}
  else throw Error('Unexpected fixture operation '+input.action)
  return new Response(JSON.stringify(out),{headers:{'Content-Type':'application/json'}})
 };t.after(()=>{globalThis.fetch=original;delete (document as unknown as Record<string,unknown>).hidden})
 return{app,panel,calls}
}
async function workspace(t:test.TestContext,slug:string,open=true,running=true){const f=fixture(t,open,running),view=await mountView(<><AppsButton slug={slug}/><AppsWorkspace slug={slug}/></>,e=>e);t.after(()=>view.unmount());await inAct(tick);return{...f,view,menu:async()=>inAct(async()=>{view.el.querySelector<HTMLButtonElement>('.apps-button')!.click();await tick()})}}

test('hidden running host retains the same iframe rather than suspending its scripts',async t=>{
 const f=fixture(t),view=await mountView(<PanelHtml slug="keep-runtime" app={f.app} panel={f.panel}/>,e=>e);t.after(()=>view.unmount());await inAct(tick)
 const frame=view.el.querySelector('iframe');assert.ok(frame)
 await view.render(<PanelHtml slug="keep-runtime" app={f.app} panel={f.panel} visible={false}/>);await inAct(tick)
 assert.equal(view.el.querySelector('iframe')===frame,true,'Hide must keep the running browsing context')
})
test('a hidden owner document does not stop a running panel',async t=>{
 const f=fixture(t),view=await mountView(<PanelHtml slug="hidden-owner" app={f.app} panel={f.panel}/>,e=>e);t.after(()=>view.unmount());await inAct(tick);const frame=view.el.querySelector('iframe');assert.ok(frame)
 await inAct(async()=>{Object.defineProperty(document,'hidden',{configurable:true,value:true});document.dispatchEvent(new Event('visibilitychange'));await tick()})
 assert.equal(view.el.querySelector('iframe')===frame,true,'tray/hidden owner must retain execution')
})
test('panel header exposes distinct Hide and Power off; Hide preserves the frame',async t=>{
 const f=await workspace(t,'header-runtime'),hide=f.view.el.querySelector<HTMLButtonElement>('[aria-label="Hide Clock"]'),power=f.view.el.querySelector<HTMLButtonElement>('[aria-label="Power off Clock"]')
 assert.ok(hide,'header Hide control missing');assert.ok(power,'header Power off control missing');const frame=f.view.el.querySelector('iframe');assert.ok(frame)
 await inAct(async()=>{hide.click();await tick()});assert.equal(f.panel.open,false);assert.equal(f.panel.running,true);assert.equal(f.view.el.querySelector('iframe')===frame,true)
})
test('saved running-hidden panel is loaded and keeps HTML alive without exposing its visual',async t=>{
 const f=await workspace(t,'hidden-restoration',false,true)
 assert.equal(f.view.el.querySelectorAll('iframe').length,1,'running-hidden copies must be loaded without the menu')
 assert.equal(f.panel.open,false);assert.equal(f.panel.running,true)
})
test('visible implies running: a stale visible-but-off snapshot never exposes a panel',async t=>{
 const f=await workspace(t,'visible-invariant',true,false)
 assert.equal(f.view.el.querySelectorAll('[data-custom-panel="clock"]').length,0,'off snapshots cannot expose visible panel chrome')
})
test('Apps saved-panel context menu starts an off panel hidden and running rows offer Power off',async t=>{
 const f=await workspace(t,'row-runtime',false,false);await f.menu();const row=document.querySelector<HTMLElement>('.custom-apps-saved-row')!;assert.ok(row)
 await inAct(async()=>{row.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:40,clientY:50}));await tick()})
 const start=[...document.querySelectorAll<HTMLElement>('[role="menuitem"],button')].find(b=>b.textContent?.trim()==='Start running');assert.ok(start,'row context menu needs Start running')
 await inAct(async()=>{start.click();await tick()});assert.equal(f.panel.running,true);assert.equal(f.panel.open,false,'hidden Start must not reveal a window')
 const power=document.querySelector<HTMLButtonElement>('.custom-apps-saved-row [aria-label="Power off Clock"]');assert.ok(power,'running row Power off missing')
 await inAct(async()=>{power.click();await tick()});assert.equal(f.panel.running,false);assert.equal(f.panel.open,false)
})
test('panel CSP allows dedicated blob workers without allowing network or nested frames',()=>{
 assert.match(PANEL_CSP,/worker-src blob:/);assert.match(PANEL_CSP,/connect-src 'none'/);assert.match(PANEL_CSP,/frame-src 'none'/)
 assert.equal(/worker-src[^;]*(https?:|\*)/.test(PANEL_CSP),false)
})
test('background execution retains the existing exact-frame and opaque-origin bridge boundary',()=>{
 const source={} as Window,other={} as Window,message={protocol:PANEL_PROTOCOL,channel:'c',id:'1',method:'state.get'}
 const event=(win:Window,origin:string)=>({source:win,origin,data:message} as MessageEvent)
 assert.ok(panelRequest(event(source,'null'),source,'c'));assert.equal(panelRequest(event(other,'null'),source,'c'),null);assert.equal(panelRequest(event(source,'https://untrusted.invalid'),source,'c'),null)
})
