import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import {createRequire} from 'node:module'
const req=createRequire(process.env.ORGTREE_TEST_DEPS||import.meta.url)
const {buildSync}=req('esbuild')
function load(file){const module={exports:{}};vm.runInNewContext(buildSync({entryPoints:[file],bundle:true,write:false,platform:'node',format:'cjs'}).outputFiles[0].text,{module,exports:module.exports,require:req,Buffer});return module.exports}
const list=load('apps/desktop/main/jumplist.ts'),policy=load('apps/desktop/main/policy.ts')
const plain=x=>JSON.parse(JSON.stringify(x))
const row=(kind,id,extra={})=>({kind,id,org:'alpha',title:'A title',body:'Details',agent:'helper',source_id:'source',...extra})
const notices=[row('routine','mail:a'),row('question','ask:q'),row('work-attention','work:w:1',{item:'ticket'}),row('mention','mention:m')]
const feed={allNotices:()=>[...notices,row('document','doc:d'),row('agent-frozen','frozen:f'),null,{}]}

test('attention menu replaces Recent with every actionable item and restores Recent when empty',()=>{
 const entries=list.taskbarAttention(feed)
 assert.equal(entries.length,4)
 const cats=list.taskbarTasks([{slug:'alpha',name:'Alpha'}],'C:/App.exe',undefined,{mail:'mail.ico',ticket:'ticket.ico',mention:'mention.ico'},entries)
 assert.equal(cats[0].name,'Needs attention');assert.equal(cats[0].items.length,4)
 assert.deepEqual(plain(cats[0].items.map(x=>x.iconPath)),['mail.ico','mail.ico','ticket.ico','mention.ico'])
 assert.equal(cats[1].type,'tasks');assert.equal(cats[1].items.length,2)
 assert.equal(list.taskbarTasks([{slug:'alpha',name:'Alpha'}],'C:/App.exe',undefined,{},[])[0].name,'Recent')
})
test('menu launch arguments round trip only the org and opaque notice identity',()=>{
 for(const entry of list.taskbarAttention(feed)){
  const item=list.taskbarTasks([],'C:/App.exe',undefined,{},[entry])[0].items[0]
  assert.match(item.args,/^--orgtree-taskbar=attention:[A-Za-z0-9_-]+$/)
  assert.deepEqual(plain(list.taskbarTarget([item.args])),{kind:'attention',org:entry.org,id:entry.id})
 }
 for(const data of ['ab',['../escape','id'],['alpha',''],['alpha','x'.repeat(201)],['alpha','id','extra'],{org:'alpha',id:'id'}]){
  assert.equal(list.taskbarTarget(['--orgtree-taskbar=attention:'+Buffer.from(JSON.stringify(data)).toString('base64url')]),null)
 }
 assert.equal(list.taskbarTarget(['--orgtree-taskbar=attention:%%%']),null)
})
test('attention inventory is deduplicated and rejects unsafe and incomplete destinations',()=>{
 const rows=[...notices,notices[0],row('question','q',{agent:undefined}),row('work-attention','w',{item:undefined}),row('mention','m',{agent:undefined}),row('routine','bad',{org:'../escape'})]
 assert.equal(list.taskbarAttention({allNotices:()=>rows}).length,4)
})
test('question destination defaults to the desk and accepts only the two saved choices',()=>{
 assert.equal(policy.DEFAULT_PREFERENCES.questionTarget,'desk')
 for(const value of ['desk','mail'])assert.equal(policy.preferencesPatch({questionTarget:value}).questionTarget,value)
 for(const value of ['canvas','',null,1])assert.throws(()=>policy.preferencesPatch({questionTarget:value}))
})
test('taskbar activation bypasses banner preferences but revalidates the current item',()=>{
 const s=fs.readFileSync('apps/desktop/renderer/src/notifications.ts','utf8')
 assert.match(s,/onHeldEvent\('taskbar-attention'/)
 assert.match(s,/current\.kind === 'mention'/)
 assert.match(s,/questionTarget !== 'mail'/)
 const main=fs.readFileSync('apps/desktop/main/index.ts','utf8')
 assert.match(main,/revealOrgItem\(target\.org, \{ type: 'taskbar-attention'/)
 assert.match(main,/taskbarAttention\(appFeed\.state\)/)
})
test('taskbar desk focus prefers an existing pin or detached desk before Attention view',()=>{
 const s=fs.readFileSync('apps/desktop/renderer/src/canvas/OrgCanvas.tsx','utf8')
 assert.match(s,/focusAgentDesk/)
 const effect=s.slice(s.indexOf('if (!focusAgent) return'),s.indexOf('if (!focusAgent) return')+1700)
 assert.ok(effect.indexOf('showPin(')<effect.indexOf('centerOn('))
 assert.ok(effect.indexOf('revealExistingDesk(')<effect.indexOf('centerOn('))
})
test('mentions join the native notice projection using the existing duplicate-mail exclusion',()=>{
 const s=fs.readFileSync('engine/rs/orgtree-engine/src/domain/notices.rs','utf8')
 assert.match(s,/"kind": "mention"/)
 assert.match(s,/let mentions = all_rows/)
 assert.match(s,/a\.state = 'live'.*user_mention/s)
 assert.ok((s.match(/DUPLICATE_MENTION_SQL/g)||[]).length>=2)
})
test('attention menu glyphs are distinct PNGs generated in the owned icon cache',()=>{
 const {actionPng}=load('apps/desktop/main/jumplist-icons.ts')
 const icons=['mail','ticket','mention'].map(kind=>actionPng(kind))
 assert.equal(new Set(icons.map(x=>x.toString('base64'))).size,3)
 for(const png of icons){assert.equal(png.subarray(0,8).toString('hex'),'89504e470d0a1a0a');assert.equal(png.readUInt32BE(16),64)}
})
