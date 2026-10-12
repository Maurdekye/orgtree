import fs from 'node:fs'
import path from 'node:path'
import {Engine} from '../../apps/desktop/main/engine'
import {CoreLifecycle} from '../../apps/desktop/main/core-lifecycle'
import {CredentialBridge} from '../../apps/desktop/main/credential-bridge'
const cfg=JSON.parse(fs.readFileSync(process.argv[2],'utf8'))
const engine=new Engine(), bridge=new CredentialBridge()
const report=(value:unknown)=>fs.writeFileSync(cfg.result,JSON.stringify(value))
const options={binary:cfg.engine,directory:path.dirname(cfg.engine),dataRoot:cfg.root,forbiddenRoot:cfg.root+'-forbidden',python:'',uiDirectory:cfg.ui}
let quitting=false
const core=new CoreLifecycle(cfg.engine,cfg.root,bridge,()=>({origin:engine.origin,token:engine.token}),()=>{quitting=true;void engine.stopForQuit().finally(()=>process.exit(0))})
async function ready() {
  await core.complete();report({pid:process.pid,ready:true,enginePid:JSON.parse(fs.readFileSync(path.join(cfg.root,'core-lifecycle.json'),'utf8')).engine.pid,managed:engine.managed,background:engine.usesBackgroundTask})
}
async function main() {
  if(await core.begin(process.argv.includes('--automatic')))return process.exit(0)
  if(!await engine.attach(options))await engine.start(options)
  core.configureRecovery(async allowSpawn=>{await engine.recoverUnexpected(options,allowSpawn);if(!quitting)await ready()},false)
  await ready();core.start()
  let busy=false
  setInterval(()=>{
    if(busy||!fs.existsSync(cfg.result+'.command'))return
    const action=fs.readFileSync(cfg.result+'.command','utf8');fs.unlinkSync(cfg.result+'.command');busy=true
    void(async()=>{
      if(action==='quit') {
        quitting=true;engine.cancelLaunches();await core.cancelRecovery();
        const stopped=await engine.stopForQuit();report({pid:process.pid,quit:stopped});process.exit(stopped==='unverified'?2:0)
      }
      if(action==='transition')await core.transition()
      if(action==='complete')await core.complete()
      fs.writeFileSync(cfg.result+'.reply',JSON.stringify({ok:true,action}))
    })().catch(()=>report({pid:process.pid,error:'control failed'})).finally(()=>busy=false)
  },100)
}
void main().catch(error=>{report({pid:process.pid,error:String(error?.message||error)});process.exitCode=1})
