import fs from 'node:fs'
import path from 'node:path'
import {spawnSync} from 'node:child_process'
import {fileURLToPath} from 'node:url'
import {isolatedRoot,runtimeManifest,prerequisites,acceptanceEnvironment,assertIsolatedEnvironment,preflightHelpers,acceptanceLaunchArgs} from './run.mjs'
const here=path.dirname(fileURLToPath(import.meta.url)),target=path.resolve(process.env.ORGTREE_ACCEPTANCE_APP||path.join(here,'../..'))
const electron=path.join(target,'node_modules/electron/dist/electron.exe'),python=path.join(target,'engine/runtime/python.exe')
const missing=prerequisites(target,electron,python)
if(missing.length){console.log(JSON.stringify({status:'INERT',missing}));process.exit(2)}
const preflight=preflightHelpers(here,python)
if(preflight.status!=='PASS'){console.log(JSON.stringify({status:'FAIL',preflight}));process.exit(1)}
const root=isolatedRoot(),manifest=runtimeManifest(target),env=acceptanceEnvironment(root,{env:{ORGTREE_ACCEPTANCE_APP:target,ORGTREE_ACCEPTANCE_VISUAL_FIXTURE:'1',ORGTREE_V2_PYTHON:python,ORGTREE_V2_PORT:'0'}})
assertIsolatedEnvironment(env,root)
fs.writeFileSync(path.join(root,'runtime-manifest.json'),JSON.stringify(manifest,null,2))
const started=Date.now(),result=spawnSync(electron,acceptanceLaunchArgs(path.join(here,'relaunch.cjs')),{cwd:target,env,windowsHide:true,encoding:'utf8',timeout:60000,maxBuffer:1024*1024})
const finalPath=path.join(root,'relaunch-final.json')
while(!fs.existsSync(finalPath) && Date.now()-started<140000)await new Promise(r=>setTimeout(r,250))
await new Promise(r=>setTimeout(r,2000))
const records=fs.existsSync(path.join(root,'relaunch-cycles.jsonl'))?fs.readFileSync(path.join(root,'relaunch-cycles.jsonl'),'utf8').trim().split('\n').filter(Boolean).map(JSON.parse):[]
const final=fs.existsSync(finalPath)?JSON.parse(fs.readFileSync(finalPath,'utf8')):{status:'FAIL',reason:'No final relaunch receipt'}
const ready=records.filter(r=>r.kind==='ready'),pids=ready.flatMap(r=>[r.electronPid,r.enginePid,r.guardianPid]).filter(Boolean)
const survivors=pids.filter(pid=>{try{process.kill(pid,0);return true}catch(e){return e.code!=='ESRCH'}})
const stable=runtimeManifest(target).digest===manifest.digest
const report={status:final.status==='PASS' && ready.length===3 && records.filter(r=>r.kind==='quit' && r.engineExitCode===0).length===3 && !survivors.length && result.status===0 && stable?'PASS':'FAIL',root,records,final,firstExitCode:result.status,survivors,runtimeUnchanged:stable,runtimeDigest:manifest.digest,buildInfo:JSON.parse(fs.readFileSync(path.join(target,'dist/build-info.json'),'utf8')),limits:['Synthetic actor with provider execution disabled','OS idle controlled','Actual app.relaunch and three actual engine starts; no installer update']}
fs.writeFileSync(path.join(root,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));process.exitCode=report.status==='PASS'?0:1
