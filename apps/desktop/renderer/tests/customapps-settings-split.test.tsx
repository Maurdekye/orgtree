import {flush,inAct,mountView} from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import {AppsButton,AppsWorkspace} from '../src/canvas/apps/ui'
import {CopyFeedback} from '../src/canvas/contextmenu'

const tick=async()=>{for(let i=0;i<5;i++)await flush()}
const dialog=(name:string)=>document.querySelector<HTMLElement>('[role="dialog"][aria-label="'+name+'"]')
const button=(root:ParentNode,name:string)=>[...root.querySelectorAll<HTMLButtonElement>('button')].find(b=>b.textContent?.trim()===name)!
async function setup(t:test.TestContext,slug:string,open=false,toast?:(lines?:string[]|null)=>void){
 const app={id:'notes',name:'Notes',description:'Saved notes',rev:1,permission_rev:1,width:360,height:280,capabilities:['events.fire','files.read','files.write'],events:[{name:'submitted'}],permissions:{'events.fire':'deny'},created_by:'maker',updated_at:''}
 const copy=(id:string,label:string,isOpen:boolean)=>({id,app:'notes',label,rev:1,open:isOpen,state:{note:id},event_seq:0,placement:{mode:'float',x:40,y:40,width:360,height:280},used_at:id==='one'?'2026-10-26':'2026-10-25',updated_at:''})
 const panels=[copy('one','First notes',open),copy('two','Closed notes',false)],calls:Record<string,any>[]=[]
 const original=globalThis.fetch
 globalThis.fetch=async(raw,init)=>{const url=new URL(String(raw),'http://local'),input=init?.method==='POST'?JSON.parse(String(init.body)):JSON.parse(url.searchParams.get('request')??'{}');calls.push(input);let out:unknown
   if(url.pathname.endsWith('/files')){
    if(input.action==='permissions')out={rev:1,permission_rev:1,grants:[{id:'grant',mode:'read',scope:'orgtree',name:'Orgtree files'}]}
    else if(input.action==='confirmations')out={items:[{challenge:'change',agent:'worker',detail:{path:'Synthetic.txt',operation:'create',previous_bytes:null,bytes:4,sha256:'digest'}}]}
    else if(input.action==='revoke')out={rev:1,permission_rev:2,grants:[]}
    else if(input.action==='confirm')out={}
    else throw Error('Unexpected files '+input.action)
   }else if(input.action==='list')out={items:input.kind==='apps'?[app]:panels.filter(p=>!input.open||p.open),next_cursor:null,new_count:0}
   else if(input.action==='panel_get')out=panels.find(p=>p.id===input.panel)
   else if(input.action==='app_get')out=app
   else if(input.action==='session_close')out={}
   else if(input.action==='permission_set'){app.permissions[input.capability as 'events.fire']=input.permission;app.permission_rev++;out=app}
   // Like the engine (wire::text): a saved-panel label must not be blank.
   else if(input.action==='panel_update'&&input.label!==undefined&&!String(input.label).trim())return new Response(JSON.stringify({detail:'panel label must not be blank'}),{status:400,headers:{'Content-Type':'application/json'}})
   else if(input.action==='panel_update'){const p=panels.find(p=>p.id===input.panel)!;assert.equal(input.expected_rev,p.rev);Object.assign(p,input);p.rev++;out=p}
   else if(input.action==='state_set'){const p=panels.find(p=>p.id===input.panel)!;assert.equal(input.expected_rev,p.rev);p.state=input.state;p.rev++;out=p}
   else if(input.action==='events')out={events:[],next_cursor:null}
   else if(input.action==='listeners')out={items:[],next_cursor:null}
   else throw Error('Unexpected '+input.action)
   return new Response(JSON.stringify(out),{headers:{'Content-Type':'application/json'}})
 };t.after(()=>{globalThis.fetch=original})
 const view=await mountView(<CopyFeedback.Provider value={toast}><AppsButton slug={slug}/><AppsWorkspace slug={slug}/></CopyFeedback.Provider>,e=>e);t.after(()=>view.unmount());await inAct(tick)
 return{view,calls,panels,openMenu:async()=>{await inAct(async()=>{view.el.querySelector<HTMLButtonElement>('.apps-button')!.click();await tick()})}}
}

