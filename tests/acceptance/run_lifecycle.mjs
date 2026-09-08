import fs from 'node:fs'
import path from 'node:path'
import {spawnSync} from 'node:child_process'
import {fileURLToPath} from 'node:url'
import {isolatedRoot,runtimeManifest,prerequisites,phaseResult} from './run.mjs'
const here=path.dirname(fileURLToPath(import.meta.url)),target=path.resolve(process.env.ORGTREE_ACCEPTANCE_APP||path.join(here,'../..'))
const electron=path.join(target,'node_modules/electron/dist/electron.exe'),python=path.join(target,'engine/runtime/python.exe')
const missing=prerequisites(target,electron,python)
if(missing.length){console.log(JSON.stringify({status:'INERT',missing}));process.exit(2)}
const root=isolatedRoot(),home=path.join(root,'home');fs.mkdirSync(home)
const manifest=runtimeManifest(target),buildInfo=JSON.parse(fs.readFileSync(path.join(target,'dist/build-info.json'),'utf8'))
const env={...process.env,HOME:home,USERPROFILE:home,ORGTREE_ACCEPTANCE_ROOT:root,ORGTREE_ACCEPTANCE_APP:target,ORGTREE_ACCEPTANCE_VISUAL_FIXTURE:'1',ORGTREE_DATA:path.join(root,'inherited-v1'),ORGTREE_V2_DATA:path.join(root,'data'),ORGTREE_V2_PROFILE:path.join(root,'profile'),ORGTREE_V2_PYTHON:python,ORGTREE_V2_PORT:'0'}
for(const key of ['ELECTRON_RUN_AS_NODE','ORGTREE_PORT','ORGTREE_V1_ROOT','ORGTREE_V2_TOKEN','ORGTREE_ACCEPTANCE_IMPORT_FIXTURE'])delete env[key]
const phases=[]
for(const phase of ['initial','quiet']){
  const result=spawnSync(electron,[path.join(here,'lifecycle.cjs'),...(phase==='quiet'?['--background']:[])],{cwd:target,env:{...env,ORGTREE_ACCEPTANCE_PHASE:phase},encoding:'utf8',windowsHide:true,timeout:110000,maxBuffer:1024*1024})
  const output=path.join(root,phase+'.json'),report=fs.existsSync(output)?JSON.parse(fs.readFileSync(output,'utf8')):{status:'FAIL',reason:'No application report'}
  const survivors=(report.childPids||[]).filter(pid=>{try{process.kill(pid,0);return true}catch(e){return e.code!=='ESRCH'}})
  phases.push(phaseResult(phase,report,result,survivors));if(phases.at(-1).status!=='PASS')break
}
const stable=runtimeManifest(target).digest===manifest.digest
const summary={status:phases.length===2&&phases.every(p=>p.status==='PASS')&&stable?'PASS':'FAIL',root,phases,runtimeUnchanged:stable,runtimeDigest:manifest.digest,buildInfo}
fs.writeFileSync(path.join(root,'report.json'),JSON.stringify(summary,null,2));console.log(JSON.stringify(summary,null,2));process.exitCode=summary.status==='PASS'?0:1
