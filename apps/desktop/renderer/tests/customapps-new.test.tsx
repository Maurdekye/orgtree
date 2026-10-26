import {flush,inAct,mountView} from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import {AppsButton,AppsWorkspace} from '../src/canvas/apps/ui'
import {invalidateCustomApps,refreshApps} from '../src/canvas/apps/store'

const tick=async()=>{for(let i=0;i<5;i++)await flush()}
test('new apps count includes unloaded pages and clears only entries actually seen in this org',async t=>{
  const oldFetch=globalThis.fetch,win=window as unknown as {IntersectionObserver:unknown},oldIO=win.IntersectionObserver
  const seen:Record<string,unknown>[]=[],rows=[{id:'a',name:'Agent app',is_new:true},{id:'b',name:'Imported app',is_new:true},{id:'c',name:'Another page',is_new:true}].map(a=>({...a,description:'',rev:1,width:300,height:240,capabilities:[],permissions:{},created_by:'maker',updated_at:''}))
  let deliver:(ids:string[])=>void=()=>{}
  win.IntersectionObserver=class {
    targets:Element[]=[]
    constructor(callback:(entries:unknown[])=>void){deliver=ids=>callback(this.targets.map(target=>({target,isIntersecting:ids.includes(target.getAttribute('data-new-app')!),intersectionRatio:ids.includes(target.getAttribute('data-new-app')!)?1:0})))}
    observe(e:Element){this.targets.push(e)}disconnect(){}
  }
  globalThis.fetch=async(raw,init)=>{
    const url=new URL(String(raw),'http://local'),input=init?.method==='POST'?JSON.parse(String(init.body)):JSON.parse(url.searchParams.get('request')??'{}')
    assert.equal(url.pathname,'/api/orgs/new-apps-test/apps')
    let result:unknown
    if(input.action==='list')result={items:input.kind==='panels'?[]:rows.slice(input.after?2:0,input.after?3:2),next_cursor:input.kind==='panels'||input.after?null:'b',new_count:rows.filter(a=>a.is_new).length}
    else if(input.action==='mark_seen'){seen.push(input);for(const row of rows)if(input.apps.includes(row.id))row.is_new=false;result={seen:input.apps,new_count:rows.filter(a=>a.is_new).length}}
    else throw Error('Unexpected '+input.action)
    return new Response(JSON.stringify(result),{headers:{'Content-Type':'application/json'}})
  }
  t.after(()=>{globalThis.fetch=oldFetch;win.IntersectionObserver=oldIO})
  const view=await mountView(<><AppsButton slug="new-apps-test"/><AppsWorkspace slug="new-apps-test"/><AppsButton slug="other-org"/></>,e=>e);t.after(()=>view.unmount());await inAct(tick)
  const button=view.el.querySelector<HTMLButtonElement>('.apps-button')!,other=view.el.querySelectorAll('.apps-button')[1]!
  assert.equal(button.querySelector('.eye-count')?.textContent,'3','count all unseen apps, not just the first page')
  assert.ok(button.classList.contains('glow'));assert.ok(button.querySelector('.eye-count.asks'))
  assert.equal(other.querySelector('.eye-count'),null,'orgs have independent counts')
  assert.equal(seen.length,0,'background refresh cannot mark an app seen')
  await inAct(async()=>{button.click();await tick()})
  const menu=view.el.ownerDocument.querySelector('.custom-apps-menu')!
  assert.equal(menu.querySelectorAll('.custom-app-new-label').length,2)
  await inAct(async()=>{deliver(['a']);await tick()})
  assert.equal(button.querySelector('.eye-count')?.textContent,'2');assert.deepEqual(seen[0]?.apps,['a'])
  assert.equal(menu.querySelectorAll('.custom-app-new-label').length,2,'keep New labels for this menu visit')
  await inAct(async()=>{button.click();await tick();button.click();await tick()})
  assert.equal(view.el.ownerDocument.querySelectorAll('.custom-app-new-label').length,1,'next visit marks only the still-unseen entry')
  await inAct(async()=>{deliver(['b']);await tick()})
  const more=[...view.el.ownerDocument.querySelectorAll<HTMLButtonElement>('.custom-apps-menu button')].find(b=>b.textContent==='More apps')!
  await inAct(async()=>{more.click();await tick()});await inAct(async()=>{deliver(['c']);await tick()})
  assert.equal(button.querySelector('.eye-count'),null);assert.equal(button.classList.contains('glow'),false)
  await inAct(async()=>{button.click();rows.push({...rows[0]!,id:'d',name:'Later import',is_new:true});invalidateCustomApps('new-apps-test');await refreshApps('new-apps-test');await tick()})
  assert.equal(button.querySelector('.eye-count')?.textContent,'1','new creation notifications refresh the header while closed')
})
