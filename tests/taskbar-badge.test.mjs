import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {createRequire} from 'node:module'
import {build} from 'esbuild'

const scope=process.env.ORGTREE_BADGE_TEST_ROOT
assert.match(scope||'',/^C:[\\/]orgtree-build[\\/]taskbar-orgs-sol[\\/]/i)
fs.mkdirSync(scope,{recursive:true})
const temp=fs.mkdtempSync(path.join(scope,'unit-'))
await build({entryPoints:['apps/desktop/main/taskbar-badge.ts','packages/contracts/app-feed.ts'],outdir:temp,entryNames:'[name]',outExtension:{'.js':'.cjs'},bundle:true,platform:'node',format:'cjs'})
const require=createRequire(import.meta.url)
const {TaskbarDot,needsTaskbarDot}=require(path.join(temp,'taskbar-badge.cjs'))
const {AppFeedState}=require(path.join(temp,'app-feed.cjs'))
test.after(()=>{assert.ok(fs.realpathSync(temp).toLowerCase().startsWith(fs.realpathSync(scope).toLowerCase()+path.sep));fs.rmSync(temp,{recursive:true,force:true})})
const feed=(attention=0,notices=[])=>({attentionTotal:()=>attention,allNotices:()=>notices})
function window(){return {destroyed:false,calls:[],isDestroyed(){return this.destroyed},setOverlayIcon(image,description){this.calls.push({image,description})}}}
function windowsDot(windows){let images=0;return {controller:new TaskbarDot({platform:'win32',windows:()=>windows,dot:()=>{images++;return 'dot'}}),images:()=>images}}

test('ordinary unread user mail lights the dot without a notification preference',()=>{
  for(const kind of ['routine','urgent-mail','terminal-failure'])assert.equal(needsTaskbarDot(feed(0,[{kind}])),true,kind)
})
test('existing questions docket attention and mention totals light the dot',()=>{
  assert.equal(needsTaskbarDot(feed(1)),true)
  for(const kind of ['question','work-attention','mention'])assert.equal(needsTaskbarDot(feed(0,[{kind}])),true)
})
test('documents frozen agents malformed entries and an empty inventory do not invent attention',()=>{
  assert.equal(needsTaskbarDot(feed(0,[null,{},[],{kind:'document'},{kind:'agent-frozen'}])),false)
  assert.equal(needsTaskbarDot(feed()),false)
})
test('shared app feed notices in another active org count and trashed orgs stop counting',()=>{
  const state=new AppFeedState(),org={org_id:2,org_uuid:'uuid2',slug:'other',state:'active'}
  const registry={type:'registry_snapshot',epoch:'e',cursor:{app_uuid:'app',incarnation:'i',rev:1},records:[{entity:'registry_org',id:'2',body:org}]}
  state.apply({type:'app_snapshot',epoch:'e',seq:1,registry,summaries:{},notices:{2:{type:'org_notices',epoch:'e',seq:1,org_id:2,org_uuid:'uuid2',incarnation:'i',rev:1,notices:[{kind:'routine'}]}},runtime:{values:{},orgs:{}}},true)
  assert.equal(needsTaskbarDot(state),true)
  state.apply({...registry,cursor:{...registry.cursor,rev:2},records:[{entity:'registry_org',id:'2',body:{...org,state:'trashed'}}]})
  assert.equal(needsTaskbarDot(state),false)
})
test('Windows overlays every live app window and persists when one is focused',()=>{
  const a=window(),b=window(),{controller}=windowsDot([a,b])
  controller.set(true)
  for(const w of [a,b]){assert.deepEqual(w.calls.map(c=>c.image),['dot']);assert.match(w.calls[0].description,/unread|attention/i)}
  controller.apply(a)
  assert.equal(a.calls.length,1,'focus/reapplying does not consume unread state')
})
test('unchanged feed updates do not touch native state or regenerate the image',()=>{
  const w=window(),{controller,images}=windowsDot([w]);controller.set(true)
  for(let i=0;i<5;i++)controller.set(true)
  assert.equal(w.calls.length,1);assert.equal(images(),1)
})
test('a new window immediately receives the current active dot',()=>{
  const existing=window(),fresh=window(),{controller}=windowsDot([existing]);controller.set(true);controller.apply(fresh)
  assert.deepEqual(fresh.calls.map(c=>c.image),['dot'])
})
test('clearing mail leaves the dot while existing attention remains then clears it',()=>{
  const w=window(),{controller}=windowsDot([w])
  controller.set(needsTaskbarDot(feed(1,[{kind:'routine'}])))
  controller.set(needsTaskbarDot(feed(1)))
  assert.deepEqual(w.calls.map(c=>c.image),['dot'])
  controller.set(needsTaskbarDot(feed()))
  assert.deepEqual(w.calls.map(c=>c.image),['dot',null]);assert.equal(w.calls[1].description,'')
})
test('macOS uses a persistent dock dot and clears on zero without duplicate writes',()=>{
  const calls=[],controller=new TaskbarDot({platform:'darwin',windows:()=>[],dot:()=>assert.fail('no Windows image on macOS'),dockBadge:v=>calls.push(v)})
  controller.set(true);controller.set(true);controller.set(false)
  assert.deepEqual(calls,['•',''])
})
test('Linux uses the available platform badge API and clears on zero',()=>{
  const calls=[],controller=new TaskbarDot({platform:'linux',windows:()=>[],dot:()=>assert.fail('no Windows image on Linux'),badgeCount:v=>calls.push(v)})
  controller.set(true);controller.set(true);controller.set(false)
  assert.deepEqual(calls,[1,0])
})
test('destroyed windows are skipped without touching their shell state',()=>{
  const w=window();w.destroyed=true;const {controller}=windowsDot([w]);controller.set(true);controller.apply(w);assert.deepEqual(w.calls,[])
})
test('an unavailable platform badge does not break feed delivery',()=>{
  const controller=new TaskbarDot({platform:'linux',windows:()=>[],dot:()=>null,badgeCount:()=>{throw Error('unsupported desktop')}})
  assert.doesNotThrow(()=>controller.set(true))
  assert.doesNotThrow(()=>controller.set(false))
})
test('one window closing during an overlay write cannot block the other windows',()=>{
  const gone=window(),live=window();gone.setOverlayIcon=()=>{throw Error('window closed')}
  const {controller}=windowsDot([gone,live]);assert.doesNotThrow(()=>controller.set(true));assert.deepEqual(live.calls.map(c=>c.image),['dot'])
})
test('central current app-feed changes and new windows are wired to the dot',()=>{
  const source=fs.readFileSync('apps/desktop/main/index.ts','utf8')
  const update='taskbarAttention.updateInventory(appFeed.state)'
  assert.equal(source.includes(update),true)
  assert.ok(source.indexOf(update)<source.indexOf('const next = JSON.stringify(appFeed.state.allNotices())'),'badge update precedes the notice short circuit')
  assert.equal(source.includes('taskbarAttention.applyBadge(window)'),true)
  assert.equal(source.includes('taskbarAttention.applyBadge(child)'),true)
})
