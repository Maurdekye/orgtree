import {flush,inAct,mountView} from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import {AppPermissions} from '../src/canvas/apps/permissions'
import {AppImport} from '../src/canvas/apps/portable'
const tick=async()=>{for(let i=0;i<4;i++)await flush()}
test('Permissions distinguishes implicit org defaults from explicit Deny and outside-file consent',async t=>{
 const app={id:'a',name:'Notes',description:'',rev:1,width:400,height:300,capabilities:['org.read','mail.send','events.fire','docket.write','files.read','files.write'],permissions:{'mail.send':'deny'},default_permissions:{'org.read':'allow','mail.send':'allow','events.fire':'allow','docket.write':'allow','files.read':'allow','files.write':'allow'},origin:'created',created_by:'maker',updated_at:''}
 const old=globalThis.fetch;globalThis.fetch=async()=>new Response(JSON.stringify({grants:[],items:[],rev:1,permission_rev:1}));t.after(()=>{globalThis.fetch=old})
 const view=await mountView(<AppPermissions slug="default-permissions" app={app} close={()=>{}}/>,e=>e);t.after(()=>view.unmount());await inAct(tick)
 assert.equal(document.querySelector<HTMLSelectElement>('[aria-label="org.read permission"]')!.value,'allow','org capability should display the implicit default')
 assert.equal(document.querySelector<HTMLSelectElement>('[aria-label="mail.send permission"]')!.value,'deny','explicit Deny overrides default')
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
