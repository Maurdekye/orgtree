import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {createRequire} from 'node:module'
const require=createRequire(process.env.ORGTREE_TEST_DEPS||import.meta.url),{buildSync}=require('esbuild')
const scope=process.env.ORGTREE_BADGE_TEST_ROOT
assert.match(scope||'',/^C:[\\/]orgtree-build[\\/]taskbar-orgs-sol[\\/]/i)
fs.mkdirSync(scope,{recursive:true});const temp=fs.mkdtempSync(path.join(scope,'eligibility-'))
buildSync({entryPoints:['apps/desktop/main/taskbar-badge.ts','apps/desktop/main/jumplist.ts','apps/desktop/main/taskbar-attention.ts','packages/contracts/app-feed.ts'],outdir:temp,entryNames:'[name]',outExtension:{'.js':'.cjs'},bundle:true,platform:'node',format:'cjs'})
const {TaskbarDot,needsTaskbarDot}=require(path.join(temp,'taskbar-badge.cjs'))
const {TaskbarAttention}=require(path.join(temp,'taskbar-attention.cjs'))
const {taskbarAttentionItems,taskbarTasks}=require(path.join(temp,'jumplist.cjs'))
const {AppFeedState}=require(path.join(temp,'app-feed.cjs'))
test.after(()=>{assert.ok(fs.realpathSync(temp).toLowerCase().startsWith(fs.realpathSync(scope).toLowerCase()+path.sep));fs.rmSync(temp,{recursive:true,force:true})})
const row=(kind,id=kind)=>({kind,id,org:'other',agent:'helper',item:'ticket',title:kind})
const feed=(notices,total=0)=>({allNotices:()=>notices,attentionTotal:()=>total})
const menu=state=>taskbarTasks([{slug:'other',name:'Other'}],'synthetic.exe',undefined,{},taskbarAttentionItems(state))

test('ordinary unread mail alone leaves the dot off and the Recent menu intact',()=>{
 const state=feed([row('routine')])
 assert.equal(needsTaskbarDot(state),false)
 assert.deepEqual(taskbarAttentionItems(state),[])
 assert.equal(menu(state)[0].name,'Recent')
})

test('urgent mail questions ticket flags and mentions each light the dot and supply their menu icon',()=>{
 for(const [kind,icon] of [['urgent-mail','mail'],['question','mail'],['work-attention','ticket'],['mention','mention']]){
  const state=feed([row(kind)])
  assert.equal(needsTaskbarDot(state),true,kind)
  const entries=taskbarAttentionItems(state)
  assert.equal(entries.length,1,kind);assert.equal(entries[0].icon,icon,kind)
  assert.equal(menu(state)[0].name,'Needs attention',kind)
 }
})

test('mixed inventories expose only the attention-seeking items in the menu',()=>{
 const kinds=['urgent-mail','question','work-attention','mention']
 const state=feed([row('routine'),...kinds.map(kind=>row(kind)),row('document'),row('agent-frozen')])
 assert.deepEqual(taskbarAttentionItems(state).map(entry=>entry.id),kinds)
 assert.equal(menu(state)[0].items.length,4)
})

test('resolving the final attention item clears the native dot and restores Recent while ordinary mail remains unread',()=>{
 const state=new AppFeedState(),org={org_id:2,org_uuid:'uuid2',slug:'other',state:'active'}
 const registry={type:'registry_snapshot',epoch:'e',cursor:{app_uuid:'app',incarnation:'i',rev:1},records:[{entity:'registry_org',id:'2',body:org}]}
 const frame={type:'org_notices',epoch:'e',seq:1,org_id:2,org_uuid:'uuid2',incarnation:'i',rev:1,notices:[row('routine'),row('question')]}
 state.apply({type:'app_snapshot',epoch:'e',seq:1,registry,summaries:{},notices:{2:frame},runtime:{values:{},orgs:{}}},true)
 const overlays=[],window={isDestroyed:()=>false,setOverlayIcon:image=>overlays.push(image)}
 const attention=new TaskbarAttention(()=>undefined,new TaskbarDot({platform:'win32',windows:()=>[window],dot:()=> 'dot'}))
 attention.updateInventory(state);assert.equal(menu(state)[0].name,'Needs attention')
 state.apply({...frame,seq:2,rev:2,notices:[row('routine')]})
 attention.updateInventory(state)
 assert.deepEqual(overlays,['dot',null])
 assert.equal(state.allNotices().length,1,'the ordinary unread row was not consumed')
 assert.equal(menu(state)[0].name,'Recent')
})

test('existing attention summary still lights the dot before its notice inventory arrives',()=>{
 assert.equal(needsTaskbarDot(feed([],1)),true)
 assert.equal(needsTaskbarDot(feed([],0)),false)
})
