// Only the synthetic engine, scratch database and fake CLIs are used.
import fs from 'node:fs'
import path from 'node:path'
import {seed} from '../fixture.mjs'
import {Proof} from '../proof.mjs'

export async function setup() { return {name:'context-full-recovery',fixture:'none'} }
export default async function(rig) {
 const p=new Proof('context-full-recovery')
 const agents={}, names=[]
 const fail=(codex,message)=>codex?{error:{message}}:{result:{is_error:true,result:message}}
 for(const [suffix,tier] of [['c','sonnet'],['x','sol']]) {
  const codex=suffix==='x'
  for(const mode of ['retry','terminal','length']) {
   const name=mode+suffix,token='PROOF-'+name;names.push(name)
   const message=mode==='length'?'Input exceeds maximum length':'Prompt is too long'
   agents[name]={turns:[{name:'overflow',match:token,once:mode==='retry',steps:[
    {text:'Attempting the synthetic request.'},fail(codex,message)]},
    {name:'recovered',steps:[{text:'Recovered the synthetic request.'}]}]}
  }
  agents['after'+suffix]={turns:[{name:'large',match:'PROOF-AFTER',once:true,steps:[
   {usage:codex?{input:250000,cached:0,output:1}:{input_tokens:900000,cache_read_input_tokens:0,cache_creation_input_tokens:0}},
   {text:'Large synthetic context.'}]},{name:'small',steps:[{text:'Small context.'}]}]}
  agents['before'+suffix]={turns:[{name:'small',steps:[{text:'Admitted.'}]}]}
  names.push('after'+suffix,'before'+suffix)
 }
 agents.workingc={turns:[{name:'working',steps:[
  {tool:'orgtree_status',args:{status:'working',summary:'Synthetic ongoing work'}},
  {usage:{input_tokens:900000,cache_read_input_tokens:0,cache_creation_input_tokens:0}},
  {text:'Still working.'}]}]};names.push('workingc')
 agents.compactedc={turns:[{name:'native',steps:[
  {usage:{input_tokens:900000,cache_read_input_tokens:0,cache_creation_input_tokens:0}},
  {text:'Before native compaction.'},
  {system:{subtype:'compact_boundary',compact_metadata:{trigger:'auto',pre_tokens:900000}}},
  {text:'Native compact done.'}]}]};names.push('compactedc')
 rig.scenario({agents,default:{turns:[{name:'default',steps:[{text:'OK.'}]}]}})
 await seed(rig,{org:{name:'Context Recovery Synthetic',settings:{compact_at:80}},agents:names.map(name=>({name,tier:name.endsWith('x')?'sol':'sonnet',grant:0}))})
 const id=n=>rig.agentRow(n).id
 const mail=n=>rig.sql(`SELECT uid,state,turn_id,delivered_at,body,extra FROM ot.mail WHERE recipient_agent_id=${id(n)} ORDER BY id`)
 // A private audit counts real delivery transitions, including a duplicate ack.
 rig.exec(`CREATE TABLE ot.context_proof_acks(uid text); CREATE FUNCTION ot.context_proof_ack() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.state='delivered' AND OLD.state<>'delivered' THEN INSERT INTO ot.context_proof_acks VALUES(NEW.uid); END IF; RETURN NEW; END $$; CREATE TRIGGER context_proof_ack AFTER UPDATE ON ot.mail FOR EACH ROW EXECUTE FUNCTION ot.context_proof_ack()`)
 for(const suffix of ['c','x']) {
  for(const mode of ['retry','terminal','length']) {
   const n=mode+suffix,token='PROOF-'+n
   await rig.userMail(n,token+': retain this exact original request.')
   const expected=mode==='length'?1:2
   const turns=await rig.waitTurns(n,expected,{timeout:15000}).catch(()=>rig.turns(n))
   const done=turns.filter(t=>t.ended_at)
   p.check(n+': bounded number of attempts',done.length===expected,done)
   p.check(n+': retry outcome',mode==='retry'?done.length===2&&!done[1].error:done.at(-1)?.error!=null,done.at(-1))
   const original=mail(n).filter(m=>m.body.startsWith(token+':'))
   const ack=original.length?rig.one(`SELECT count(*)::int AS n FROM ot.context_proof_acks WHERE uid='${original[0].uid}'`).n:0
   p.check(n+': original row has exactly one delivery receipt',original.length===1&&original[0].state==='delivered'&&ack===1,{original,ack})
   if(mode!=='length') {
    const wakes=mail(n).filter(m=>m.extra?.context_retry_turn!=null)
    p.check(n+': exactly one durable recovery wake',wakes.length===1,wakes)
    const prompts=rig.fakeLog(n).filter(l=>l.kind==='turn')
    p.check(n+': fresh retry gets the original request',prompts.length===2&&(prompts[1].prompt??'').includes(token),prompts.map(t=>t.prompt?.slice(-300)))
    p.check(n+': old session ended once',rig.one(`SELECT count(*)::int AS n FROM ot.agent_sessions WHERE agent_id=${id(n)} AND end_reason='context full (retry)'`).n===1)
   }
  }
  const a='after'+suffix
  await rig.userMail(a,'PROOF-AFTER: complete this large turn.')
  await rig.waitTurns(a,1)
  await rig.waitFor(()=>rig.agentRow(a).session_id==null,{what:'after-turn split',timeout:5000}).catch(()=>null)
  p.check(a+': threshold causes an after-turn split',rig.agentRow(a).session_id==null,rig.agentRow(a))
  const cuts=()=>rig.one(`SELECT count(*)::int AS n FROM ot.agent_sessions WHERE agent_id=${id(a)} AND end_reason LIKE 'context size%'`).n
  await rig.userMail(a,'Small next turn.')
  await rig.waitTurns(a,2)
  p.check(a+': admission does not repeat the completed split',cuts()===1,cuts())
  const b='before'+suffix
  await rig.userMail(b,'Establish a session.')
  await rig.waitTurns(b,1)
  const old=rig.agentRow(b).session_id
  rig.exec(`UPDATE ot.agents SET occupancy=900000,context_window=1000000,occupancy_est=false,compacted_unrun=false,last_status='{"status":"working"}'::jsonb WHERE id=${id(b)}`)
  await rig.userMail(b,'PROOF-BEFORE: near the limit on admission.')
  await rig.waitTurns(b,2)
  p.check(b+': admission compacts before starting the turn',rig.agentRow(b).session_id!==old&&rig.one(`SELECT end_reason FROM ot.agent_sessions WHERE agent_id=${id(b)} AND session_id='${old}'`)?.end_reason==='context size (admission)')
 }
 for(const n of ['workingc','compactedc']) {
  await rig.userMail(n,'A synthetic skip control.')
  await rig.waitTurns(n,1)
  p.check(n+': after-turn gate retains session',rig.agentRow(n).session_id!=null,rig.agentRow(n))
 }
 const log=rig.engineLog()
 for(const reason of ['below_threshold','status_working','cli_compaction']) p.check('after-turn skip is diagnosed: '+reason,log.includes(reason))
 // Stop/start must not enqueue a second recovery event or redeliver old mail.
 const wakeCount=rig.one("SELECT count(*)::int AS n FROM ot.mail WHERE extra ? 'context_retry_turn'").n
 await rig.restart()
 p.check('restart preserves the same recovery events',rig.one("SELECT count(*)::int AS n FROM ot.mail WHERE extra ? 'context_retry_turn'").n===wakeCount)
 p.check('all original receipts remain singular',rig.one('SELECT count(*)::int AS n FROM (SELECT uid FROM ot.context_proof_acks GROUP BY uid HAVING count(*)>1) repeated').n===0)
 p.keep(rig,{agents:names,grep:/context.*(size|full|split|retry)|after-turn compaction/})
 return p.summary()
}
