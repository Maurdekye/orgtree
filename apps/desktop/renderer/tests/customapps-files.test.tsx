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
  const always=buttons().find(b=>b.textContent==='Always allow')!;assert(always.disabled);assert.match(dialog.textContent!,/mail sending/)
  await inAct(async()=>{buttons().find(b=>b.textContent?.includes('Synthetic.mp4'))!.click();await tick()});assert(!always.disabled)
  await inAct(async()=>{always.click();await tick()});assert.deepEqual(decision,{choice:'always',path:'C:/synthetic/Synthetic.mp4'})
})

test('app media policy adds one host endpoint without opening connect or other API paths',()=>{
  const source=panelDocument('<video/>','channel','http://127.0.0.1:4999/api/orgs/demo/apps/media')
  assert(source.includes('media-src data: blob: http://127.0.0.1:4999/api/orgs/demo/apps/media;'));assert(source.includes("connect-src 'none'"));assert(PANEL_CSP.includes('media-src data: blob:;'))
  for(const endpoint of ['file:///C:/video.mp4','http://127.0.0.1:4999/api/orgs/demo/apps/bridge','http://x/api/orgs/demo/apps/media?ticket=x','http://x/api/orgs/demo/apps/media; connect-src *'])assert.throws(()=>panelDocument('','channel',endpoint))
})