test('app-list gear opens only app-wide settings and preserves Files and event permissions',async t=>{
 const {openMenu,calls}=await setup(t,'settings-app');await openMenu()
 await inAct(async()=>{document.querySelector<HTMLButtonElement>('[aria-label="Settings for Notes"]')!.click();await tick()})
 const app=dialog('App settings')!;assert.ok(app?.classList.contains('settings'))
 assert.equal(!!app.querySelector('[aria-label="Saved panel"]'),false,'app settings must not choose or edit a panel')
 assert.equal(!!button(app,'State…'),false,'panel actions do not belong in App settings')
 for(const name of ['Export app','Delete app…'])assert.ok(app.textContent?.includes(name))
 assert.equal(app.textContent?.includes('Created by'),false,'no creator row (user 2026-10-26: "remove created-by")')
 // User 2026-10-26: Permissions is App settings' second tab, not a separate dialog; 2026-10-27 m838e66af753b: Permission history is its own tab.
 assert.deepEqual([...app.querySelectorAll('[role="tab"]')].map(e=>e.textContent),['General','Permissions','Permission history']);assert.equal(!!button(app,'Permissions…'),false)
 // User 2026-10-26: "put the description above the tabs and remove the app header".
 const description=[...app.querySelectorAll('p')].find(p=>p.textContent==='Saved notes');assert.ok(description,'the app description is shown')
 assert.equal(!!description.closest('[role="tabpanel"]'),false,'the description belongs to the whole window, not one tab')
 assert.equal((description.compareDocumentPosition(app.querySelector('[role="tablist"]')!)&window.Node.DOCUMENT_POSITION_FOLLOWING)!==0,true,'the description sits above the tab row')
 assert.equal(app.querySelectorAll('.set-group-head').length,0,'no App section header')
 assert.ok(app.querySelector('[role="tabpanel"]:not([hidden])')!.textContent!.includes('Export app'),'Export app stays on General')
 // User 2026-10-26: a delete confirmation fits its content, not the full settings frame.
 await inAct(async()=>{button(app,'Delete app…').click();await tick()});assert.equal(dialog('Delete app')!.classList.contains('custom-app-confirm'),true,'Delete app is a compact confirmation')
 await inAct(async()=>{button(dialog('Delete app')!,'Cancel').click();await tick()})
 await inAct(async()=>{button(app,'Permissions').click();await tick()})
 assert.equal(!!dialog('App permissions'),false,'permissions open in the tab');const permissions=app.querySelector<HTMLElement>('[role="tabpanel"]:not([hidden]) [aria-label="App permissions"]')!;assert.ok(permissions.textContent?.includes('Files'));assert.ok(button(permissions,'Revoke'));assert.ok(button(permissions,'Confirm change'))
 const event=permissions.querySelector<HTMLSelectElement>('[aria-label="events.fire permission"]')!;assert.equal(event.value,'deny')
 await inAct(async()=>{event.value='allow';event.dispatchEvent(new Event('change',{bubbles:true}));await tick()})
 assert.ok(calls.some(c=>c.action==='permission_set'&&c.app==='notes'&&c.capability==='events.fire'&&c.permission==='allow'))
 assert.equal(calls.some(c=>c.action==='panel_open'||c.action==='panel_update'),false,'app management never opens or mutates a copy')
})

