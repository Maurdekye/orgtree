import {flush,inAct,mountView,StrictMode} from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import {PanelHtml} from '../src/canvas/apps/host'
import {AppsButton,AppsWorkspace} from '../src/canvas/apps/ui'
import {PANEL_PROTOCOL} from '../src/canvas/apps/sdk'
import type {CustomApp,CustomPanel} from '../src/canvas/apps/types'

const tick=async()=>{for(let i=0;i<5;i++)await flush()}
function fixture(slug:string){
  const app={id:'bridge-app',name:'Notes',description:'Send notes',rev:4,permission_rev:7,width:360,height:330,capabilities:['docket.write'],permissions:{},created_by:'maker',updated_at:'now',definition:{name:'Notes',description:'',html:'<button>Send</button>',initial_state:{},capabilities:['docket.write'],width:360,height:330}} as CustomApp
  const panel:CustomPanel={id:'bound-copy',app:app.id,label:'Private notes',open:true,rev:1,state:{},placement:{mode:'float',x:20,y:20,width:360,height:330},updated_at:'now',used_at:'now'}
  const original=globalThis.fetch,calls:Record<string,unknown>[]=[],token='parent-only-secret';let delayOpen:Promise<void>|undefined
  globalThis.fetch=async(raw,init)=>{
    const url=new URL(String(raw),'http://local'),input=init?.method==='POST'?JSON.parse(String(init.body)):JSON.parse(url.searchParams.get('request')??'{}');calls.push(input)
    let out:unknown
    if(url.pathname.endsWith('/apps/bridge')){
      if(input.action==='session_open'){await delayOpen;out={session:token,app:app.id,app_rev:app.rev,expires_in:1800}}
      else if(input.action==='session_close')out={closed:true}
      else if(input.action==='call'){assert.equal(input.session,token);out={permission_required:{challenge:'server-bound-action',app:app.id,panel:panel.id,name:app.name,label:panel.label,capability:'docket.write',request:input.request}}}
      else if(input.action==='decide')out={item:'review-notes'}
      else throw Error('Unexpected bridge request')
    }else if(input.action==='app_get')out=app
    else if(input.action==='panel_get')out=panel
    else if(input.action==='events')out={events:[],next_cursor:null}
    else if(input.action==='list')out={items:input.kind==='apps'?[app]:[panel],next_cursor:null}
    else if(input.action==='permission_set'){assert.equal(input.expected_rev,4);assert.equal(input.expected_permission_rev,7);app.permissions={[String(input.capability)]:String(input.permission)};Object.assign(app,{permission_rev:8});out=app}
    else throw Error('Unexpected '+JSON.stringify(input))
    return new Response(JSON.stringify(out),{status:200,headers:{'Content-Type':'application/json'}})
  }
  return{app,panel,calls,delayOpen:(v:Promise<void>)=>{delayOpen=v},restore:()=>{globalThis.fetch=original}}
}
function visible(t:{after:(fn:()=>void)=>void}){Object.defineProperty(document,'hidden',{configurable:true,value:false});t.after(()=>{delete (document as unknown as Record<string,unknown>).hidden})}
async function connect(el:HTMLElement){
  await inAct(tick);const frame=el.querySelector('iframe')!;assert.ok(frame)
  const channel=JSON.parse(frame.srcdoc.match(/channel=("[^"]+")/)![1]!),win=frame.ownerDocument.defaultView!,answers:Record<string,unknown>[]=[]
  const send=async(id:string,method:string,args?:unknown)=>inAct(async()=>{const e=new win.MessageEvent('message',{source:frame.contentWindow,origin:'null',data:{protocol:PANEL_PROTOCOL,channel,id,method,args}});if(method==='host.ready')Object.defineProperty(e,'ports',{value:[{postMessage:(v:Record<string,unknown>)=>answers.push(v),close:()=>{}}]});win.dispatchEvent(e);await tick()})
  await send('ready','host.ready');return{answers,send,frame}
}
async function press(owner:Document,label:string){const button=[...owner.querySelectorAll<HTMLButtonElement>('button')].find(b=>b.textContent?.trim()===label||b.getAttribute('aria-label')===label);assert.ok(button,`Missing ${label}`);await inAct(async()=>{button.click();await tick()})}

test('app engine action uses a parent-only bound session and a native one-shot permission decision',async t=>{
  visible(t);const f=fixture('native-action');t.after(f.restore)
  const view=await mountView(<StrictMode><PanelHtml slug="native-action" app={f.app} panel={f.panel}/></StrictMode>,el=>el);t.after(()=>view.unmount())
  const c=await connect(view.el);await c.send('call','engine.call',{action:'docket.create',args:{title:'Review',objective:'<b>Plain note</b>',owner:'agent'}})
  const prompt=document.querySelector('[role="dialog"][aria-label="App permission"]');assert.ok(prompt,'the allowed action must reach a native permission prompt')
  assert.equal(prompt.ownerDocument,c.frame.ownerDocument);assert.ok(prompt.textContent?.includes('Private notes'));assert.ok(prompt.textContent?.includes('<b>Plain note</b>'));assert.equal(prompt.querySelector('b'),null,'request data must stay text')
  assert.deepEqual(f.calls.find(x=>x.action==='session_open'),{action:'session_open',panel:'bound-copy'})
  await press(document,'Allow once')
  assert.deepEqual(f.calls.find(x=>x.action==='decide'),{action:'decide',session:'parent-only-secret',challenge:'server-bound-action',choice:'once'})
  assert.deepEqual(c.answers.find(x=>x.id==='call')?.result,{item:'review-notes'});assert.equal(JSON.stringify(c.answers).includes('parent-only-secret'),false)
  const before=f.calls.length
  for(const args of [{action:'permission_set',args:{}},{action:'publish',args:{}},{action:'docket.create',args:{title:'x',objective:'x',owner:'agent',as_user:true}},{action:'docket.create',args:{title:'x',objective:'x',owner:'agent'},panel:'elsewhere'},{action:'mail.send',args:{to:'agent',body:'x'}}])await c.send('bad'+JSON.stringify(args),'engine.call',args)
  assert.equal(f.calls.length,before,'HTML must not select caller, panel, permissions or general operations, nor use the removed mail.send')
  assert.match(String(c.answers.find(x=>x.id==='bad'+JSON.stringify({action:'mail.send',args:{to:'agent',body:'x'}}))?.error),/only through events/)
})

// USER 2026-10-26: hiding keeps a panel running. A hidden panel never opens a
// native prompt: it is refused (interaction_required) and its challenge closed.
test('cancelled prompts and hidden running hosts discard prompts without deciding',async t=>{
  visible(t);const f=fixture('cancel-action');t.after(f.restore)
  const view=await mountView(<PanelHtml slug="cancel-action" app={f.app} panel={f.panel}/>,el=>el);t.after(()=>view.unmount())
  const c=await connect(view.el);await c.send('call','engine.call',{action:'docket.create',args:{title:'x',objective:'x',owner:'agent'}})
  assert.ok(document.querySelector('[aria-label="App permission"]'))
  await inAct(async()=>{document.dispatchEvent(new window.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));await tick()})
  assert.equal(document.querySelector('[aria-label="App permission"]'),null);assert.ok(f.calls.some(x=>x.action==='session_close'));assert.equal(f.calls.some(x=>x.action==='decide'),false)
  await c.send('shown','engine.call',{action:'docket.create',args:{title:'x',objective:'while shown',owner:'agent'}})
  assert.ok(document.querySelector('[aria-label="App permission"]'),'a visible panel still asks')
  await view.render(<PanelHtml slug="cancel-action" app={f.app} panel={f.panel} visible={false}/>);await inAct(tick)
  assert.equal(document.querySelector('[aria-label="App permission"]')===null,true,'hiding refuses the open prompt')
  assert.match(String(c.answers.find(x=>x.id==='shown')?.error),/interaction_required/)
  await c.send('hidden','engine.call',{action:'docket.create',args:{title:'x',objective:'while hidden',owner:'agent'}})
  assert.equal(document.querySelector('[aria-label="App permission"]')===null,true,'a hidden panel never opens a prompt')
  assert.match(String(c.answers.find(x=>x.id==='hidden')?.error),/interaction_required/)
  assert.equal(f.calls.some(x=>x.action==='decide'),false);assert.equal(c.frame.isConnected,true,'the hidden runtime keeps its frame')
  assert.equal(f.calls.filter(x=>x.action==='session_close').length,3,'each refused or cancelled challenge closes its session')
})

test('a removed (powered off) host closes even a late session without calling',async t=>{
  visible(t);const f=fixture('late-session');t.after(f.restore)
  const view=await mountView(<PanelHtml slug="late-session" app={f.app} panel={f.panel}/>,el=>el)
  const c=await connect(view.el)
  let release!:()=>void;f.delayOpen(new Promise<void>(r=>{release=r}))
  await c.send('late','engine.call',{action:'docket.create',args:{title:'x',objective:'late',owner:'agent'}})
  await inAct(async()=>{view.unmount();await tick()})
  await inAct(async()=>{release();await tick()})
  assert.equal(f.calls.filter(x=>x.action==='session_close').length,1);assert.equal(f.calls.filter(x=>x.action==='call').length,0)
})

test('native App permissions editor changes every-copy grant with a separate permission revision',async t=>{
  visible(t);const f=fixture('permission-editor');t.after(f.restore)
  const view=await mountView(<><AppsButton slug="permission-editor"/><AppsWorkspace slug="permission-editor"/></>,el=>el);t.after(()=>view.unmount());await inAct(tick)
  await press(document,'Apps');await inAct(async()=>{document.querySelector<HTMLButtonElement>('.custom-apps-menu-app [aria-label="Settings for Notes"]')!.click();await tick()});await press(document,'Permissions')
  const select=document.querySelector<HTMLSelectElement>('select[aria-label="docket.write permission"]');assert.ok(select,'declared permissions must be editable in native UI')
  const frame=view.el.querySelector('iframe');assert.ok(frame)
  await inAct(async()=>{select.value='deny';select.dispatchEvent(new window.Event('change',{bubbles:true}));await tick()})
  assert.deepEqual(f.calls.find(x=>x.action==='permission_set'),{action:'permission_set',app:'bridge-app',expected_rev:4,expected_permission_rev:7,capability:'docket.write',permission:'deny'})
  assert.equal(view.el.querySelector('iframe'),frame,'a permission edit must not reload app code')
})
