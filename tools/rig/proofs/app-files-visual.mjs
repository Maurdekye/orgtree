// Production renderer/desktop policy against the isolated PG engine.
import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import {spawnSync} from 'node:child_process'
import {setup as fixture} from './app-files.mjs'
import {REPO,electronExe} from '../lib.mjs'
const out=path.join(process.env.ORGTREE_RIG_HOME,'..','visual')
export function setup(){return {...fixture(),ui:path.join(out,'ui')}}
export default async function(rig){
  const bundle=JSON.parse(fs.readFileSync(process.env.APP_FILES_CAPTION_BUNDLE,'utf8'))
  const shield=`<script>window.__clipboardCalls=[];Object.defineProperty(navigator,'clipboard',{value:Object.freeze(Object.fromEntries(['read','readText','write','writeText'].map(name=>[name,()=>{window.__clipboardCalls.push(name);return Promise.reject(Error('Clipboard denied'))}])))});</script>`
  const definition={...bundle.definition,html:shield+bundle.definition.html}
  const root='/api/orgs/'+rig.org,app=await rig.api('POST',root+'/apps',{action:'app_create',definition}),label='Synthetic first cut'
  const panel=await rig.api('POST',root+'/apps',{action:'panel_open',app:app.id,new:true,label})
  const config=path.join(out,'config.json');fs.writeFileSync(config,JSON.stringify({origin:rig.url,token:rig.token,org:rig.org,app:app.id,panel:panel.id,label,folder:path.join(process.env.ORGTREE_RIG_HOME,'files-fixture')}))
  const args=path.join(out,'capture.args');fs.writeFileSync(args,[process.env.APP_FILES_VISUAL_DRIVER,config].join('\r\n'))
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE
  const run=spawnSync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(REPO,'apps/desktop/renderer/tests/joblimit.ps1'),'-LimitMB','3072','-TimeoutSec','100','-WorkDir',REPO,'-Exe',electronExe(),'-ArgFile',args],{encoding:'utf8',windowsHide:true,env,timeout:120000})
  fs.writeFileSync(path.join(out,'capture.log'),(run.stdout??'')+(run.stderr??''))
  const receipt=JSON.parse(fs.readFileSync(path.join(out,'receipt.json'),'utf8'))
  assert.equal(run.status,0,receipt.error??run.stderr);assert.equal(receipt.ok,true)
  return {proof:'app-files-visual',passed:true,evidence:out,pid:receipt.pid,session:receipt.sessionId,shots:receipt.shots}
}