test('closed saved-panel row has its own gear and edits exactly that copy without opening HTML',async t=>{
 const {openMenu,calls}=await setup(t,'settings-closed');await openMenu()
 const gear=document.querySelector<HTMLButtonElement>('.custom-apps-saved-row [aria-label="Settings for Closed notes"]');assert.equal(!!gear,true,'each closed panel needs an independent settings gear')
 await inAct(async()=>{gear!.click();await tick()});const settings=dialog('Panel settings')!;assert.ok(!!settings)
 assert.match(settings.textContent!,/Closed notes/);assert.equal(!!button(settings,'Export app'),false);assert.equal(!!button(settings,'Delete app…'),false);assert.equal(!!button(settings,'Permissions…'),false)
 // User 2026-10-26: "and make state its own tab".
 await inAct(async()=>{button(settings,'State').click();await tick()})
 assert.equal(JSON.parse(settings.querySelector<HTMLTextAreaElement>('[role="tabpanel"]:not([hidden]) [aria-label="Panel JSON state"]')!.value).note,'two')
 // User 2026-10-26: "make rename work the same way renaming agents does" (the Agent settings Name row).
 const input=settings.querySelector<HTMLInputElement>('input[aria-label="Panel name"]')!;await inAct(async()=>{const setter=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value')!.set!;setter.call(input,'Renamed closed copy');input.dispatchEvent(new Event('input',{bubbles:true}));await tick()})
 await inAct(async()=>{button(settings,'Rename').click();await tick()})
 assert.ok(calls.some(c=>c.action==='panel_update'&&c.panel==='two'&&c.label==='Renamed closed copy'))
 assert.equal(calls.some(c=>c.action==='panel_open'||c.action==='session_open'||c.action==='session_init'),false,'closed-panel settings never instantiate app HTML')
})

test('open-panel header gear opens panel-only settings with every retained copy action',async t=>{
 const {view,calls}=await setup(t,'settings-open',true)
 await inAct(async()=>{view.el.querySelector<HTMLButtonElement>('[data-custom-panel="one"] [aria-label="Settings for First notes"]')!.click();await tick()})
 const settings=dialog('Panel settings');assert.equal(!!settings,true,'header gear must open per-panel settings')
 // User 2026-10-26: "put connections and fire event on their own tabs" and "make history the last tab".
 // User 2026-10-26: "and make state its own tab" (General · State · Connections · Fire event · History).
 assert.deepEqual([...settings!.querySelectorAll('[role="tab"]')].map(e=>e.textContent),['General','State','Connections','Fire event','History'])
 for(const name of ['Duplicate','Delete panel…'])assert.ok(!!button(settings!,name),'missing '+name)
 for(const name of ['State…','Rename…'])assert.equal(!!button(settings!,name),false,'no separate dialog for '+name)
 // User 2026-10-26: links, Activity, the Events dialog and placement left Panel settings.
 for(const name of ['Linked agents…','Activity…','Events…','Float','Pin to screen','Pin to canvas'])assert.equal(!!button(settings!,name),false,'removed '+name)
 assert.equal(!!button(settings!,'Permissions…'),false);assert.equal(!!button(settings!,'Delete app…'),false)
 const visible=()=>settings!.querySelector<HTMLElement>('[role="tabpanel"]:not([hidden])')!
 await inAct(async()=>{button(settings!,'History').click();await tick()})
 assert.ok(calls.some(c=>c.action==='events'&&c.panel==='one'),'History reads the copy log')
 assert.equal(calls.some(c=>c.action==='listeners'),false,'History holds only the event history')
 await inAct(async()=>{button(settings!,'Connections').click();await tick()})
 assert.ok(calls.some(c=>c.action==='listeners'&&c.panel==='one'))
 assert.equal(!!visible().querySelector('.custom-app-history'),false,'connections are listed without the history')
 await inAct(async()=>{button(settings!,'Fire event').click();await tick()})
 assert.ok(visible().querySelector('[aria-label="Declared event"]'),'Fire event has its own tab')
 assert.equal(calls.some(c=>c.action==='fire_event'),false,'viewing connections never fires')
 await inAct(async()=>{button(settings!,'General').click();await tick();button(settings!,'Delete panel…').click();await tick()})
 assert.equal(dialog('Delete panel')!.classList.contains('custom-app-confirm'),true,'Delete panel is a compact confirmation')
 await inAct(async()=>{button(dialog('Delete panel')!,'Cancel').click();await tick()});assert.equal(calls.some(c=>c.action==='panel_delete'),false)
 for(const name of ['State','Connections','Fire event','History']){await inAct(async()=>{button(settings!,name).click();await tick()});assert.equal(visible().querySelectorAll('.set-group-head').length,0,name+' repeats no section header')}
})

test('panel rename works like agent rename: a Name field above the tabs, Rename once it differs, a toast, and the window closes',async t=>{
 // User 2026-10-26: "make rename work the same way renaming agents does": the Agent settings Name row (input, a Rename button shown
 // only after the text differs, no Enter submit, engine validation surfaced as an error toast, and the window closes with a toast).
 const toasts:string[][]=[],{view,calls}=await setup(t,'settings-rename',true,lines=>{toasts.push(lines??[])})
 await inAct(async()=>{view.el.querySelector<HTMLButtonElement>('[data-custom-panel="one"] [aria-label="Settings for First notes"]')!.click();await tick()})
 const settings=dialog('Panel settings')!,input=settings.querySelector<HTMLInputElement>('input[aria-label="Panel name"]')!
 assert.equal(input.value,'First notes');assert.equal(input.closest('[role="tabpanel"]'),null,'the Name row heads the window, outside the tabs')
 assert.equal((input.compareDocumentPosition(settings.querySelector('[role="tablist"]')!)&window.Node.DOCUMENT_POSITION_FOLLOWING)!==0,true,'the Name row sits above the tab row')
 assert.equal(!!button(settings,'Rename'),false,'Rename shows only once the text differs')
 const type=async(value:string)=>inAct(async()=>{Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value')!.set!.call(input,value);input.dispatchEvent(new Event('input',{bubbles:true}));await tick()})
 await type('   ');await inAct(async()=>{button(settings,'Rename').click();await tick()})
 assert.deepEqual(toasts.at(-1),['error: panel label must not be blank']);assert.ok(dialog('Panel settings'),'a refused rename keeps the window open')
 await type('Morning notes');assert.ok(button(settings,'Rename'))
 await inAct(async()=>{input.dispatchEvent(new window.KeyboardEvent('keydown',{key:'Enter',bubbles:true}));await tick()})
 assert.equal(calls.some(c=>c.action==='panel_update'&&c.label==='Morning notes'),false,'as in agent rename, Enter does not submit')
 await inAct(async()=>{button(settings,'Rename').click();await tick()})
 assert.ok(calls.some(c=>c.action==='panel_update'&&c.panel==='one'&&c.label==='Morning notes'&&c.expected_rev===1))
 assert.deepEqual(toasts.at(-1),['renamed First notes → Morning notes']);assert.equal(dialog('Panel settings'),null,'a rename closes the window, as agent rename does')
})

test('State is its own Panel settings tab: the JSON edits in place, saves with its revision and reloads',async t=>{
 const {view,calls}=await setup(t,'settings-state',true)
 await inAct(async()=>{view.el.querySelector<HTMLButtonElement>('[data-custom-panel="one"] [aria-label="Settings for First notes"]')!.click();await tick()})
 const settings=dialog('Panel settings')!;await inAct(async()=>{button(settings,'State').click();await tick()})
 const tab=settings.querySelector<HTMLElement>('[role="tabpanel"]:not([hidden])')!,area=tab.querySelector<HTMLTextAreaElement>('textarea[aria-label="Panel JSON state"]')!
 assert.equal(JSON.parse(area.value).note,'one');assert.equal(document.querySelectorAll('[role="dialog"]').length,1,'no separate state dialog')
 for(const name of ['Import','Export','Copy','Reset','Reload','Save'])assert.ok(tab.textContent?.includes(name),'missing '+name)
 await inAct(async()=>{Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value')!.set!.call(area,'{"note":"edited"}');area.dispatchEvent(new Event('input',{bubbles:true}));await tick()})
 await inAct(async()=>{button(tab,'Save').click();await tick()})
 assert.deepEqual(calls.find(c=>c.action==='state_set'),{action:'state_set',panel:'one',expected_rev:1,state:{note:'edited'}})
 assert.ok(dialog('Panel settings'),'saving keeps the tab open');assert.match(tab.textContent!,/Saved\./)
 const reads=calls.filter(c=>c.action==='panel_get').length;await inAct(async()=>{button(tab,'Reload').click();await tick()})
 assert.equal(calls.filter(c=>c.action==='panel_get').length,reads+1,'Reload reads the saved state again')
})
