import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createRequire } from 'node:module'
const scope=process.env.ORGTREE_NOTE_TEST_ROOT
assert.match(scope||'',/^C:[\\/]orgtree-build[\\/]taskbar-orgs-sol[\\/]/i)
await fs.mkdir(scope,{recursive:true})
const deps=createRequire(process.env.ORGTREE_TEST_DEPS),bundle=path.join(scope,'native.cjs')
await deps('esbuild').build({entryPoints:['apps/desktop/main/scratch-folder.ts'],outfile:bundle,bundle:true,platform:'node',format:'cjs'})
const {openAgentScratchAgentsFile}=createRequire(import.meta.url)(bundle)
let directory,echo='agent';const original=globalThis.fetch
globalThis.fetch=async()=>new Response(JSON.stringify({path:directory,scope:echo}),{headers:{'content-type':'application/json'}})
test.after(()=>{globalThis.fetch=original})
async function root(name){directory=path.join(scope,name);await fs.mkdir(directory);return directory}
const engine={origin:'http://127.0.0.1:43210',token:'synthetic'},opened=[]
const opener=async file=>{opened.push(file);return ''}
test('editing a missing note creates an empty root file for agent team and shared scopes without overwriting',async()=>{
 for(const kind of ['agent','team','shared']){
  await root(kind);echo=kind;const file=path.join(directory,'AGENTS.md')
  assert.deepEqual(await openAgentScratchAgentsFile(engine,'fixture',kind==='shared'?'':'worker',opener,kind),{ok:true})
  assert.equal(await fs.readFile(file,'utf8'),'')
  await fs.writeFile(file,'Keep these instructions')
  assert.deepEqual(await openAgentScratchAgentsFile(engine,'fixture',kind==='shared'?'':'worker',opener,kind),{ok:true})
  assert.equal(await fs.readFile(file,'utf8'),'Keep these instructions')
 }
})
test('concurrent first edits create one empty note and both open the same regular file',async()=>{
 await root('concurrent');echo='agent'
 const results=await Promise.all([1,2].map(()=>openAgentScratchAgentsFile(engine,'fixture','worker',opener)))
 assert.deepEqual(results,[{ok:true},{ok:true}]);assert.equal(await fs.readFile(path.join(directory,'AGENTS.md'),'utf8'),'')
})
test('a directory named AGENTS.md is never opened or replaced',async()=>{
 await root('directory-note');await fs.mkdir(path.join(directory,'AGENTS.md'));const count=opened.length
 assert.equal((await openAgentScratchAgentsFile(engine,'fixture','worker',opener)).ok,false)
 assert.equal(opened.length,count);assert.equal((await fs.stat(path.join(directory,'AGENTS.md'))).isDirectory(),true)
})
test('a hard-linked root note is refused without touching its external contents',async()=>{
 await root('hardlink-note');const external=path.join(scope,'external.md');await fs.writeFile(external,'Outside')
 await fs.link(external,path.join(directory,'AGENTS.md'));const count=opened.length
 assert.equal((await openAgentScratchAgentsFile(engine,'fixture','worker',opener)).ok,false)
 assert.equal(opened.length,count);assert.equal(await fs.readFile(external,'utf8'),'Outside')
})
test('junction roots and junction ancestors cannot redirect editing outside the exact folder',async()=>{
 const outside=path.join(scope,'outside');await fs.mkdir(outside);await fs.writeFile(path.join(outside,'AGENTS.md'),'Outside')
 const link=path.join(scope,'junction');await fs.symlink(outside,link,'junction');directory=link;const count=opened.length
 assert.equal((await openAgentScratchAgentsFile(engine,'fixture','worker',opener)).ok,false)
 await fs.mkdir(path.join(outside,'child'));await fs.writeFile(path.join(outside,'child','AGENTS.md'),'Child')
 directory=path.join(link,'child');assert.equal((await openAgentScratchAgentsFile(engine,'fixture','worker',opener)).ok,false)
 assert.equal(opened.length,count);assert.equal(await fs.readFile(path.join(outside,'AGENTS.md'),'utf8'),'Outside')
})
test('invalid scope and remote engine never create or open a note',async()=>{
 await root('invalid');const count=opened.length
 assert.equal((await openAgentScratchAgentsFile(engine,'fixture','worker',opener,'../shared')).ok,false)
 assert.equal((await openAgentScratchAgentsFile({...engine,origin:'https://remote.invalid'},'fixture','worker',opener)).ok,false)
 assert.equal(opened.length,count);assert.equal(await fs.stat(path.join(directory,'AGENTS.md')).then(()=>true,()=>false),false)
})
