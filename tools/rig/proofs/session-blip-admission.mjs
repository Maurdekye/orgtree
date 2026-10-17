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
  const token=name=>`SESSION-BLIP-${name}`
  const prompts=name=>rig.fakeLog(name).filter(l=>l.kind==='turn').map(l=>l.prompt??'')
  const logs=()=>rig.engineLog().split(/\r?\n/)
  const held=name=>logs().some(l=>l.includes(`/${name} `)&&l.includes('host lease temporarily missing; deferring CLI start during placement debounce'))
  const quiet=()=>['recover','fallback'].every(name=>rig.turns(name).length>0&&rig.turns(name).every(t=>t.ended_at))
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
  let helper
  try{
    rig.scenario({default:{turns:[{steps:[{text:'OK.'}]}]}})
    await seed(rig,{org:{name:'Session Blip Admission'},agents:[{name:'recover',tier:'haiku'},{name:'fallback',tier:'haiku'}]})
    await rig.waitFor(quiet,{what:'initial fake turns',timeout:45000})
    helper=start()
    await rig.waitFor(()=>placement()==='signed-in',{what:'signed-in placement cache',timeout:35000})
    p.check('fixture reaches signed-in placement with owned authenticated helper',helper.child.pid>0&&placement()==='signed-in')

    await stop(helper)
    await rig.userMail('recover',token('recover'))
    await rig.waitFor(()=>held('recover'),{what:'actual launch inside retained-placement gap',timeout:5000})
    p.check('recovery case exercises real missing-host launch before sending mail',!prompts('recover').some(s=>s.includes(token('recover'))))
    helper=start()
    const recovered=await rig.waitFor(()=>prompts('recover').some(s=>s.includes(token('recover')))&&quiet(),
      {what:'unsent mail retries after helper recovery without another wake',timeout:20000}).catch(()=>false)
    p.check('unsent mail resumes automatically in signed-in session after lease recovery',!!recovered&&rig.agentRow('recover')?.extra?.session==='signed-in')

    // Re-establish cache before the independent no-recovery case.
    await rig.waitFor(()=>placement()==='signed-in',{what:'placement before confirmed loss',timeout:15000})
    await stop(helper)
    await rig.userMail('fallback',token('fallback'))
    await rig.waitFor(()=>held('fallback'),{what:'actual launch before confirmed Session0 fallback',timeout:5000})
    p.check('fallback case exercises real missing-host launch before sending mail',!prompts('fallback').some(s=>s.includes(token('fallback'))))
    const fallback=await rig.waitFor(()=>prompts('fallback').some(s=>s.includes(token('fallback')))&&quiet(),
      {what:'unsent mail retries after confirmed Session0 fallback without another wake',timeout:20000}).catch(()=>false)
    p.check('unsent mail resumes automatically in Session0 after confirmed loss',!!fallback&&rig.agentRow('fallback')?.extra?.session==='session0')
    for(const name of ['recover','fallback']){
      const row=rig.agentRow(name)
      p.check(`${name}: no terminal launch failure or hard-failure counter`,!row?.last_error&&!(row?.extra?.hard_fail_run>0))
      p.check(`${name}: original waking mail was delivered exactly once`,rig.rows(`SELECT state FROM ot.mail m JOIN ot.agents a ON a.id=m.recipient_agent_id WHERE a.name='${name}' AND m.body='${token(name)}'`).every(m=>m.state==='delivered')&&prompts(name).filter(s=>s.includes(token(name))).length===1)
    }
  }finally{
    for(const entry of children)await stop(entry)
    p.keep(rig,{agents:['recover','fallback'],grep:/deferring CLI start|admission|where new turns run changed|turn could not start/})
  }
  return p.summary()
}
