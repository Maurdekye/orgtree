import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {createRequire} from 'node:module'
const require=createRequire(process.env.ORGTREE_TEST_DEPS||import.meta.url),{buildSync}=require('esbuild')
const scope=process.env.ORGTREE_BADGE_TEST_ROOT
assert.match(scope||'',/^C:[\\/]orgtree-build[\\/]taskbar-orgs-sol[\\/]/i)
fs.mkdirSync(scope,{recursive:true});const temp=fs.mkdtempSync(path.join(scope,'unified-'))
buildSync({entryPoints:['apps/desktop/main/taskbar-attention.ts','apps/desktop/main/taskbar-badge.ts'],outdir:temp,entryNames:'[name]',outExtension:{'.js':'.cjs'},bundle:true,platform:'node',format:'cjs'})
const {TaskbarAttention}=require(path.join(temp,'taskbar-attention.cjs')),{TaskbarDot}=require(path.join(temp,'taskbar-badge.cjs'))
test.after(()=>{assert.ok(fs.realpathSync(temp).toLowerCase().startsWith(fs.realpathSync(scope).toLowerCase()+path.sep));fs.rmSync(temp,{recursive:true,force:true})})
const feed=(total,notices=[])=>({attentionTotal:()=>total,allNotices:()=>notices})
function fixture(){
 const flashes=[],overlays=[],w={isDestroyed:()=>false,isFocused:()=>false,flashFrame:v=>flashes.push(v),setOverlayIcon:v=>overlays.push(v)}
 const badge=new TaskbarDot({platform:'win32',windows:()=>[w],dot:()=> 'dot'})
 return {attention:new TaskbarAttention(()=>w,badge),w,flashes,overlays}
}
test('one attention controller owns unread badge state while reusing the existing per-org pulse',()=>{
 const {attention,w,flashes,overlays}=fixture()
 attention.updateInventory(feed(0,[{kind:'routine'}]))
 assert.deepEqual(overlays,['dot']);assert.deepEqual(flashes,[],'routine unread mail does not add a pulse policy')
 attention.set([{org:'alpha',id:'question'}]);assert.deepEqual(flashes,[true])
 attention.focused(w);attention.updateInventory(feed(1));assert.deepEqual(overlays,['dot'],'focus does not consume unread/attention state')
 attention.set([{org:'alpha',id:'question'}]);assert.deepEqual(flashes,[true],'the same question never restarts the pulse')
 attention.updateInventory(feed(0));assert.deepEqual(overlays,['dot',null])
})
test('new windows inherit the badge through the existing controller',()=>{
 const {attention,overlays}=fixture(),fresh=[]
 attention.updateInventory(feed(1));attention.applyBadge({isDestroyed:()=>false,setOverlayIcon:v=>fresh.push(v)})
 assert.deepEqual(fresh,['dot']);assert.deepEqual(overlays,['dot'])
})
test('shipping host calls an unshadowed inventory projection and one attention controller',()=>{
 const source=fs.readFileSync('apps/desktop/main/index.ts','utf8')
 assert.match(source,/type TaskbarAttentionItem/)
 assert.match(source,/taskbarAttentionItems\(appFeed\.state\)/)
 assert.match(source,/taskbarAttention\.updateInventory\(appFeed\.state\)/)
 assert.match(source,/taskbarAttention\.applyBadge\(window\)/)
 assert.doesNotMatch(source,/const taskbarDot =/)
 assert.match(source,/taskbarAttention\.set\(attentionPayload\(ids, items\)\)/)
})
