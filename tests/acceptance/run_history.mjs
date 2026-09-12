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
const root=isolatedRoot(),seedRoot=path.join(root,'history-seed')
const seeded=spawnSync(python,[path.join(here,'seed_history_fixture.py'),'--repo',target,'--root',seedRoot],{cwd:target,encoding:'utf8',windowsHide:true,timeout:60000})
if(seeded.status!==0)throw Error('Isolated history seed failed')
fs.cpSync(path.join(seedRoot,'data'),path.join(root,'data'),{recursive:true})
fs.copyFileSync(path.join(seedRoot,'manifest.json'),path.join(root,'history-manifest.json'))
const manifest=runtimeManifest(target),env=acceptanceEnvironment(root,{home:path.join(seedRoot,'home'),env:{ORGTREE_ACCEPTANCE_APP:target,ORGTREE_ACCEPTANCE_VISUAL_FIXTURE:'1',ORGTREE_V2_PYTHON:python,ORGTREE_V2_PORT:'0'}})
assertIsolatedEnvironment(env,root)
fs.writeFileSync(path.join(root,'runtime-manifest.json'),JSON.stringify(manifest,null,2))
const result=spawnSync(electron,acceptanceLaunchArgs(path.join(here,'history.cjs')),{cwd:target,env,encoding:'utf8',windowsHide:true,timeout:100000,maxBuffer:1024*1024})
const output=path.join(root,'history.json'),report=fs.existsSync(output)?JSON.parse(fs.readFileSync(output,'utf8')):{status:'FAIL',reason:'No application report'}
const survivors=(report.childPids||[]).filter(pid=>{try{process.kill(pid,0);return true}catch(e){return e.code!=='ESRCH'}})
const stable=runtimeManifest(target).digest===manifest.digest
const summary={...report,status:report.status==='PASS'&&result.status===0&&!result.error&&!survivors.length&&stable?'PASS':'FAIL',root,exitCode:result.status,processError:result.error?.code||null,survivors,runtimeUnchanged:stable,runtimeDigest:manifest.digest,buildInfo:JSON.parse(fs.readFileSync(path.join(target,'dist/build-info.json'),'utf8'))}
fs.writeFileSync(path.join(root,'report.json'),JSON.stringify(summary,null,2));console.log(JSON.stringify(summary,null,2));process.exitCode=summary.status==='PASS'?0:1
