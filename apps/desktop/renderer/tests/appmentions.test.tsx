// tests/appmentions.test.tsx — @item:orgtree/4-5-0-apps-and-specific-panels-can-be-mentioned-t.
// USER 2026-10-27 m449dc0a35cbe: "also allow apps or spedific panels to be mentioned to the user". Agents write
// @app:<org>/<app-id> and @panel:<org>/<panel-id>; the chip shows the current name (a panel with its app's,
// since labels default to "Panel N"), clicking does what the Apps menu row does through its own openAppPanel,
// the hover text and a panel's menu are the row's, and a deleted or other-org target is an inert chip.
// Each test uses its own org slug: answers are kept per org.
import {flush,inAct,mountView} from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import {useMemo} from 'react'
import {RefProse,resolveRef,splitTypedRefs,useRefRoutes} from '../src/canvas/reflinks'
import {RefMdBody} from '../src/canvas/refmd'
import {parseRef,scanRefs} from '../src/canvas/workrefs'
import {AppsWorkspace} from '../src/canvas/apps/ui'
import {invalidateCustomApps} from '../src/canvas/apps/store'
import {ObjectNavProvider} from '../src/canvas/objectnav'
import {ObjectNavHost} from '../src/canvas/objectnavhost'
import {ObjectMenuBoundary} from '../src/canvas/contextmenu'
import {md} from '../src/canvas/shared'

const tick=async()=>{for(let i=0;i<6;i++)await flush()}
const noop=()=>{}
type Panel={id:string;app:string;label:string;rev:number;open:boolean;running:boolean;run_generation:number;state:Record<string,unknown>;event_seq:number;placement:{mode:string;x:number;y:number;width:number;height:number};created_at:string;used_at:string;updated_at:string}
const copy=(id:string,label:string,used_at:string):Panel=>({id,app:'notes',label,rev:1,open:false,running:false,run_generation:0,state:{},event_seq:0,placement:{mode:'float',x:40,y:40,width:360,height:280},created_at:used_at,used_at,updated_at:''})
const READS=['list','app_get','panel_get','refs','events','runtime','session_close','heartbeat']

function engine(t:test.TestContext){
 const app={id:'notes',name:'Notes',description:'Saved notes',rev:1,permission_rev:1,width:360,height:280,capabilities:[],permissions:{},created_by:'maker',created_at:'2026-10-20T08:00:00Z',updated_at:'',definition:{name:'Notes',description:'',html:'<p>Notes</p>',initial_state:{},capabilities:[],width:360,height:280}}
 const panels=[copy('one','Panel 1','2026-10-26T10:00:00Z'),copy('two','Panel 2','2026-10-26T11:00:00Z')]
 const calls:{method:string;input:Record<string,any>}[]=[],original=globalThis.fetch,state={refuse:''}
 const recent=()=>panels.filter(p=>p.app===app.id).sort((a,b)=>b.used_at.localeCompare(a.used_at)||(a.id<b.id?1:-1))[0]
 globalThis.fetch=async(raw,init)=>{const url=new URL(String(raw),'http://local'),method=init?.method==='POST'?'POST':'GET'
  const input=method==='POST'?JSON.parse(String(init!.body)):JSON.parse(url.searchParams.get('request')??'{}');calls.push({method,input});let out:unknown
  const one=()=>panels.find(p=>p.id===input.panel)!
  if(input.action==='refs')out={apps:(input.apps??[]).filter((id:string)=>id===app.id).map((id:string)=>({id,name:app.name,recent:recent()?.label??null})),
   panels:(input.panels??[]).map((id:string)=>panels.find(p=>p.id===id)).filter(Boolean).map((p:Panel)=>({id:p.id,app:p.app,app_name:app.name,label:p.label,open:p.open,running:p.running}))}
  else if(input.action==='list')out={items:input.kind==='apps'?[app]:panels.filter(p=>(input.open===undefined||p.open===input.open)&&(input.running===undefined||p.running===input.running)),next_cursor:null,new_count:0}
  else if(input.action==='app_get')out=app
  else if(input.action==='panel_get')out=one()
  else if(input.action==='events')out={events:[],next_cursor:null,oldest_retained:null}
  else if(input.action==='runtime'||input.action==='session_close')out={items:[],next_cursor:null}
  else if(input.action==='heartbeat')out={stop:[],sample_epoch:0}
  else if(state.refuse)return new Response(JSON.stringify({error:state.refuse}),{status:409,headers:{'Content-Type':'application/json'}})
  // like the engine: opening is a use and starts a stopped copy; an app alone opens its most recent copy
  else if(input.action==='panel_open'){const p=input.panel?one():recent()!;p.open=true;p.running=true;p.used_at='2026-10-27T08:00:00Z';p.rev++;out=p}
  else if(input.action==='panel_start'){const p=one();p.running=true;p.rev++;out=p}
  else if(input.action==='panel_stop'){const p=one();p.running=false;p.open=false;p.rev++;out=p}
  else throw Error('Unexpected '+input.action)
  return new Response(JSON.stringify(out),{headers:{'Content-Type':'application/json'}})
 }
 t.after(()=>{globalThis.fetch=original})
 return{app,panels,calls,state,writes:(from:number)=>calls.slice(from).filter(c=>!READS.includes(c.input.action)).map(c=>c.input),
  refs:()=>calls.filter(c=>c.input.action==='refs')}
}

