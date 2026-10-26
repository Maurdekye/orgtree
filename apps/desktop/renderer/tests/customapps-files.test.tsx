import {flush,inAct,mountView} from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import {AppActionClient} from '../src/canvas/apps/actions'
import {AppFileClient,type FilePrompt} from '../src/canvas/apps/files'
import {AppFilePermissionPrompt} from '../src/canvas/apps/files-ui'
import {panelDocument,PANEL_CSP} from '../src/canvas/apps/sdk'

const tick=async()=>{for(let i=0;i<4;i++)await flush()}
test('app files keep native paths and host tokens out of results and reject identity or grant injection',async t=>{
  const original=globalThis.fetch,calls:Record<string,unknown>[]=[];t.after(()=>{globalThis.fetch=original})
  globalThis.fetch=async(raw,init)=>{
    const input=JSON.parse(String(init?.body));calls.push(input)
    let out:unknown
    if(input.action==='session_open')out={session:'parent-only',app:'a',app_rev:2,expires_in:1800}
    else if(input.action==='session_close')out={closed:true}
    else if(input.action==='call')out=input.request.action==='media'?{id:'opaque',name:'test.mp4',media_path:'/api/orgs/demo/apps/media?ticket='+'a'.repeat(64)}:{permission_required:{app:'a',panel:'p',name:'Editor',label:'Cut',challenge:'once-only',capability:'files.read',request:input.request}}
    else if(input.action==='decide'){assert.equal(input.path,'C:/native-only/test.mp4');out={id:'opaque',name:'test.mp4',bytes:100}}
    else throw Error('unexpected')
    return new Response(JSON.stringify(out),{headers:{'Content-Type':'application/json'}})
  }
  const host=new AppActionClient('demo','a',2,'p',async()=>null);t.after(()=>host.dispose())
  const files=new AppFileClient('demo','a','p',host,async()=>({choice:'always',path:'C:/native-only/test.mp4'}))
  const picked=await files.call({action:'choose'});assert.deepEqual(picked,{id:'opaque',name:'test.mp4',bytes:100})
  const playback=await files.call({action:'media',file:'opaque'}) as {url:string}
  assert.equal(new URL(playback.url).pathname,'/api/orgs/demo/apps/media');assert(!JSON.stringify([picked,playback]).includes('parent-only'));assert(!JSON.stringify(picked).includes('C:/'))
  const before=calls.length
  for(const request of [{action:'choose',path:'C:/other'},{action:'read',file:'opaque',session:'stolen'},{action:'decide',choice:'always'},{action:'open',root:'scratch',path:'x',app:'other'},{action:'browse',path:'C:/'}])await assert.rejects(files.call(request),/Unsupported/)
  assert.equal(calls.length,before)
})

test('app file permission uses trusted shell picker and forwards only a native selection',async t=>{
  const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original})
  globalThis.fetch=async()=>new Response(JSON.stringify({path:'',parent:null,items:[{name:'Synthetic.mp4',path:'C:/synthetic/Synthetic.mp4',directory:false}],next_cursor:null}))
  let decision:unknown='pending'
  const prompt:FilePrompt={session:'native-only',request:{app:'a',panel:'p',name:'Caption editor',label:'First cut',capability:'files.read',challenge:'c',request:{action:'choose'}},finish:value=>{decision=value}}
  const view=await mountView(<AppFilePermissionPrompt slug="demo" prompt={prompt} owner={document} canSend/>,el=>el);t.after(()=>view.unmount());await inAct(tick)
  const dialog=document.querySelector('[aria-label="App file permission"]');assert(dialog)
  const buttons=()=>[...dialog.querySelectorAll<HTMLButtonElement>('button')]
  const always=buttons().find(b=>b.textContent==='Always allow')!;assert(always.disabled)
  // USER 2026-10-26: mail.send was removed, so a file prompt has no mail warning to give.
  assert.equal(/mail sending/.test(dialog.textContent!),false,'no mail warning')
  await inAct(async()=>{buttons().find(b=>b.textContent?.includes('Synthetic.mp4'))!.click();await tick()});assert(!always.disabled)
  await inAct(async()=>{always.click();await tick()});assert.deepEqual(decision,{choice:'always',path:'C:/synthetic/Synthetic.mp4'})
})

