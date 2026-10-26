import test from 'node:test'
import assert from 'node:assert/strict'
import {flush,inAct,mountView} from './harness'
import {AppsButton,AppsWorkspace} from '../src/canvas/apps/ui'
import {APP_BUNDLE_MAX,parseAppBundle,saveAppJson} from '../src/canvas/apps/portable'
import type {CustomApp} from '../src/canvas/apps/types'

const tick=async()=>{for(let i=0;i<4;i++)await flush()}
const bundle={format:'orgtree-app',version:1,definition:{name:'Notes',html:'<p>saved</p>',initial_state:{note:'initial'},capabilities:['mail.send'],width:360,height:280},panels:[{label:'Saved notes',state:{note:'saved'}}]}
const app:CustomApp={id:'local',name:'Notes',description:'Portable notes',rev:3,permission_rev:2,width:360,height:280,capabilities:['mail.send'],permissions:{'mail.send':'allow'},created_by:'maker',updated_at:'2026-01-01'}
test('portable app event declarations preserve names and refuse ambiguity or authority',()=>{
  const events=[{name:'submitted',description:'Notes ready for review'}],value={...bundle,definition:{...bundle.definition,events}}
  assert.deepEqual(parseAppBundle(JSON.stringify(value)).definition.events,events)
  for(const bad of [[events[0],events[0]],[{name:' submitted'}],[{name:'submitted '}],[{name:'\n'}],[{name:'x'.repeat(81)}],[{name:'x',description:'x'.repeat(1001)}],[{name:'x',permission:'allow'}],Array.from({length:65},(_,i)=>({name:'event'+i}))])assert.throws(()=>parseAppBundle(JSON.stringify({...value,definition:{...value.definition,events:bad}})))
  assert.deepEqual(parseAppBundle(JSON.stringify(bundle)),bundle,'old definition-only bundles stay readable')
})
function server(slug:string){
  const original=globalThis.fetch,calls:Record<string,unknown>[]=[]
  globalThis.fetch=async(raw,init)=>{
    const url=new URL(String(raw),'http://local'),input=init?.method==='POST'?JSON.parse(String(init.body)):JSON.parse(url.searchParams.get('request')??'{}');calls.push(input)
    assert.equal(url.pathname,`/api/orgs/${slug}/apps`)
    let out:unknown
    if(input.action==='list')out={items:input.kind==='apps'?[app]:[],next_cursor:null}
    else if(input.action==='app_export')out={bundle,panels:1}
    else if(input.action==='app_import')out={imported:'fresh',app:{...app,id:'fresh',permissions:{}},panels:[{id:'fresh-copy',open:false}]}
    else throw Error('Unexpected '+JSON.stringify(input))
    return new Response(JSON.stringify(out),{status:200,headers:{'Content-Type':'application/json'}})
  }
  return{calls,restore:()=>{globalThis.fetch=original}}
}
async function press(owner:Document,label:string){const button=[...owner.querySelectorAll<HTMLButtonElement>('button')].find(b=>b.textContent?.trim()===label||b.getAttribute('aria-label')===label);assert.ok(button,`missing ${label}`);await inAct(async()=>{button.click();await tick()})}

test('custom apps import previews plain metadata before creating closed ungranted copies',async t=>{
  const fixture=server('portable-import');t.after(fixture.restore)
  const view=await mountView(<><AppsButton slug="portable-import"/><AppsWorkspace slug="portable-import"/></>,el=>el);t.after(()=>view.unmount());await inAct(tick)
  const owner=view.el.ownerDocument;await press(owner,'Apps')
  const input=owner.querySelector<HTMLInputElement>('input[aria-label="Import app"]');assert.ok(input,'Apps menu needs app import')
  Object.defineProperty(input,'files',{configurable:true,value:[{size:JSON.stringify(bundle).length,text:async()=>JSON.stringify(bundle)}]})
  await inAct(async()=>{input.dispatchEvent(new owner.defaultView!.Event('change',{bubbles:true}));await tick()})
  const preview=owner.querySelector('[role="dialog"][aria-label="Import app"]');assert.ok(preview);assert.match(preview.textContent!,/Ask/);assert.match(preview.textContent!,/closed/);assert.match(preview.textContent!,/Saved notes/)
  assert.equal(fixture.calls.some(c=>c.action==='app_import'),false,'file selection must not import or execute code')
  assert.equal(owner.querySelector('iframe'),null)
  await press(owner,'Import app')
  const imported=fixture.calls.find(c=>c.action==='app_import');assert.deepEqual(imported,{action:'app_import',bundle})
  assert.equal(fixture.calls.some(c=>c.action==='panel_open'||c.action==='permission_set'),false)
  assert.equal(owner.querySelector('iframe'),null)
})

test('custom apps export explicitly chooses saved data and downloads only the returned portable bundle',async t=>{
  const fixture=server('portable-export');t.after(fixture.restore)
  const view=await mountView(<><AppsButton slug="portable-export"/><AppsWorkspace slug="portable-export"/></>,el=>el);t.after(()=>view.unmount());await inAct(tick)
  const owner=view.el.ownerDocument;await press(owner,'Apps');await press(owner,'Settings for Notes')
  const saved=owner.querySelector<HTMLInputElement>('input[aria-label="Include saved panel data"]');assert.ok(saved,'export needs a saved data choice');assert.equal(saved.checked,false)
  await inAct(async()=>{saved.click();await tick()})
  let blob:Blob|undefined,name='';const create=window.URL.createObjectURL,revoke=window.URL.revokeObjectURL,click=owner.defaultView!.HTMLAnchorElement.prototype.click
  window.URL.createObjectURL=value=>{blob=value as Blob;return 'blob:portable'};window.URL.revokeObjectURL=()=>{}
  owner.defaultView!.HTMLAnchorElement.prototype.click=function(){name=this.download}
  t.after(()=>{window.URL.createObjectURL=create;window.URL.revokeObjectURL=revoke;owner.defaultView!.HTMLAnchorElement.prototype.click=click})
  await press(owner,'Export app')
  assert.deepEqual(fixture.calls.find(c=>c.action==='app_export'),{action:'app_export',app:'local',expected_rev:3,include_panels:true})
  assert.equal(name,'Notes.orgtree-app');assert.ok(blob);assert.deepEqual(JSON.parse(await blob.text()),bundle)
})

test('portable native deep-array exports stay inside their exact import byte limit',async t=>{
  let state:unknown=Array(150000).fill(0);for(let i=0;i<60;i++)state={nested:state}
  const value={...bundle,panels:[{label:'Deep saved data',state}]};assert.ok(new TextEncoder().encode(JSON.stringify(value)).length<APP_BUNDLE_MAX)
  let blob:Blob|undefined;const create=window.URL.createObjectURL,revoke=window.URL.revokeObjectURL,click=window.HTMLAnchorElement.prototype.click
  window.URL.createObjectURL=value=>{blob=value as Blob;return 'blob:deep'};window.URL.revokeObjectURL=()=>{};window.HTMLAnchorElement.prototype.click=()=>{}
  t.after(()=>{window.URL.createObjectURL=create;window.URL.revokeObjectURL=revoke;window.HTMLAnchorElement.prototype.click=click})
  saveAppJson(document,'Deep.orgtree-app',value,true)
  assert.ok(blob);assert.ok(blob.size<=APP_BUNDLE_MAX,'export must fit its own exact byte import cap');assert.deepEqual(JSON.parse(await blob.text()),value)
})
