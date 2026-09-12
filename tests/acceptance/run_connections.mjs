import fs from 'node:fs'
import path from 'node:path'
import {spawn} from 'node:child_process'
import {fileURLToPath} from 'node:url'
import {isolatedRoot,runtimeManifest,prerequisites,acceptanceEnvironment,assertIsolatedEnvironment,preflightHelpers,acceptanceLaunchArgs} from './run.mjs'
const here=path.dirname(fileURLToPath(import.meta.url)),target=path.resolve(process.env.ORGTREE_ACCEPTANCE_APP||path.join(here,'../..'))
const electron=path.join(target,'node_modules/electron/dist/electron.exe'),python=path.join(target,'engine/runtime/python.exe')
const missing=prerequisites(target,electron,python)
if(missing.length){console.log(JSON.stringify({status:'INERT',missing}));process.exit(2)}
const preflight=preflightHelpers(here,python)
if(preflight.status!=='PASS'){console.log(JSON.stringify({status:'FAIL',preflight}));process.exit(1)}
const exchangeRoot=isolatedRoot(),exchange=path.join(exchangeRoot,'exchange');fs.mkdirSync(exchange)
const manifest=runtimeManifest(target)
async function run(role){
  const root=isolatedRoot()
  const env=acceptanceEnvironment(root,{env:{ORGTREE_ACCEPTANCE_APP:target,ORGTREE_ACCEPTANCE_VISUAL_FIXTURE:'1',ORGTREE_ACCEPTANCE_HUB_ROLE:role,ORGTREE_ACCEPTANCE_EXCHANGE:exchange,ORGTREE_V2_PYTHON:python,ORGTREE_V2_PORT:'0'}})
  assertIsolatedEnvironment(env,root)
  const child=spawn(electron,acceptanceLaunchArgs(path.join(here,'connections.cjs')),{cwd:target,env,windowsHide:true,stdio:['ignore','ignore','ignore']})
  const outcome=await new Promise(resolve=>{const timer=setTimeout(()=>{child.kill();resolve({exitCode:null,timeout:true})},100000);child.once('exit',exitCode=>{clearTimeout(timer);resolve({exitCode})});child.once('error',()=>{clearTimeout(timer);resolve({exitCode:null,spawnError:true})})})
  const file=path.join(root,'connections.json'),report=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):{status:'FAIL',reason:'No report'}
  const survivors=(report.childPids||[]).filter(pid=>{try{process.kill(pid,0);return true}catch(e){return e.code!=='ESRCH'}})
  return{role,root,...report,...outcome,survivors}
}
const roles=await Promise.all(['host','client'].map(run)),stable=runtimeManifest(target).digest===manifest.digest
const result={status:roles.every(r=>r.status==='PASS'&&r.exitCode===0&&!r.survivors.length)&&stable?'PASS':'FAIL',exchange,exchangeRoot,roles,runtimeUnchanged:stable,runtimeDigest:manifest.digest,buildInfo:JSON.parse(fs.readFileSync(path.join(target,'dist/build-info.json'),'utf8')),limits:['Two isolated local engines and actual Connections UI','No provider turns or external correspondence','WAN/TLS reachability not tested']}
fs.writeFileSync(path.join(exchange,'report.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));process.exitCode=result.status==='PASS'?0:1
