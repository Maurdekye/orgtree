import {flush,inAct,mountView} from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import path from 'node:path'
import {AppsButton,AppsWorkspace} from '../src/canvas/apps/ui'
import {invalidateCustomApps} from '../src/canvas/apps/store'
import {PANEL_MOTION_MS} from '../src/canvas/apps/motion'
import {PANEL_PROTOCOL} from '../src/canvas/apps/sdk'
import type {CustomApp,CustomPanel} from '../src/canvas/apps/types'

// USER 2026-10-27 m056a5c0bde3c: "add an accompanying quick animation associated
// with starting / stopping a panel, to differrntiate from just flosing or opening
// the visible panel. a rapid zoom in / out". Starting a visible panel zooms it in,
// powering a visible panel off zooms it out; Hide and show stay instant.
declare const __SRC_DIR__: string
const tick=async()=>{for(let i=0;i<5;i++)await flush()}
// Longer than the zoom (about 180 ms) and the cleanup after it.
const wait=(ms=450)=>inAct(async()=>{await new Promise(r=>setTimeout(r,ms));await tick()})
type Panel=CustomPanel&{running:boolean;run_generation:number}
const copy=(id:string,label:string,open=true,running=true):Panel=>({id,app:'timer',label,rev:1,open,running,run_generation:1,state:{},event_seq:0,placement:{mode:'float',x:40,y:40,width:360,height:280},created_at:'2026-10-27T07:00:00Z',used_at:'',updated_at:''})
function fixture(t:test.TestContext,panels:Panel[]){
  const app:CustomApp={id:'timer',name:'Timer',description:'Background timer',rev:1,permission_rev:1,width:360,height:280,capabilities:[],permissions:{},created_by:'maker',updated_at:'',definition:{name:'Timer',description:'',html:'<p>Timer runs</p>',initial_state:{},capabilities:[],width:360,height:280}}
  const original=globalThis.fetch,calls:Record<string,any>[]=[],runtime:Record<string,any>[]=[]
  Object.defineProperty(document,'hidden',{configurable:true,value:false})
  const find=(id:unknown)=>{const p=panels.find(p=>p.id===id);if(!p)throw Error('Unknown panel '+String(id));return p}
  globalThis.fetch=async(raw,init)=>{const url=new URL(String(raw),'http://local'),input=init?.method==='POST'?JSON.parse(String(init.body)):JSON.parse(url.searchParams.get('request')??'{}');let out:unknown
    if(url.pathname.endsWith('/apps/runtime')){runtime.push(input);out=input.action==='heartbeat'?{stop:[],sample_epoch:0}:{}}
    else if(url.pathname.endsWith('/apps/bridge'))out={closed:true}
    else{calls.push(input)
      if(input.action==='list')out={items:input.kind==='apps'?[app]:panels.filter(p=>(input.open===undefined||p.open===input.open)&&(input.running===undefined||p.running===input.running)),next_cursor:null,new_count:0}
      else if(input.action==='app_get')out=app
      else if(input.action==='panel_get')out=find(input.panel)
      else if(input.action==='events')out={events:[],next_cursor:null,oldest_retained:null}
      // Like the engine: opening a stopped copy starts it (a new run generation).
      else if(input.action==='panel_open'){const p=find(input.panel);if(!p.running)p.run_generation++;p.open=true;p.running=true;p.rev++;out=p}
      else if(input.action==='panel_update'){const p=find(input.panel);for(const k of ['open','placement'])if(k in input)(p as unknown as Record<string,unknown>)[k]=input[k];p.rev++;out=p}
      else if(input.action==='panel_start'){const p=find(input.panel);p.running=true;p.rev++;out=p}
      else if(input.action==='panel_stop'){const p=find(input.panel);p.running=false;p.open=false;p.run_generation++;p.rev++;out=p}
      else throw Error('Unexpected fixture operation '+input.action)}
    return new Response(JSON.stringify(out),{headers:{'Content-Type':'application/json'}})
  };t.after(()=>{globalThis.fetch=original;delete (document as unknown as Record<string,unknown>).hidden})
  return{app,calls,runtime}
}
async function workspace(t:test.TestContext,slug:string,panels:Panel[]){
  const f=fixture(t,panels),view=await mountView(<><AppsButton slug={slug}/><AppsWorkspace slug={slug}/></>,e=>e);t.after(()=>view.unmount());await inAct(tick)
  return{...f,view,menu:async()=>inAct(async()=>{view.el.querySelector<HTMLButtonElement>('.apps-button')!.click();await tick()})}
}
const win=(id:string)=>document.querySelector<HTMLElement>(`section[data-custom-panel="${id}"]`)
const click=async(button:HTMLElement|null|undefined,what:string)=>{assert.ok(button,what+' is missing');await inAct(async()=>{button.click();await tick()})}
const savedRow=(label:string)=>[...document.querySelectorAll<HTMLButtonElement>('.custom-apps-saved')].find(b=>b.getAttribute('aria-label')?.startsWith(label+','))
/** host.ready from the panel's own frame, as the bridge tests do; answers collect the replies. */
async function connect(section:HTMLElement){
  const frame=section.querySelector('iframe')!;assert.ok(frame,'the running panel has its frame')
  const channel=JSON.parse(frame.srcdoc.match(/channel=("[^"]+")/)![1]!),owner=frame.ownerDocument.defaultView!,answers:Record<string,unknown>[]=[]
  const send=async(id:string,method:string)=>inAct(async()=>{const e=new owner.MessageEvent('message',{source:frame.contentWindow,origin:'null',data:{protocol:PANEL_PROTOCOL,channel,id,method}});if(method==='host.ready')Object.defineProperty(e,'ports',{value:[{postMessage:(v:Record<string,unknown>)=>answers.push(v),close:()=>{}}]});owner.dispatchEvent(e);await tick()})
  await send('ready','host.ready');return{answers,send,frame}
}

test('opening a stopped panel zooms it in once, with its backdrop',async t=>{
  await workspace(t,'motion-start',[copy('clock','Clock',false,false)])
  assert.equal(win('clock'),null,'an off panel shows nothing')
  await inAct(async()=>{document.querySelector<HTMLButtonElement>('.apps-button')!.click();await tick()})
  await click(savedRow('Clock'),'the saved row of the off panel')
  const section=win('clock');assert.ok(section,'opening a stopped panel shows it')
  assert.equal(section.dataset.motion,'start','starting a visible panel plays the zoom-in')
  assert.equal(section.closest('.custom-app-centered')?.getAttribute('data-motion'),'start','the centred backdrop fades in with it')
  await wait()
  assert.equal(win('clock')===section,true,'the window stays the same element')
  assert.equal(section.dataset.motion,undefined,'the marker clears, so a later pin or pop-out cannot replay the zoom')
})

test('Power off zooms a visible panel out in place, already stopped',async t=>{
  const f=await workspace(t,'motion-stop',[copy('clock','Clock')])
  const section=win('clock');assert.ok(section,'the running panel shows')
  assert.equal(section.dataset.motion,undefined,'a panel restored at load does not zoom')
  const c=await connect(section),frame=c.frame;assert.equal(c.answers.some(a=>a.kind==='ready'),true,'the bridge is connected first')
  await click(section.querySelector<HTMLButtonElement>('[aria-label="Power off Clock"]'),'the header Power off')
  assert.equal(win('clock')===section,true,'the powered-off window stays for its zoom-out')
  assert.equal(section.dataset.motion,'stop','powering off a visible panel plays the zoom-out')
  assert.equal(section.closest('.custom-app-centered')?.getAttribute('data-motion'),'stop','the centred backdrop fades out with it')
  assert.equal(section.hasAttribute('inert'),true,'a leaving window takes no input')
  assert.equal(section.querySelector('iframe')===frame,true,'it keeps its last picture: no reload')
  assert.equal(f.runtime.some(r=>r.action==='release'&&r.panels?.includes('clock')),true,'the host lease ends at once')
  await c.send('late','state.get')
  assert.equal(c.answers.some(a=>a.id==='late'),false,'a stopped panel reaches nothing while it zooms out')
  await wait()
  assert.equal(win('clock'),null,'then the window is gone')
})

test('a visible panel stopped elsewhere (Stop all, an agent) zooms out too',async t=>{
  const panels=[copy('clock','Clock')];await workspace(t,'motion-elsewhere',panels)
  const section=win('clock');assert.ok(section)
  // The engine stopped it; the next listing no longer has it running.
  Object.assign(panels[0]!,{running:false,open:false,rev:2,run_generation:2})
  await inAct(async()=>{invalidateCustomApps('motion-elsewhere');await tick()})
  assert.equal(win('clock')===section,true,'the window stays for its zoom-out')
  assert.equal(section.dataset.motion,'stop')
  await wait()
  assert.equal(win('clock'),null)
})

test('a leaving panel keeps its place, so the panels after it neither move nor reload',async t=>{
  await workspace(t,'motion-order',[copy('one','One'),copy('two','Two')])
  const one=win('one'),two=win('two');assert.ok(one&&two)
  assert.equal(Boolean(one.compareDocumentPosition(two)&Node.DOCUMENT_POSITION_FOLLOWING),true,'One renders before Two')
  const frame=two.querySelector('iframe');assert.ok(frame)
  await click(one.querySelector<HTMLButtonElement>('[aria-label="Power off One"]'),'One\'s Power off')
  assert.equal(win('one')===one,true,'One zooms out');assert.equal(one.dataset.motion,'stop')
  assert.equal(Boolean(one.compareDocumentPosition(two)&Node.DOCUMENT_POSITION_FOLLOWING),true,'One keeps its place before Two')
  assert.equal(two.querySelector('iframe')===frame,true,'Two keeps its frame')
  await wait()
  assert.equal(win('one'),null);assert.equal(win('two')===two,true);assert.equal(two.querySelector('iframe')===frame,true,'Two never reloaded')
  assert.equal(two.dataset.motion,undefined,'Two never animated')
})

test('Hide and show stay instant; hidden starts and stops play nothing',async t=>{
  await workspace(t,'motion-hide',[copy('clock','Clock')])
  const section=win('clock');assert.ok(section)
  await click(section.querySelector<HTMLButtonElement>('[aria-label="Hide Clock"]'),'the header Hide')
  assert.equal(section.dataset.parked,'true','Hide parks the window at once');assert.equal(section.dataset.motion,undefined,'Hide does not zoom')
  await inAct(async()=>{document.querySelector<HTMLButtonElement>('.apps-button')!.click();await tick()})
  await click(savedRow('Clock'),'the saved row of the hidden panel')
  assert.equal(win('clock')===section,true,'showing reuses the running window');assert.equal(section.dataset.parked,undefined,'it shows at once')
  assert.equal(section.dataset.motion,undefined,'showing a running panel does not zoom')
  await click(section.querySelector<HTMLButtonElement>('[aria-label="Hide Clock"]'),'the header Hide')
  await inAct(async()=>{document.querySelector<HTMLButtonElement>('.apps-button')!.click();await tick()})
  await click(document.querySelector<HTMLButtonElement>('.custom-apps-saved-row [aria-label="Power off Clock"]'),'the row Power off')
  assert.equal(win('clock'),null,'powering off a hidden panel removes it at once: nothing was visible')
  const row=document.querySelector<HTMLElement>('.custom-apps-saved-row');assert.ok(row)
  await inAct(async()=>{row.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:40,clientY:50}));await tick()})
  await click([...document.querySelectorAll<HTMLElement>('[role="menuitem"],button')].find(b=>b.textContent?.trim()==='Start running'),'Start running')
  const hidden=win('clock');assert.ok(hidden,'Start running hosts the panel hidden')
  assert.equal(hidden.dataset.parked,'true');assert.equal(hidden.dataset.motion,undefined,'a hidden start does not zoom')
})

