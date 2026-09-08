import fs from 'node:fs'
import path from 'node:path'
import {spawnSync} from 'node:child_process'
import {fileURLToPath} from 'node:url'
import {isolatedRoot,runtimeManifest,prerequisites} from './run.mjs'
const here=path.dirname(fileURLToPath(import.meta.url)),target=path.resolve(process.env.ORGTREE_ACCEPTANCE_APP||path.join(here,'../..'))
const packaged=process.env.ORGTREE_ACCEPTANCE_PACKAGE?path.resolve(process.env.ORGTREE_ACCEPTANCE_PACKAGE):null
const resources=packaged?path.join(packaged,'resources'):target
const electron=path.join(target,'node_modules/electron/dist/electron.exe'),python=path.join(resources,'engine/runtime/python.exe')
const missing=packaged?[[electron,'Electron driver'],[python,'Packaged Python'],[path.join(resources,'app.asar'),'Packaged ASAR'],[path.join(resources,'engine/launch.py'),'Packaged engine'],[path.join(resources,'ui/index.html'),'Packaged UI'],[path.join(resources,'build-info.json'),'Package provenance']].filter(([p])=>!fs.existsSync(p)).map(([,name])=>name):prerequisites(target,electron,python)
if(missing.length){console.log(JSON.stringify({status:'INERT',missing}));process.exit(2)}
const root=isolatedRoot(),home=path.join(root,'home');fs.mkdirSync(home)
const manifest=runtimeManifest(target,packaged),buildInfo=JSON.parse(fs.readFileSync(path.join(packaged?resources:path.join(target,'dist'),'build-info.json'),'utf8'))
const env={...process.env,HOME:home,USERPROFILE:home,ORGTREE_ACCEPTANCE_ROOT:root,ORGTREE_ACCEPTANCE_APP:resources,ORGTREE_ACCEPTANCE_VISUAL_FIXTURE:'1',ORGTREE_DATA:path.join(root,'inherited-v1'),ORGTREE_V2_DATA:path.join(root,'data'),ORGTREE_V2_PROFILE:path.join(root,'profile'),ORGTREE_V2_PYTHON:python,ORGTREE_V2_PORT:'0'}
for(const key of ['ELECTRON_RUN_AS_NODE','ORGTREE_PORT','ORGTREE_V1_ROOT','ORGTREE_V2_TOKEN','ORGTREE_ACCEPTANCE_IMPORT_FIXTURE'])delete env[key]
const result=spawnSync(electron,[path.join(here,'artifacts.cjs')],{cwd:target,env,encoding:'utf8',windowsHide:true,timeout:100000,maxBuffer:1024*1024})
const output=path.join(root,'artifacts.json'),report=fs.existsSync(output)?JSON.parse(fs.readFileSync(output,'utf8')):{status:'FAIL',reason:'No application report'}
const survivors=(report.childPids||[]).filter(pid=>{try{process.kill(pid,0);return true}catch(e){return e.code!=='ESRCH'}})
const stable=runtimeManifest(target,packaged).digest===manifest.digest
const summary={...report,status:report.status==='PASS'&&result.status===0&&!result.error&&!survivors.length&&stable?'PASS':'FAIL',root,exitCode:result.status,survivors,runtimeUnchanged:stable,runtimeDigest:manifest.digest,buildInfo,packaged,evidence:packaged?'packaged-components-in-instrumented-electron':'actual-app-with-synthetic-ledger',...(packaged?{packageLimits:['Development Electron host loads actual packaged ASAR and bundled engine/UI','Login registration captured; updater network disabled; not an NSIS installation']}:{})}
fs.writeFileSync(path.join(root,'report.json'),JSON.stringify(summary,null,2));console.log(JSON.stringify(summary,null,2));process.exitCode=summary.status==='PASS'?0:1
