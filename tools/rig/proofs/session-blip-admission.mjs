// Actual actor/mail/launcher regression for the review finding on30bbe08.
// A synthetic boot engine and fake CLIs only. This proof must run from an
// interactive Windows session, because its own temporary helper is a child.
import fs from 'node:fs'
import path from 'node:path'
import {spawn} from 'node:child_process'
import {seed} from '../fixture.mjs'
import {Proof} from '../proof.mjs'
import {brokerExe} from './credential-broker.mjs'

export async function setup(){return {name:'session-blip-admission','boot-isolated':true,session0:'1',fixture:'none'}}

export default async function(rig){
  const p=new Proof('session-blip-admission')
  const children=[]
  const agents=[{name:'recover',tier:'haiku'},{name:'fallback',tier:'haiku'},
    {name:'recover-codex',tier:'sol'},{name:'fallback-codex',tier:'sol'}]
  const names=agents.map(a=>a.name)
  const token=name=>`SESSION-BLIP-${name}`
  const prompts=name=>rig.fakeLog(name).filter(l=>l.kind==='turn').map(l=>l.prompt??'')
  const logs=()=>rig.engineLog().split(/\r?\n/)
  const held=name=>logs().some(l=>l.includes(`/${name} `)&&l.includes('host lease temporarily missing; deferring CLI start during placement debounce'))
  const quiet=()=>names.every(name=>rig.turns(name).length>0&&rig.turns(name).every(t=>t.ended_at))
  const placement=()=>{try{return JSON.parse(fs.readFileSync(path.join(rig.data,'session-placement.json'),'utf8')).placement}catch{return null}}
  const bin=path.join(rig.dir,'bin','orgtree-credential-broker.exe')
  fs.copyFileSync(brokerExe(),bin)
  const identity=await rig.api('GET','/api/desktop/identity')
  fs.writeFileSync(path.join(rig.data,'engine-attach.json'),JSON.stringify({type:'attach',protocol:1,
    port:Number(new URL(rig.url).port),enginePid:identity.pid,hostPid:rig.refresh().keeperPid,
    dataRootId:identity.dataRootId,token:rig.token,startedAt:new Date().toISOString()}))
  const start=()=>{
    const child=spawn(bin,[],{env:{...process.env,ORGTREE_V2_DATA:rig.data},stdio:'ignore',windowsHide:true})
    const exited=new Promise(resolve=>{child.once('exit',resolve);child.once('error',resolve)})
    const entry={child,exited};children.push(entry);return entry
  }
  const stop=async entry=>{
    if(entry.child.exitCode===null){try{entry.child.kill()}catch{}}
    // No losing timer is left behind after a child exits.
    let timer;try{await Promise.race([entry.exited,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('owned helper did not exit')),5000)})])}finally{clearTimeout(timer)}
  }
  try{
    rig.scenario({default:{turns:[{steps:[{text:'OK.'}]}]}})
    await seed(rig,{org:{name:'Session Blip Admission'},agents})
    for(const name of names)await rig.userMail(name,'SESSION-BLIP-WARMUP')
    await rig.waitFor(quiet,{what:'initial fake turns',timeout:45000})
    for(const name of names){
      let helper=start()
      await rig.waitFor(()=>placement()==='signed-in'&&logs().some(l=>l.includes('Sign-in helper took the Codex host slot')&&l.includes(`pid=${helper.child.pid} `)),
        {what:`${name}: authenticated helper and signed-in placement cache`,timeout:35000})
      p.check(`${name}: fixture reaches signed-in placement with owned authenticated helper`,helper.child.pid>0&&placement()==='signed-in')
      await stop(helper)
      await rig.userMail(name,token(name))
      await rig.waitFor(()=>held(name),{what:`${name}: actual launch inside retained-placement gap`,timeout:5000})
      p.check(`${name}: real missing-host launch precedes mail delivery`,!prompts(name).some(s=>s.includes(token(name))))
      const recovering=name.startsWith('recover')
      if(recovering)helper=start()
      const resumed=await rig.waitFor(()=>prompts(name).some(s=>s.includes(token(name)))&&quiet(),
        {what:`${name}: unsent mail retries without another wake`,timeout:20000}).catch(()=>false)
      const wanted=recovering?'signed-in':'session0'
      p.check(`${name}: unsent mail resumes automatically in ${wanted}`,!!resumed&&rig.agentRow(name)?.extra?.session===wanted)
      const row=rig.agentRow(name)
      p.check(`${name}: no terminal launch failure or hard-failure counter`,!row?.last_error&&!(row?.extra?.hard_fail_run>0))
      const mail=rig.sql(`SELECT m.state FROM ot.mail m JOIN ot.agents a ON a.id=m.recipient_agent_id WHERE a.name='${name}' AND m.body='${token(name)}'`)
      p.check(`${name}: original waking mail was delivered exactly once`,mail.length===1&&mail[0].state==='delivered'&&prompts(name).filter(s=>s.includes(token(name))).length===1)
      await stop(helper)
    }
  }finally{
    for(const entry of children)await stop(entry)
    p.keep(rig,{agents:names,grep:/deferring CLI start|admission|where new turns run changed|turn could not start/})
  }
  return p.summary()
}