function Surface({slug,text,markdown}:{slug:string;text:string;markdown?:boolean}){
 const agents=useMemo(()=>new Map<string,unknown>(),[])
 const refs=useRefRoutes(slug,agents,{})
 return markdown?<RefMdBody className="md" html={md(text)} world={refs.world} onOpen={refs.onOpen}/>
  :<p className="prose"><RefProse text={text} world={refs.world} onOpen={refs.onOpen}/></p>
}
async function mount(t:test.TestContext,slug:string,text:string,markdown=false){
 const e=engine(t)
 const view=await mountView(<ObjectNavProvider><ObjectNavHost org={slug} dogs={[]} openDog={noop} toast={noop}/>
  <ObjectMenuBoundary><Surface slug={slug} text={text} markdown={markdown}/></ObjectMenuBoundary><AppsWorkspace slug={slug}/></ObjectNavProvider>,el=>el)
 t.after(()=>view.unmount());await inAct(tick)
 // a Markdown chip keeps the token it replaced
 const chip=(token:string)=>view.el.querySelector<HTMLElement>(`[data-ref-token="${token}"]`)
 return{...e,view,
  // the chips on screen in order: what each says, its hover text and whether it is a control
  chips:()=>[...view.el.querySelectorAll<HTMLElement>('.ref-chip.ref-app, .ref-chip.ref-panel')].map(c=>({text:c.textContent,title:c.title,live:c.tagName==='BUTTON'})),
  chip,click:(el:HTMLElement)=>inAct(async()=>{el.click();await tick()})}
}
const frame=(id:string)=>document.querySelector<HTMLElement>(`[data-custom-panel="${id}"]`)
const top=()=>document.querySelector<HTMLElement>('.ctxmenu:not(.ctxmenu-submenu)')
const menuLabels=()=>{const m=top();return m?[...m.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].filter(b=>b.closest('[role="menu"]')===m).map(b=>(b.textContent??'').trim()):[]}
async function rightClick(el:Element){
 await inAct(async()=>{el.dispatchEvent(new window.MouseEvent('pointerdown',{bubbles:true,cancelable:true,button:2}))
  el.dispatchEvent(new window.MouseEvent('mousedown',{bubbles:true,cancelable:true,button:2}))
  el.dispatchEvent(new window.MouseEvent('contextmenu',{bubbles:true,cancelable:true,button:2,clientX:40,clientY:40}));await tick()})
}

test('app and panel tokens follow the shared token grammar and boundaries',()=>{
 assert.deepEqual(parseRef('@app:acme/app0a1b2c3d4e5f'),{kind:'app',org:'acme',id:'app0a1b2c3d4e5f'})
 assert.deepEqual(parseRef('@panel:acme/panel0a1b2c3d4e5f'),{kind:'panel',org:'acme',id:'panel0a1b2c3d4e5f'})
 const hits=(s:string)=>scanRefs(s).map(h=>h.token)
 assert.deepEqual(hits('Open @app:acme/notes, then @panel:acme/one.'),['@app:acme/notes','@panel:acme/one'],'a sentence ends a token')
 assert.deepEqual(hits('@app:acme/notes@panel:acme/one'),['@app:acme/notes','@panel:acme/one'],'two adjacent tokens both survive')
 for(const s of ['x@app:acme/notes','@app:acme/notes/extra','@app:acme/Notes','@app:acme','@apps:acme/notes','@panel:acme/one@bad'])assert.deepEqual(hits(s),[],s)
 // code is quoted text, never a control
 const runs=splitTypedRefs('see `@app:acme/notes` and @app:acme/notes',{org:'acme'})
 assert.deepEqual(runs.map(r=>r.ref?r.ref.token:null).filter(Boolean),['@app:acme/notes'])
})

test('a token is decided like the other kinds: foreign first, then what this surface can say',()=>{
 const app=parseRef('@app:acme/notes')!,panel=parseRef('@panel:acme/one')!
 assert.equal(resolveRef(parseRef('@app:other/notes')!,{org:'acme'}).outcome,'foreign','another org is never resolved here')
 assert.equal(resolveRef(app,{org:'acme',handles:new Set(['item'])}).outcome,'elsewhere')
 // no resolver: clickable, labelled with the ID, the engine refuses a target that has gone
 assert.deepEqual([resolveRef(app,{org:'acme'}).outcome,resolveRef(app,{org:'acme'}).label],['ready','notes'])
 const world=(outcome:'ready'|'pending'|'absent')=>({org:'acme',refName:()=>({outcome,label:'Notes · Panel 1',title:'Off'})})
 assert.deepEqual([resolveRef(panel,world('ready')).label,resolveRef(panel,world('ready')).why],['Notes · Panel 1','Off'])
 assert.equal(resolveRef(panel,world('pending')).why,"still loading this org's apps")
 assert.equal(resolveRef(panel,world('absent')).why,'no panel one in this org')
})