test('reduced motion keeps a fade and drops the zoom',()=>{
  const css=readFileSync(path.join(__SRC_DIR__,'canvas','apps','apps.css'),'utf8').replace(/\/\*[\s\S]*?\*\//g,'')
  const reduced=css.match(/@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{([\s\S]*?\})\s*\}/g)?.join('\n')??''
  const names=(rule:string)=>[...css.matchAll(new RegExp(rule+'[^{]*\\{[^}]*animation(?:-name)?:\\s*([\\w-]+)','g'))].map(m=>m[1]!)
  const zoom=names('\\.custom-app-window\\[data-motion="(?:start|stop)"\\]')
  assert.ok(zoom.length>=2,'start and stop each name an animation')
  const keyframes=(name:string)=>css.match(new RegExp('@keyframes\\s+'+name+'\\s*\\{([\\s\\S]*?\\})\\s*\\}'))?.[1]??''
  assert.ok(zoom.some(n=>/\bscale\b/.test(keyframes(n))),'the ordinary start/stop animation zooms')
  const calm=[...reduced.matchAll(/data-motion="(?:start|stop)"\][^{]*\{[^}]*animation(?:-name)?:\s*([\w-]+)/g)].map(m=>m[1]!)
  assert.ok(calm.length>=2,'reduced motion overrides both')
  for(const n of calm){assert.equal(/\b(scale|transform|translate)\b/.test(keyframes(n)),false,n+' must not move or zoom');assert.match(keyframes(n),/opacity/,n+' fades')}
})

