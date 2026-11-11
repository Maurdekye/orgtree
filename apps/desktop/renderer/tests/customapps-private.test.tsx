import {flush,inAct,mountView} from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import {AppPermissions} from '../src/canvas/apps/permissions'
import {describePermission} from '../src/canvas/apps/net-ui'
import type {CustomApp} from '../src/canvas/apps/types'

// USER 2026-11-11 m27cc41f6b6d1 "A: extend apps"; spec section 3.6: a declared site that resolves to a
// private address gets "Allow private network" in place of "Allow", a confirm dialog and its pinned address.
const tick=async()=>{for(let i=0;i<5;i++)await flush()}
const classes:Record<string,Record<string,unknown>>={
  '100.101.102.103:8642':{site:'100.101.102.103:8642',class:'private',addresses:['100.101.102.103'],pinned:[],allowed:false,moved:false,tailscale:true},
  '192.168.1.5:8080':{site:'192.168.1.5:8080',class:'private',addresses:['192.168.1.5'],pinned:[],allowed:false,moved:false,tailscale:false},
  'api.example.com':{site:'api.example.com',class:'public',addresses:['8.8.8.8'],pinned:[],allowed:false,moved:false,tailscale:false},
}
function fixture(rows:Record<string,unknown>={},overrides:Record<string,Record<string,unknown>>={}){
  const app={id:'viewer',name:'Viewer',description:'',rev:3,permission_rev:9,width:360,height:300,capabilities:['net.fetch'],sites:['100.101.102.103:8642','192.168.1.5:8080','api.example.com'],permissions:{},site_permissions:rows,created_by:'maker',updated_at:'now'} as unknown as CustomApp
  const sets:Record<string,unknown>[]=[],reads:string[]=[],old=globalThis.fetch
  globalThis.fetch=async(raw,init)=>{
    const url=new URL(String(raw),'http://local'),input=init?.method==='POST'?JSON.parse(String(init.body)):JSON.parse(url.searchParams.get('request')??'{}')
    if(input.action==='net_classify'){reads.push(input.site);return new Response(JSON.stringify(overrides[input.site]??classes[input.site]))}
    if(input.action==='permission_set'){sets.push(input);return new Response(JSON.stringify({...app,permission_rev:10}))}
    throw Error('Unexpected '+JSON.stringify(input))
  }
  return{app,sets,reads,restore:()=>{globalThis.fetch=old}}
}
const select=(label:string)=>document.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)
const options=(label:string)=>[...select(label)!.options].map(o=>o.textContent)

test('a private-class declared site offers Allow private network, a public one keeps Allow',async t=>{
  const f=fixture();t.after(f.restore)
  const view=await mountView(<AppPermissions slug="priv-a" app={f.app} close={()=>{}} embedded/>,e=>e);t.after(()=>view.unmount());await inAct(tick)
  assert.deepEqual(options('100.101.102.103:8642 internet permission'),['Ask','Allow private network','Deny'])
  assert.deepEqual(options('192.168.1.5:8080 internet permission'),['Ask','Allow private network','Deny'])
  assert.deepEqual(options('api.example.com internet permission'),['Ask','Allow','Deny'])
  assert.ok(f.reads.includes('100.101.102.103:8642'),'the row asks the engine where the site resolves')
  assert.match(view.el.textContent!,/Tailscale range/,'a Tailscale address is labelled as such')
  assert.match(view.el.textContent!,/Unencrypted \(http\)/,'a LAN address is flagged as unencrypted')
})

test('allowing a private site confirms first, names the address, and Cancel changes nothing',async t=>{
  const f=fixture();t.after(f.restore)
  const view=await mountView(<AppPermissions slug="priv-b" app={f.app} close={()=>{}} embedded/>,e=>e);t.after(()=>view.unmount());await inAct(tick)
  const choose=async()=>inAct(async()=>{const s=select('100.101.102.103:8642 internet permission')!;s.value='allow-private';s.dispatchEvent(new window.Event('change',{bubbles:true}));await tick()})
  await choose()
  const dialog=document.querySelector('[role="dialog"]')!;assert.ok(dialog,'a confirm dialog opens')
  assert.match(dialog.textContent!,/Allow Viewer to reach 100\.101\.102\.103:8642 \(100\.101\.102\.103\) on your private network\?/)
  assert.match(dialog.textContent!,/Only allow a computer you control/)
  assert.equal(f.sets.length,0,'nothing is stored before the answer')
  await inAct(async()=>{[...dialog.querySelectorAll('button')].find(b=>b.textContent==='Cancel')!.click();await tick()})
  assert.equal(f.sets.length,0,'Cancel leaves permissions unchanged')
  await choose()
  const again=document.querySelector('[role="dialog"]')!
  await inAct(async()=>{[...again.querySelectorAll('button')].find(b=>b.textContent==='Allow')!.click();await tick()})
  assert.deepEqual(f.sets.at(-1),{action:'permission_set',app:'viewer',expected_rev:3,expected_permission_rev:9,capability:'net.fetch',permission:'allow-private',site:'100.101.102.103:8642'})
})

test('an allowed private site shows its pinned address, and a moved name offers Use the new address',async t=>{
  const row={value:'allow-private',addresses:['100.64.0.9']}
  const f=fixture({'100.101.102.103:8642':row},{'100.101.102.103:8642':{...classes['100.101.102.103:8642'],addresses:['100.64.0.10'],pinned:['100.64.0.9'],allowed:true,moved:true}})
  t.after(f.restore)
  const view=await mountView(<AppPermissions slug="priv-c" app={f.app} close={()=>{}} embedded/>,e=>e);t.after(()=>view.unmount());await inAct(tick)
  assert.equal(select('100.101.102.103:8642 internet permission')!.value,'allow-private','an object row reads as its value')
  assert.match(view.el.textContent!,/100\.64\.0\.9/,'the pinned address is shown')
  assert.match(view.el.textContent!,/now resolves to 100\.64\.0\.10/,'the new address is shown')
  await inAct(async()=>{[...view.el.querySelectorAll('button')].find(b=>b.textContent==='Use the new address')!.click();await tick()})
  assert.equal((f.sets.at(-1) as {permission:string}).permission,'allow-private','re-pinning is the same user action')
})

test('Permission history words the private-network entries',()=>{
  const e=(permission:string,extra={})=>({seq:1,capability:'net.fetch',site:'100.101.102.103:8642',permission,via:'change',actor:'user',panel:null,at:'2026-11-11T00:00:00Z',...extra}) as never
  assert.match(describePermission(e('allow-private')),/allowed on the private network/)
  assert.match(describePermission(e('repin')),/address re-pinned/)
})