test('chips name the app and the panel as they are now, and click like their Apps menu rows',async t=>{
 const slug='mentions-click'
 const m=await mount(t,slug,`Open @app:${slug}/notes or @panel:${slug}/one. Gone: @app:${slug}/gone. Elsewhere: @app:other/notes.`)
 assert.deepEqual(m.chips(),[
  {text:'Notes',title:'Open Panel 2',live:true},
  {text:'Notes · Panel 1',title:'Off',live:true},
  {text:`@app:${slug}/gone`+'unavailable',title:'no app gone in this org',live:false},
  {text:'@app:other/notes'+'other org',title:'this app belongs to the org “other”, not to this one — it is not opened from here',live:false}])
 assert.deepEqual(m.refs().map(c=>[c.method,c.input]),[['GET',{action:'refs',apps:['notes','gone'],panels:['one']}]],'one bounded read for the IDs on screen; the other org is not asked')
 const buttons=()=>[...m.view.el.querySelectorAll<HTMLButtonElement>('button.ref-chip')]
 let mark=m.calls.length
 await m.click(buttons()[0]!)
 assert.deepEqual(m.writes(mark),[{action:'panel_open',app:'notes'}],'an app chip is the app row: the engine picks its most recent copy')
 assert.ok(frame('two'),'Panel 2, the most recently used copy, opens')
 mark=m.calls.length
 await m.click(buttons()[1]!)
 assert.deepEqual(m.writes(mark),[{action:'panel_open',panel:'one'}])
 assert.ok(frame('one'),'Panel 1 opens')
 // the engine's custom_apps_changed notice, as the org socket delivers it
 await inAct(async()=>{invalidateCustomApps(slug);await tick()})
 assert.equal(m.chips()[1]!.title,'Running · visible','the hover text follows the panel, as its row does')
})

test('Markdown bodies decide and open the same tokens, leaving code alone',async t=>{
 const slug='mentions-md'
 const m=await mount(t,slug,`Your copy: @panel:${slug}/two\n\nQuoted: \`@app:${slug}/notes\``,true)
 const chip=m.chip(`@panel:${slug}/two`)!
 assert.deepEqual([chip.tagName,chip.textContent,chip.title],['BUTTON','Notes · Panel 2','Off'])
 assert.equal(m.view.el.querySelector('code')?.textContent,`@app:${slug}/notes`,'a token in code stays text')
 assert.equal(m.view.el.querySelectorAll('[data-ref-token]').length,1)
 const mark=m.calls.length
 await m.click(chip)
 assert.deepEqual(m.writes(mark),[{action:'panel_open',panel:'two'}])
 assert.ok(frame('two'))
})

test('a rename or a deletion updates the chips already on screen',async t=>{
 const slug='mentions-change'
 const m=await mount(t,slug,`@app:${slug}/notes and @panel:${slug}/one`)
 assert.deepEqual(m.chips().map(c=>c.text),['Notes','Notes · Panel 1'])
 m.app.name='Journal';m.panels.splice(0,1)
 await inAct(async()=>{invalidateCustomApps(slug);await tick()})
 assert.deepEqual(m.chips().map(c=>[c.text,c.live]),[['Journal',true],[`@panel:${slug}/one`+'unavailable',false]])
 assert.deepEqual(m.refs().at(-1)!.input,{action:'refs',apps:['notes'],panels:['one']},'the kept targets are read again')
})

test("a panel chip's menu is its Apps menu row's; an app chip has none, like its row",async t=>{
 const slug='mentions-menu'
 const m=await mount(t,slug,`@app:${slug}/notes and @panel:${slug}/one`)
 const [app,panel]=[...m.view.el.querySelectorAll<HTMLButtonElement>('button.ref-chip')]
 await rightClick(panel!)
 assert.deepEqual(menuLabels(),['Start running'],'a stopped copy can start hidden')
 const mark=m.calls.length
 await inAct(async()=>{const b=[...top()!.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(x=>x.textContent?.trim()==='Start running')!
  b.dispatchEvent(new window.MouseEvent('pointerdown',{bubbles:true,cancelable:true,button:0}));b.click();await tick()})
 assert.deepEqual(m.writes(mark),[{action:'panel_start',panel:'one'}])
 assert.equal(frame('one')?.dataset.parked,'true','started hidden: no window is shown')
 assert.equal(top(),null,'choosing closes the menu')
 await rightClick(app!)
 assert.ok(!menuLabels().some(l=>l==='Start running'||l==='Power off'),'no panel entries on an app')
})

test('a refused open shows in the apps error banner',async t=>{
 const slug='mentions-refused'
 const m=await mount(t,slug,`@panel:${slug}/one`)
 m.state.refuse='Stop all is on: apps cannot start'
 await m.click(m.view.el.querySelector<HTMLButtonElement>('button.ref-chip')!)
 assert.match(document.querySelector('.custom-app-global-error')?.textContent??'',/Stop all is on/)
})
