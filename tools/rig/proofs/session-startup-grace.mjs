// Real actor, passive mail and placement watcher; fake Codex only, plus an
// owned helper attached exclusively to this scratch engine. No credential calls.
import fs from 'node:fs'
import path from 'node:path'
import {spawn} from 'node:child_process'
import {seed} from '../fixture.mjs'
import {Proof} from '../proof.mjs'
import {brokerExe} from './credential-broker.mjs'

export async function setup() {
  return {name:'session-startup-grace', 'boot-isolated':true, session0:'1', fixture:'none', recover:true}
}
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
export default async function(rig) {
  const p = new Proof('session-startup-grace')
  const children = []
  const bin = path.join(rig.dir, 'bin', 'orgtree-credential-broker.exe')
  fs.copyFileSync(brokerExe(), bin)
  const prompts = name => rig.fakeLog(name).filter(l => l.kind === 'turn').map(l => l.prompt ?? '')
  const placement = () => {
    try {return JSON.parse(fs.readFileSync(path.join(rig.data,'session-placement.json'),'utf8')).placement}
    catch {return null}
  }
  const quiet = name => rig.turns(name).length > 0 && rig.turns(name).every(t => t.ended_at)
  const mailMax = () => Number(rig.one('SELECT coalesce(max(id),0) AS id FROM ot.mail').id)
  const notices = (after, name, prefix) => rig.sql(`SELECT m.body FROM ot.mail m JOIN ot.agents a ON a.id=m.recipient_agent_id
    WHERE m.id>${after} AND a.name='${name}' AND m.body LIKE '${prefix}%' ORDER BY m.id`).map(m=>m.body)
  const start = async () => {
    const identity = await rig.api('GET','/api/desktop/identity')
    fs.writeFileSync(path.join(rig.data,'engine-attach.json'),JSON.stringify({
      type:'attach', protocol:1, port:Number(new URL(rig.url).port), enginePid:identity.pid,
      hostPid:rig.refresh().keeperPid, dataRootId:identity.dataRootId, token:rig.token, startedAt:new Date().toISOString()
    }))
    const child = spawn(bin, [], {env:{...process.env, ORGTREE_V2_DATA:rig.data}, stdio:'ignore', windowsHide:true})
    const exited = new Promise(resolve => {child.once('exit',resolve);child.once('error',resolve)})
    const entry = {child, exited}; children.push(entry)
    await rig.waitFor(()=>rig.engineLog().includes(`Sign-in helper took the Codex host slot pid=${child.pid} `)
      || rig.engineLog().split(/\r?\n/).some(l=>l.includes('Sign-in helper took the Codex host slot')&&l.includes(`pid=${child.pid} `)),
      {what:'owned helper authenticated', timeout:30000})
    await rig.waitFor(()=>placement()==='signed-in',{what:'signed-in placement',timeout:20000})
    return entry
  }
  const stop = async entry => {
    if(entry?.child.exitCode===null) entry.child.kill()
    if(!entry) return
    let timer
    try {await Promise.race([entry.exited,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('owned helper failed to exit')),5000)})])}
    finally {clearTimeout(timer)}
  }
  const turn = async (name, token, timeout=90000) => {
    await rig.userMail(name,token)
    await rig.waitFor(()=>prompts(name).some(s=>s.includes(token))&&quiet(name),{what:token,timeout})
  }
  try {
    rig.scenario({default:{turns:[{steps:[{text:'OK.'}]}]}})
    await seed(rig,{org:{name:'Startup Session Grace'},agents:[
      {name:'resume',tier:'sol'},{name:'fixed',tier:'sol'},{name:'late',tier:'sol'}
    ]})
    let helper = await start()
    for(const name of ['resume','fixed','late']) await turn(name,`WARM-${name}`)
    p.check('fixture: all three last turns really ran signed in',
      ['resume','fixed','late'].every(n=>rig.agentRow(n)?.extra?.session==='signed-in'))
    await rig.api('POST',`/api/orgs/${rig.org}/nodes/fixed/scope`,{session:'session0'})
    const mark = mailMax()
    await stop(helper)
    await rig.restart()
    const started = Date.now()
    await rig.userMail('resume','DELAYED-HELPER-RESUME')
    await turn('fixed','EXPLICIT-SESSION0',25000)
    p.check('explicit Session 0 does not wait for helper reconnect', Date.now()-started<12000
      &&rig.agentRow('fixed')?.extra?.session==='session0')
    // A real delayed registration, beyond the old 15 s settle and the reported
    // ~30 s gap. It must not first send the resumed agent into Session 0.
    await pause(Math.max(0,35000-(Date.now()-started)))
    p.check('resumed turn waits through 35 s of startup absence',
      !prompts('resume').some(s=>s.includes('DELAYED-HELPER-RESUME')))
    helper = await start()
    await rig.waitFor(()=>prompts('resume').some(s=>s.includes('DELAYED-HELPER-RESUME'))&&quiet('resume'),
      {what:'delayed resumed turn completes',timeout:20000})
    await turn('resume','AFTER-DELAYED-RECONNECT')
    p.check('reconnected resumed turn stays signed in',rig.agentRow('resume')?.extra?.session==='signed-in')
    p.check('restart sends no false turn placement notice pair',
      notices(mark,'resume','[ORGTREE SESSION NOTICE]').length===0,notices(mark,'resume','[ORGTREE SESSION NOTICE]'))
    p.check('restart sends no false global sign-out/sign-in pair',
      notices(mark,'resume','[ORGTREE SIGN-').length===0,notices(mark,'resume','[ORGTREE SIGN-'))
    p.check('resumed waking mail delivered once',
      prompts('resume').filter(s=>s.includes('DELAYED-HELPER-RESUME')).length===1)
    const real = mailMax()
    await stop(helper)
    await rig.waitFor(()=>placement()==='session0',{what:'real helper loss debounce',timeout:12000})
    // "late" has not had a turn since restart: the closed startup window must
    // not make this first turn wait out the rest of the 60-second grace.
    await turn('late','REAL-LOSS-AFTER-RECONNECT',12000)
    p.check('genuine helper loss still sends one global sign-out',
      notices(real,'late','[ORGTREE SIGN-OUT NOTICE]').length===1)
    p.check('genuine move still sends one turn downgrade',
      notices(real,'late','[ORGTREE SESSION NOTICE]').filter(s=>s.includes('Session 0')).length===1
      &&rig.agentRow('late')?.extra?.session==='session0')
    if(process.env.ORGTREE_SESSION_GRACE_SHORT_PROOF!=='1') {
      // No helper at all on the next restart: bounded fallback, never an
      // indefinite hold. resume's last successful turn is still signed in.
      const fallback = mailMax()
      await rig.restart()
      const began = Date.now()
      await turn('resume','HELPER-NEVER-RETURNS',80000)
      const elapsed = Date.now()-began
      p.check('absent helper falls back within the bounded grace',elapsed>=50000&&elapsed<80000,{elapsed})
      p.check('timeout records actual Session 0 and one downgrade',
        rig.agentRow('resume')?.extra?.session==='session0'
        &&notices(fallback,'resume','[ORGTREE SESSION NOTICE]').filter(s=>s.includes('Session 0')).length===1)
    }
  } finally {
    for(const child of children) await stop(child)
    p.keep(rig,{agents:['resume','fixed','late'],grep:/session|helper|CLI started/})
  }
  return p.summary()
}
