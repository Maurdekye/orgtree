import {flush,inAct,mountView} from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import path from 'node:path'
import {AppsButton,AppsWorkspace} from '../src/canvas/apps/ui'

// USER 2026-10-27 mdba9ae69ac16: "these buttons should highlight when hovered (+, gear)"
// (@item:orgtree/4-5-0-apps-list-stable-order-regardless-of-panel). Hovering an app
// row fills the whole row with --panel-2, and the generic menu button hover was the
// same --panel-2, so + and the gears showed no change on a hovered row. jsdom
// applies no :hover, so this reads the stylesheet's rules for the rendered buttons;
// tools/rig/appsrowhover-visual.mjs measures the painted colours in every theme.
declare const __SRC_DIR__: string
const css=readFileSync(path.join(__SRC_DIR__,'canvas/apps/apps.css'),'utf8').replace(/\/\*[\s\S]*?\*\//g,'')
const tick=async()=>{for(let i=0;i<5;i++)await flush()}
/** the declarations of every rule whose selector names `cls` with `state` */
const rules=(cls:string,state:string)=>[...css.matchAll(/([^{}]+)\{([^}]*)\}/g)]
 .filter(([,sel])=>sel!.split(',').some(s=>s.includes(cls))&&sel!.includes(state)).map(([,,body])=>body!)
const background=(body:string)=>/background(?:-color)?\s*:\s*([^;]+)/.exec(body)?.[1]?.trim()

function fixture(t:test.TestContext){
 const app=(id:string,name:string)=>({id,name,description:'',rev:1,permission_rev:1,width:360,height:280,capabilities:[],permissions:{},created_by:'maker',updated_at:'',created_at:'2026-10-27T0'+id.length+':00:00Z',definition:{name,description:'',html:'<p>x</p>',initial_state:{},capabilities:[],width:360,height:280}})
 const apps=[app('notes','Notes'),app('captions','Caption placement')]
 const panels=[{id:'p1',app:'notes',label:'Panel 1',rev:1,open:false,running:true,state:{},event_seq:0,placement:{mode:'float',x:40,y:40,width:360,height:280},used_at:'2026-10-27',updated_at:'',created_at:'2026-10-27T09:00:00Z'}]
 const original=globalThis.fetch
 globalThis.fetch=async(raw,init)=>{const url=new URL(String(raw),'http://local'),input=init?.method==='POST'?JSON.parse(String(init.body)):JSON.parse(url.searchParams.get('request')??'{}');let out:unknown
  if(input.action==='list')out={items:input.kind==='apps'?apps:panels,next_cursor:null,new_count:0}
  else if(input.action==='app_get')out=apps.find(a=>a.id===input.app)
  else if(input.action==='events')out={events:[],next_cursor:null,oldest_retained:null}
  else out={items:[],next_cursor:null}
  return new Response(JSON.stringify(out),{headers:{'Content-Type':'application/json'}})
 };t.after(()=>{globalThis.fetch=original})
}

test('+ and the app and panel gears highlight on hover and focus, one step past the hovered row they sit on',async t=>{
 fixture(t)
 const view=await mountView(<><AppsButton slug="rowbuttons"/><AppsWorkspace slug="rowbuttons"/></>,e=>e);t.after(()=>view.unmount());await inAct(tick)
 await inAct(async()=>{view.el.querySelector<HTMLButtonElement>('.apps-button')!.click();await tick()})
 const menu=document.querySelector<HTMLElement>('.custom-apps-menu')!
 const plus=menu.querySelector<HTMLElement>('[aria-label="New panel for Notes"]'),gear=menu.querySelector<HTMLElement>('[aria-label="Settings for Notes"]'),panelGear=menu.querySelector<HTMLElement>('[aria-label="Settings for Panel 1"]')
 assert.ok(plus&&gear&&panelGear,'the three buttons are on screen')
 assert.equal(plus!.title,'New panel','tooltips stay');assert.equal(gear!.title,'App settings: Notes');assert.equal(panelGear!.title,'Panel settings: Panel 1')
 const row=background(rules('.custom-apps-menu-app',':hover').join(';'))
 assert.equal(row,'var(--panel-2)','a hovered app row is filled with --panel-2')
 for(const [name,el] of [['+',plus],['app gear',gear],['panel gear',panelGear]] as const){
  const cls=[...el!.classList].find(c=>c.startsWith('custom-apps-'))
  assert.ok(cls,`${name} has its own class to style`)
  const hover=rules('.'+cls,':hover').map(background).filter(Boolean)
  assert.ok(hover.length&&hover.every(b=>b!==row&&b!=='none'&&b!=='transparent'),`${name}: its hover fill differs from the hovered row's (${JSON.stringify(hover)})`)
  assert.ok(rules('.'+cls,':focus-visible').some(b=>/outline\s*:/.test(b)||background(b)),`${name}: keyboard focus shows too`)
 }
})
