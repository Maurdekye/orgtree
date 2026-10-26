import {flush,inAct,mountView,StrictMode} from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import {PanelHtml} from '../src/canvas/apps/host'
import {AppsButton,AppsWorkspace} from '../src/canvas/apps/ui'
import {PANEL_PROTOCOL} from '../src/canvas/apps/sdk'
import type {CustomApp,CustomPanel} from '../src/canvas/apps/types'

const tick=async()=>{for(let i=0;i<5;i++)await flush()}
function fixture(slug:string){
  const app={id:'bridge-app',name:'Notes',description:'Send notes',rev:4,permission_rev:7,width:360,height:330,capabilities:['mail.send'],permissions:{},created_by:'maker',updated_at:'now',definition:{name:'Notes',description:'',html:'<button>Send</button>',initial_state:{},capabilities:['mail.send'],width:360,height:330}} as CustomApp
  const panel:CustomPanel={id:'bound-copy',app:app.id,label:'Private notes',open:true,rev:1,state:{},placement:{mode:'float',x:20,y:20,width:360,height:330},linked_agents:[],updated_at:'now',used_at:'now'}
  const original=globalThis.fetch,calls:Record<string,unknown>[]=[],token='parent-only-secret';let delayOpen:Promise<void>|undefined
  globalThis.fetch=async(raw,init)=>{
    const url=new URL(String(raw),'http://local'),input=init?.method==='POST'?JSON.parse(String(init.body)):JSON.parse(url.searchParams.get('request')??'{}');calls.push(input)
    let out:unknown
    if(url.pathname.endsWith('/apps/bridge')){
      if(input.action==='session_open'){await delayOpen;out={session:token,app:app.id,app_rev:app.rev,expires_in:1800}}
      else if(input.action==='session_close')out={closed:true}
      else if(input.action==='call'){assert.equal(input.session,token);out={permission_required:{challenge:'server-bound-action',app:app.id,panel:panel.id,name:app.name,label:panel.label,capability:'mail.send',request:input.request}}}
      else if(input.action==='decide')out={sent:['agent']}
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
  const c=await connect(view.el);await c.send('call','engine.call',{action:'mail.send',args:{to:'agent',body:'<b>Plain note</b>'}})
  const prompt=document.querySelector('[role="dialog"][aria-label="App permission"]');assert.ok(prompt,'the allowed action must reach a native permission prompt')
  assert.equal(prompt.ownerDocument,c.frame.ownerDocument);assert.ok(prompt.textContent?.includes('Private notes'));assert.ok(prompt.textContent?.includes('<b>Plain note</b>'));assert.equal(prompt.querySelector('b'),null,'request data must stay text')
  assert.deepEqual(f.calls.find(x=>x.action==='session_open'),{action:'session_open',panel:'bound-copy'})
  await press(document,'Allow once')
  assert.deepEqual(f.calls.find(x=>x.action==='decide'),{action:'decide',session:'parent-only-secret',challenge:'server-bound-action',choice:'once'})
  assert.deepEqual(c.answers.find(x=>x.id==='call')?.result,{sent:['agent']});assert.equal(JSON.stringify(c.answers).includes('parent-only-secret'),false)
  const before=f.calls.length
  for(const args of [{action:'permission_set',args:{}},{action:'publish',args:{}},{action:'mail.send',args:{to:'agent',body:'x',as_user:true}},{action:'mail.send',args:{to:'agent',body:'x'},panel:'elsewhere'}])await c.send('bad'+JSON.stringify(args),'engine.call',args)
  assert.equal(f.calls.length,before,'HTML must not select caller, panel, permissions or general operations')
})

test('cancelled and hidden app hosts discard prompts and close even a late session without deciding',async t=>{
  visible(t);const f=fixture('cancel-action');t.after(f.restore)
  const view=await mountView(<PanelHtml slug="cancel-action" app={f.app} panel={f.panel}/>,el=>el);t.after(()=>view.unmount())
  let c=await connect(view.el);await c.send('call','engine.call',{action:'mail.send',args:{to:'agent',body:'x'}})
  assert.ok(document.querySelector('[aria-label="App permission"]'))
  await inAct(async()=>{document.dispatchEvent(new window.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));await tick()})
  assert.equal(document.querySelector('[aria-label="App permission"]'),null);assert.ok(f.calls.some(x=>x.action==='session_close'));assert.equal(f.calls.some(x=>x.action==='decide'),false)
  let release!:()=>void;f.delayOpen(new Promise<void>(r=>{release=r}))
  await c.send('late','engine.call',{action:'mail.send',args:{to:'agent',body:'late'}})
  await view.render(<PanelHtml slug="cancel-action" app={f.app} panel={f.panel} visible={false}/>)
  await inAct(async()=>{release();await tick()})
  assert.equal(document.querySelector('[aria-label="App permission"]'),null);assert.equal(f.calls.filter(x=>x.action==='session_close').length,2);assert.equal(f.calls.filter(x=>x.action==='call').length,1)
})

test('native App permissions editor changes every-copy grant with a separate permission revision',async t=>{
  visible(t);const f=fixture('permission-editor');t.after(f.restore)
  const view=await mountView(<><AppsButton slug="permission-editor"/><AppsWorkspace slug="permission-editor"/></>,el=>el);t.after(()=>view.unmount());await inAct(tick)
  await press(document,'Apps');await inAct(async()=>{document.querySelector<HTMLButtonElement>('.custom-apps-menu-app [aria-label="Settings for Notes"]')!.click();await tick()});await press(document,'Permissions…')
  const select=document.querySelector<HTMLSelectElement>('select[aria-label="mail.send permission"]');assert.ok(select,'declared permissions must be editable in native UI')
  const frame=view.el.querySelector('iframe');assert.ok(frame)
  await inAct(async()=>{select.value='deny';select.dispatchEvent(new window.Event('change',{bubbles:true}));await tick()})
  assert.deepEqual(f.calls.find(x=>x.action==='permission_set'),{action:'permission_set',app:'bridge-app',expected_rev:4,expected_permission_rev:7,capability:'mail.send',permission:'deny'})
  assert.equal(view.el.querySelector('iframe'),frame,'a permission edit must not reload app code')
})
