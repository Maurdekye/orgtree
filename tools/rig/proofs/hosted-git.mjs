// Real Codex/Claude, real Git/gh and both production credential brokers.
// Read-only signed-in-store lookups; output contains booleans only, never tokens.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startFakeLlm } from '../fakellm.mjs'
import { seed } from '../fixture.mjs'
import { Proof } from '../proof.mjs'
import { brokerExe, brokerPid, ps, sessionLauncher } from './credential-broker.mjs'
export async function setup() { return {name:'hosted-git', 'real-cli':true, 'boot-isolated':true, session0:'1',fixture:'none'} }
const q = s => "'"+s.replaceAll("'","''")+"'"
const kill = pid => {if(pid)try{process.kill(pid)}catch{}}
const parentOf = pid => Number(ps(`(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').ParentProcessId`)||0)
const sessionOf = pid => Number(ps(`(Get-Process -Id ${pid}).SessionId`))
export default async function(rig) {
 const stateHome=process.env.ORGTREE_RIG_HOME
 process.env.ORGTREE_RIG_HOME=process.env.ORGTREE_RIG_EVIDENCE_HOME||stateHome
 const p=new Proof('hosted-git')
 process.env.ORGTREE_RIG_HOME=stateHome
 const escalated=process.env.ORGTREE_RIG_ESCALATED === '1'
 const rules=[]
 const llm=await startFakeLlm({log:path.join(p.dir,'llm.jsonl'),bodies:path.join(p.dir,'bodies'),models:[{name:'fake-model:latest',context:131072,running:65536}],rules})
 const run=rig.refresh(), identity=await rig.api('GET','/api/desktop/identity')
 const taskName=`OrgtreeRigProof-${path.basename(rig.dir)}`, session=sessionLauncher(rig.dir,taskName)
 const bin=path.join(rig.dir,'bin','orgtree-credential-broker.exe')
 let broker=0,desk=0
 try {
  fs.writeFileSync(path.join(rig.data,'engine-attach.json'),JSON.stringify({type:'attach',protocol:1,port:Number(new URL(rig.url).port),enginePid:identity.pid,hostPid:run.keeperPid,dataRootId:identity.dataRootId,token:rig.token,startedAt:new Date().toISOString()}))
  const home=path.join(rig.data,'profiles','langserver-codex');fs.mkdirSync(home,{recursive:true});fs.writeFileSync(path.join(home,'config.toml'),'[windows]\nsandbox="unelevated"\n'+(escalated?'':'[sandbox_workspace_write]\nnetwork_access=true\n'))
  p.check(escalated?'production default network policy; hosted commands explicitly escalated':'rig-only network_access=true and Git OpenSSL TLS; filesystem sandbox and certificate verification unchanged',true)
  const tiers={}
  for(const [key,harness] of [['cx','codex-cli'],['cc','claude-code']]) {
   const r=await rig.api('POST','/api/langservers',{preset:'llamacpp',address:llm.url,harness,label:'Credential '+key,models:[{id:'fake-model:latest',context:65536}]})
   tiers[key]=Object.values(r.server.models)[0].tier
  }
  await seed(rig,{org:{name:'Hosted Git Proof'},agents:[
   {name:'hosted',tier:tiers.cx,grant:1,tools:{bash:true,edit:true},charter:'Run the credential proof and report only its booleans.'},
   {name:'direct',tier:tiers.cx,grant:1,tools:{bash:true,edit:true},permission_mode:'bypassPermissions',charter:'Run the credential proof and report only its booleans.'},
   {name:'claude',tier:tiers.cc,grant:1,tools:{bash:true,edit:true},permission_mode:'bypassPermissions',charter:'Run the credential proof and report only its booleans.'},
  ]})
  const gitGlobal=path.join(rig.dir,'broker-gitconfig')
  fs.writeFileSync(gitGlobal,`[include]\n path = ${path.join(os.homedir(),'.gitconfig').replaceAll('\\','/')}\n`+'[credential "https://rig-proof.example"]\n helper = "!f() { test \\"$1\\" = get && echo username=rig-proof && echo password=rig-proof-synthetic; }; f"\n')
  const cfg=path.join(rig.dir,'desktop-config.json'),ready=path.join(rig.dir,'desktop-ready.json')
  fs.writeFileSync(cfg,JSON.stringify({origin:rig.url,token:rig.token}))
  const bundle=process.env.ORGTREE_RIG_DESKTOP_BROKER
  if(!bundle||!fs.existsSync(bundle))throw Error('set ORGTREE_RIG_DESKTOP_BROKER to the bundled credential-desktop-real.ts')
  await session.start({GIT_CONFIG_GLOBAL:gitGlobal},`"${process.execPath}" "${bundle}" "${cfg}" "${ready}"`)
  await rig.waitFor(()=>fs.existsSync(ready),{what:'real desktop broker',timeout:15000});desk=JSON.parse(fs.readFileSync(ready,'utf8')).pid
  await rig.waitFor(async()=>(await rig.api('GET','/api/desktop/identity')).credentialContext.bridge_ready,{what:'desktop holds credentials',timeout:15000})
  fs.copyFileSync(brokerExe(),bin)
  await session.start({ORGTREE_V2_DATA:rig.data,GIT_CONFIG_GLOBAL:gitGlobal},`"${bin}"`)
  await rig.waitFor(()=>brokerPid(bin),{what:'helper',timeout:15000});broker=brokerPid(bin)
  const helperLog=()=>{try{return fs.readFileSync(path.join(rig.data,'credential-broker.log'),'utf8')}catch{return ''}}
  await rig.waitFor(()=>helperLog().includes('standing by: another broker holds the bridge')&&helperLog().includes('holding the Codex host slot'),{what:'helper hosts while desktop holds credentials',timeout:20000})
  p.check('production desktop credential broker holds while helper hosts',true,{desktop:desk,helper:broker})
  async function check(name,phase) {
   const token=`PROOF-CREDENTIAL-${name}-${phase}`, basename=`${token}.ps1`
   const scratch=path.join(rig.data,'scratch',rig.org,name),script=path.join(scratch,basename)
   const output=path.join(scratch,token+'.json')
   fs.writeFileSync(script,`$env:GIT_CONFIG_GLOBAL='NUL'\n$env:GIT_CONFIG_SYSTEM='NUL'\n$env:GIT_CONFIG_NOSYSTEM='1'\n`+
    `$g="protocol=https\nhost=rig-proof.example\n\n" | git credential fill 2>$null\n$fill=$LASTEXITCODE -eq 0 -and ($g -join "\n").Contains('password=rig-proof-synthetic')\n`+
    `$v="protocol=https\nhost=github.com\n\n" | git credential fill 2>$null\n$github=$LASTEXITCODE -eq 0 -and ($v -join "\n") -match '(?m)^password=.'\n`+
    `$ls=git ${!escalated&&name==='hosted'?'-c http.sslBackend=openssl ':''}ls-remote https://github.com/Maurdekye/orgtree HEAD 2>&1\n$remote=$LASTEXITCODE -eq 0 -and ($ls -join "\n") -match '^[0-9a-f]{40}\\s+HEAD'\n`+
    `$gh=gh auth status --hostname github.com 2>&1\n$status=$LASTEXITCODE -eq 0\n`+
    `@{networkBlocked=($env:HTTPS_PROXY -match '127\\.0\\.0\\.1:9');remoteError=(($ls | Where-Object { $_ -match 'fatal:|proxy|connect' }) -join ' ');fill=$fill;github=$github;remote=$remote;gh=$status;askpass=[bool]$env:GIT_ASKPASS} | ConvertTo-Json -Compress | Set-Content -Encoding utf8 ${q(output)}\n'${token}-FINISHED'\n`)
   const command=`powershell.exe -NoProfile -NonInteractive -File "${script}"`
   rules.push({match:[token],tool:name==='claude'?'Bash':'exec_command',input:name==='claude'?{command,timeout:120000}:{cmd:command,yield_time_ms:10000,...(escalated&&name==='hosted'?{sandbox_permissions:'require_escalated',justification:'Read-only Git and gh credential acceptance check.'}:{})}})
   rules.push({afterCall:[basename],tool:'orgtree_status',input:{status:'done',summary:token+'-DONE'}})
   await rig.userMail(name,token+': run the provided credential check.')
   await rig.waitFor(()=>fs.existsSync(output),{what:token+' results',timeout:120000})
   await rig.waitFor(()=>rig.sql(`SELECT 1 FROM ot.turns t JOIN ot.agents a ON a.id=t.agent_id WHERE a.name='${name}' AND t.ended_at IS NULL`).length===0,{what:'turn settled',timeout:60000})
   const result=JSON.parse(fs.readFileSync(output,'utf8').replace(/^\uFEFF/,''));p.file(token+'.json',result)
   for(const key of ['fill','github','remote','gh','askpass'])p.check(`${phase}/${name}: ${key}`,result[key],result)
   const line=rig.engineLog().split(/\r?\n/).filter(l=>l.includes(`/${name} `)&&l.includes('CLI started')).at(-1)
   const pid=Number(line?.match(/ pid=(\d+)/)?.[1]||0)
   if(name==='hosted'&&phase!=='fallback')p.check(`${phase}: actual hosted Session-1 child`,pid>0&&parentOf(pid)===broker&&sessionOf(pid)===1,{pid,parent:parentOf(pid),helper:broker})
   if(name==='direct')p.check(`${phase}: direct seat is engine child`,pid>0&&parentOf(pid)===identity.pid,{pid,parent:parentOf(pid),engine:identity.pid})
  }
  for(const name of ['hosted','direct','claude'])await check(name,'desktop')
  kill(desk);desk=0
  await rig.waitFor(()=>helperLog().includes('holding the bridge'),{what:'helper credential takeover',timeout:15000})
  for(const name of ['hosted','direct','claude'])await check(name,'helper')
  kill(broker);broker=0
  // No credentials after helper death; existing codex-host proof covers direct
  // fallback and one diagnostic. This proof checks broker availability only.
  await rig.waitFor(()=>brokerPid(bin)===0,{what:'helper gone',timeout:15000})
  p.check('helper terminated',true)
  p.keep(rig,{grep:/Codex OS sandbox|Codex started by the sign-in helper|CLI started|[Cc]redential broker/})
 } finally {
  kill(desk);kill(broker)
  p.check('temporary interactive task removed',session.remove())
  await llm.close()
 }
 return p.summary()
}
