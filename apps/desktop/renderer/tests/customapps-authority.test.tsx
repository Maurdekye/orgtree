import {flush,inAct,mountView} from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import {AppPermissions} from '../src/canvas/apps/permissions'
import {AppImport} from '../src/canvas/apps/portable'
const tick=async()=>{for(let i=0;i<4;i++)await flush()}
test('Permissions distinguishes implicit org defaults from explicit Deny and outside-file consent',async t=>{
 const app={id:'a',name:'Notes',description:'',rev:1,width:400,height:300,capabilities:['org.read','events.fire','docket.write','files.read','files.write'],permissions:{'docket.write':'deny'},default_permissions:{'org.read':'allow','events.fire':'allow','docket.write':'allow','files.read':'allow','files.write':'allow'},origin:'created',created_by:'maker',updated_at:''}
 const old=globalThis.fetch;globalThis.fetch=async()=>new Response(JSON.stringify({grants:[],items:[],rev:1,permission_rev:1}));t.after(()=>{globalThis.fetch=old})
 const view=await mountView(<AppPermissions slug="default-permissions" app={app} close={()=>{}}/>,e=>e);t.after(()=>view.unmount());await inAct(tick)
 assert.equal(document.querySelector<HTMLSelectElement>('[aria-label="org.read permission"]')!.value,'allow','org capability should display the implicit default')
 assert.equal(document.querySelector<HTMLSelectElement>('[aria-label="docket.write permission"]')!.value,'deny','explicit Deny overrides default')
 assert.equal(document.querySelector<HTMLSelectElement>('[aria-label="Files write permission"]')!.value,'allow')
 assert.match(document.body.textContent!,/Orgtree files.*default|default.*Orgtree files/s)
 assert.match(document.body.textContent!,/Chosen folders|chosen folders/)
})
test('whole-app import warns about full org authority without running the imported HTML',async t=>{
 const view=await mountView(<AppImport slug="import-warning" bundle={{format:'orgtree-app',version:1,definition:{name:'Outside editor',description:'',html:'<p>Untrusted editor</p>',initial_state:{},capabilities:[],width:400,height:300},panels:[]}} close={()=>{}}/>,e=>e);t.after(()=>view.unmount())
 assert.match(view.el.textContent!,/full access.*org|full access.*organization/i)
 assert.match(view.el.textContent!,/untrustworthy/i)
 assert.equal(view.el.querySelector('iframe'),null)
})
test('the import preview labels the app, names what still asks first and counts copies without a capability list',async t=>{
 // USER 2026-10-26: created and imported apps hold org authority whatever they declare (engine policy.rs), so a
 // declared-capability list beside the full-access warning misleads; only outside files still ask first.
 const definition={name:'Org notes',description:'',html:'<p>Notes</p>',initial_state:{},capabilities:[],width:400,height:300}
 const mount=async(panels:{label:string;state:Record<string,unknown>}[])=>{const view=await mountView(<AppImport slug="import-preview" bundle={{format:'orgtree-app',version:1,definition,panels}} close={()=>{}}/>,e=>e);t.after(()=>view.unmount());return view}
 const none=await mount([]),text=none.el.textContent!
 assert.equal(/requested capabilities/i.test(text),false,'declared capabilities grant nothing extra, so the preview does not list them')
 assert.equal(/still asks before reading or changing files outside this org/i.test(text),true,'the preview names what still asks for consent')
 assert.equal(text.includes('Name: Org notes'),true,'the app name is labelled, not a bare heading')
 assert.equal([...none.el.querySelectorAll('p')].filter(p=>!p.textContent!.trim()).length,0,'an empty description leaves no blank paragraph')
 assert.equal(text.includes('No saved copies.'),true)
 const one=await mount([{label:'Draft',state:{}}]);assert.equal(one.el.textContent!.includes('1 saved copy.'),true)
 const two=await mount([{label:'A',state:{}},{label:'B',state:{}}]);assert.equal(two.el.textContent!.includes('2 saved copies.'),true)
})