test('a panel started again during its zoom-out zooms back in and takes input',async t=>{
  const f=await workspace(t,'motion-restart',[copy('clock','Clock')])
  const section=win('clock');assert.ok(section)
  await click(section.querySelector<HTMLButtonElement>('[aria-label="Power off Clock"]'),'the header Power off')
  assert.equal(section.dataset.motion,'stop')
  await f.menu()
  await click(savedRow('Clock'),'the saved row of the stopping panel')
  assert.equal(win('clock')===section,true,'the same window carries on')
  assert.equal(section.dataset.motion,'start','starting it again zooms it back in')
  assert.equal(section.hasAttribute('inert'),false,'it takes input again')
  await wait()
  assert.equal(win('clock')===section,true,'it stays');assert.equal(section.dataset.motion,undefined)
})

test('the zoom in apps.css lasts PANEL_MOTION_MS, the time a leaving window is kept for',()=>{
  const css=readFileSync(path.join(__SRC_DIR__,'canvas','apps','apps.css'),'utf8').replace(/\/\*[\s\S]*?\*\//g,'')
  for(const sel of ['.custom-app-window[data-motion="start"]','.custom-app-window[data-motion="stop"]','.custom-app-centered[data-motion="start"]','.custom-app-centered[data-motion="stop"]']){
    const rule=css.match(new RegExp(sel.replace(/[.[\]"=]/g,'\\$&')+'\\s*\\{[^}]*animation:\\s*[\\w-]+\\s+(\\d+)ms'))
    assert.equal(Number(rule?.[1]),PANEL_MOTION_MS,sel)
  }
})