test('app media policy adds one host endpoint without opening connect or other API paths',()=>{
  const source=panelDocument('<video/>','channel','http://127.0.0.1:4999/api/orgs/demo/apps/media')
  assert(source.includes('media-src data: blob: http://127.0.0.1:4999/api/orgs/demo/apps/media;'));assert(source.includes("connect-src 'none'"));assert(PANEL_CSP.includes('media-src data: blob:;'))
  for(const endpoint of ['file:///C:/video.mp4','http://127.0.0.1:4999/api/orgs/demo/apps/bridge','http://x/api/orgs/demo/apps/media?ticket=x','http://x/api/orgs/demo/apps/media; connect-src *'])assert.throws(()=>panelDocument('','channel',endpoint))
})

test('write confirmations stay native, bind the exact host and expose only the outcome',async t=>{
  const original=globalThis.fetch,calls:Record<string,unknown>[]=[];t.after(()=>{globalThis.fetch=original})
  globalThis.fetch=async(_raw,init)=>{
    const input=JSON.parse(String(init?.body));calls.push(input)
    const out=input.action==='session_open'?{session:'host-only',app:'a',app_rev:2,expires_in:1800}:input.action==='session_close'?{closed:true}:input.action==='call'?{confirmation_required:{app:'a',panel:'p',name:'Editor',label:'Copy',challenge:'one-shot',capability:'files.write',request:{action:'write'},detail:{path:'C:/native-only/existing.txt',operation:'replace',previous_bytes:10,bytes:3,sha256:'a'.repeat(64)}}}:input.action==='confirm'?{changed:true,operation:'replace',bytes:3}:null
    return new Response(JSON.stringify(out))
  }
  const host=new AppActionClient('demo','a',2,'p',async()=>null);t.after(()=>host.dispose())
  let nativePath='';const files=new AppFileClient('demo','a','p',host,async request=>{nativePath=request.detail!.path;return{choice:'once'}})
  const result=await files.call({action:'write',directory:'opaque-dir',name:'existing.txt',base64:'bmV3',replace:true})
  assert.equal(nativePath,'C:/native-only/existing.txt');assert.deepEqual(result,{changed:true,operation:'replace',bytes:3})
  assert(!JSON.stringify(result).includes('native-only'));assert.deepEqual(calls.find(v=>v.action==='confirm'),{action:'confirm',app:'a',session:'host-only',challenge:'one-shot',allow:true})
  for(const request of [{action:'confirm',allow:true},{action:'grant',scope:'computer',mode:'write',path:'C:/'},{action:'write',directory:'x',name:'x',base64:'',permission:'allow'}])await assert.rejects(files.call(request),/Unsupported/)
})

test('native write prompt has exact change details and cannot grant permanent confirmation',async t=>{
  let decision:unknown=null
  const prompt:FilePrompt={session:'native-only',request:{app:'a',panel:'p',name:'Editor',label:'Copy',capability:'files.write',challenge:'change',request:{action:'delete'},detail:{path:'C:/synthetic/existing.txt',operation:'delete',previous_bytes:12,bytes:null,sha256:null}},finish:value=>{decision=value}}
  const view=await mountView(<AppFilePermissionPrompt slug="demo" prompt={prompt} owner={document} canSend={false}/>,el=>el);t.after(()=>view.unmount())
  const dialog=document.querySelector('[aria-label="App file permission"]')!;assert.match(dialog.textContent!,/C:\/synthetic\/existing.txt/);assert.match(dialog.textContent!,/two minutes/)
  const buttons=[...dialog.querySelectorAll('button')];assert(!buttons.some(b=>b.textContent==='Always allow'))
  await inAct(()=>{buttons.find(b=>b.textContent==='Confirm change')!.click()});assert.deepEqual(decision,{choice:'once'})
})

test('folder consent requires an explicit native selection and whole-computer warning is outside HTML',async t=>{
  const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original})
  globalThis.fetch=async()=>new Response(JSON.stringify({path:'C:/synthetic',parent:'C:/',items:[],next_cursor:null}))
  let decision:unknown=null;const prompt:FilePrompt={session:'native-only',request:{app:'a',panel:'p',name:'Editor',label:'Copy',capability:'files.write',challenge:'scope',request:{action:'grant',scope:'folder',mode:'write'}},finish:value=>{decision=value}}
  const view=await mountView(<AppFilePermissionPrompt slug="demo" prompt={prompt} owner={document} canSend/>,el=>el);t.after(()=>view.unmount());await inAct(tick)
  const buttons=()=>[...document.querySelectorAll<HTMLButtonElement>('[aria-label="App file permission"] button')];assert(buttons().find(b=>b.textContent==='Always allow')!.disabled)
  await inAct(()=>{buttons().find(b=>b.textContent==='Use this folder')!.click()});await inAct(()=>{buttons().find(b=>b.textContent==='Always allow')!.click()});assert.deepEqual(decision,{choice:'always',path:'C:/synthetic'})
})
