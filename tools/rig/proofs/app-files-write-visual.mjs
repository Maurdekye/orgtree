// Production native UI, synthetic caption video and confirmed file changes.
import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import {spawnSync} from 'node:child_process'
import {setup as captionFixture} from './app-files.mjs'
import {REPO,electronExe} from '../lib.mjs'
const out=path.join(process.env.ORGTREE_RIG_HOME,'..','visual'),folder=path.join(process.env.ORGTREE_RIG_HOME,'write-visual',process.pid+'-'+Date.now(),'chosen')
export function setup(){
  const base=captionFixture();fs.mkdirSync(folder,{recursive:true});fs.writeFileSync(path.join(folder,'existing.txt'),'original synthetic bytes')
  base.fixture.agents.push({name:'writer',tier:'sol',grant:0,add_dirs:[{path:folder,mode:'rw'}],charter:'Synthetic native confirmation only.'})
  return{...base,ui:path.join(out,'ui')}
}
export default async function(rig){
  const root='/api/orgs/'+rig.org,apps=input=>rig.api('POST',root+'/apps',input)
  await rig.api('POST',root+'/settings',{org_dirs:[{path:folder,mode:'rw'}]});await rig.api('POST',root+'/nodes/writer/scope',{add_dirs:[{path:folder,mode:'rw'}]})
  const shield=`<script>window.__clipboardCalls=[];Object.defineProperty(navigator,'clipboard',{value:Object.freeze(Object.fromEntries(['read','readText','write','writeText'].map(name=>[name,()=>{window.__clipboardCalls.push(name);return Promise.reject(Error('Clipboard denied'))}])))});</script>`
  const bundle=JSON.parse(fs.readFileSync(process.env.APP_FILES_CAPTION_BUNDLE,'utf8')),app=await apps({action:'app_create',definition:{...bundle.definition,html:shield+bundle.definition.html}}),label='Synthetic first cut'
  const panel=await apps({action:'panel_open',app:app.id,new:true,label})
  const html=shield+`<style>body{margin:20px;background:#171a21;color:#e6e7eb;font:14px 'Segoe UI',sans-serif}button{background:#292f3b;color:inherit;border:1px solid #555f70;border-radius:6px;padding:9px;margin:4px}p{line-height:1.6}#result{white-space:pre-wrap}</style><h2>Synthetic file editor</h2><p>Use native Orgtree permissions to browse and change synthetic files.</p><button id="read-folder">Read folder</button><button id="computer">Whole computer</button><button id="write-folder">Write folder</button><button id="create">Create file</button><button id="replace">Replace file</button><button id="delete">Delete file</button><p id="result">Ready</p><script>
  const show=text=>document.getElementById('result').textContent=text;
  const run=(id,fn)=>document.getElementById(id).onclick=()=>Promise.resolve().then(fn).catch(e=>show('Error: '+e.message));
  run('read-folder',async()=>{const grant=await orgtree.files.grant('folder','read');window.__directory=grant.roots[0].id;await orgtree.state.patch({directory:window.__directory});show('Read folder ready')});
  run('computer',async()=>{await orgtree.files.grant('computer','read');show('Computer ready')});
  run('write-folder',async()=>{await orgtree.files.grant('folder','write');show('Write folder ready')});
  run('create',async()=>{window.__outcome=await orgtree.files.write(window.__directory,'visual.txt',btoa('Synthetic created bytes'));show(window.__outcome.changed?'Created':'Create cancelled')});
  run('replace',async()=>{window.__outcome=await orgtree.files.write(window.__directory,'existing.txt',btoa('Synthetic replacement bytes'),{replace:true});show(window.__outcome.changed?'Replaced':'Replace cancelled')});
  run('delete',async()=>{const file=await orgtree.files.child(window.__directory,'visual.txt');window.__outcome=await orgtree.files.delete(file.id);show(window.__outcome.changed?'Deleted':'Delete cancelled')});
  </script>`
  const editor=await apps({action:'app_create',definition:{name:'Synthetic file editor',html,capabilities:['files.read','files.write'],width:660,height:480}})
  const editorPanel=await apps({action:'panel_open',app:editor.id,new:true,label:'Synthetic file changes'});await apps({action:'panel_update',panel:editorPanel.id,expected_rev:editorPanel.rev,open:false})
  const config=path.join(out,'config.json');fs.writeFileSync(config,JSON.stringify({origin:rig.url,token:rig.token,org:rig.org,app:app.id,panel:panel.id,label,folder:path.join(process.env.ORGTREE_RIG_HOME,'files-fixture'),editor:editor.id,editorPanel:editorPanel.id,editorFolder:folder}))
  const args=path.join(out,'capture.args');fs.writeFileSync(args,[process.env.APP_FILES_VISUAL_DRIVER,config].join('\r\n'))
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE
  const run=spawnSync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(REPO,'apps/desktop/renderer/tests/joblimit.ps1'),'-LimitMB','3072','-TimeoutSec','130','-WorkDir',REPO,'-Exe',electronExe(),'-ArgFile',args],{encoding:'utf8',windowsHide:true,env,timeout:150000})
  fs.writeFileSync(path.join(out,'capture.log'),(run.stdout??'')+(run.stderr??''));const receipt=JSON.parse(fs.readFileSync(path.join(out,'receipt.json'),'utf8'))
  assert.equal(run.status,0,receipt.error??run.stderr);assert.equal(receipt.ok,true)
  assert.equal(fs.readFileSync(path.join(folder,'existing.txt'),'utf8'),'Synthetic replacement bytes');assert(!fs.existsSync(path.join(folder,'visual.txt')));assert.equal(fs.readFileSync(path.join(folder,'agent-native.txt'),'utf8'),'Native approved agent bytes')
  return{proof:'app-files-write-visual',passed:true,evidence:out,pid:receipt.pid,session:receipt.sessionId,shots:receipt.shots}
}
