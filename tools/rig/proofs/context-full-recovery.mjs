// Only the synthetic engine, scratch database and fake CLIs are used.
import fs from 'node:fs'
import path from 'node:path'
import {seed} from '../fixture.mjs'
import {Proof} from '../proof.mjs'

export async function setup() { return {name:'context-full-recovery',fixture:'none',recover:true} }
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
 agents.crashc={turns:[{name:'overflow',match:'PROOF-CRASH',once:true,steps:[{text:'Before crash.'},{sleep_ms:1500},fail(false,'Prompt is too long')]},{name:'recovered',steps:[{text:'Recovered after restart.'}]}]}
 agents.blockerc={turns:[{name:'hold',once:true,steps:[{text:'Holding the synthetic scheduler slot.'},{sleep_ms:15000}]},{name:'done',steps:[{text:'Done.'}]}]}
 names.push('crashc','blockerc')
 rig.scenario({agents,default:{turns:[{name:'default',steps:[{text:'OK.'}]}]}})
 await seed(rig,{org:{name:'Context Recovery Synthetic',settings:{compact_at:80}},agents:names.map(name=>({name,tier:name.endsWith('x')?'sol':'sonnet',grant:0}))})
 // A known synthetic denominator, independent of catalog fallback windows.
 rig.exec("UPDATE ot.agents SET context_window=272000 WHERE name='afterx'")
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
   p.check(n+': original transcript identity appears once',original.length===1&&rig.one(`SELECT count(*)::int AS n FROM ot.convo WHERE agent_id=${id(n)} AND body->'mail_ids' ? '${original[0].uid}'`).n===1)
   if(mode!=='length') {
    const wakes=mail(n).filter(m=>m.extra?.context_retry_turn!=null)
    p.check(n+': exactly one durable recovery wake',wakes.length===1,wakes)
    const prompts=rig.fakeLog(n).filter(l=>l.kind==='turn')
    p.check(n+': fresh retry gets the original request',prompts.length===2&&(prompts[1].prompt??'').includes(token),prompts.map(t=>t.prompt?.slice(-300)))
    p.check(n+': old session ended once',rig.one(`SELECT count(*)::int AS n FROM ot.agent_sessions WHERE agent_id=${id(n)} AND end_reason='context full (retry)'`).n===1)
    p.check(n+': completed turn clears retry count; terminal failure retains it',mode==='retry'?rig.agentRow(n).extra?.native_ctx_retry_run==null:rig.agentRow(n).extra?.native_ctx_retry_run===1,rig.agentRow(n).extra?.native_ctx_retry_run)
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
 // Hold the only scheduler slot after failure, then crash with the committed
 // recovery wake still pending. Restart must resume exactly that wake.
 await rig.api('PUT','/api/app-settings/runtime',{max_concurrent_turns:1})
 await rig.userMail('crashc','PROOF-CRASH: keep this request through the crash.')
 await rig.waitFor(()=>rig.fakeLog('crashc').some(l=>l.kind==='turn'),{what:'crash subject to start'})
 await rig.userMail('blockerc','Hold the slot before the recovery attempt.')
 const pending=await rig.waitFor(()=>mail('crashc').find(m=>m.extra?.context_retry_turn!=null&&m.state==='pending'),{what:'committed recovery before admission',timeout:10000}).catch(()=>null)
 p.check('crash: a committed recovery wake is pending before restart',!!pending,pending)
 const wakeCount=rig.one("SELECT count(*)::int AS n FROM ot.mail WHERE extra ? 'context_retry_turn'").n
 await rig.crash()
 await rig.restart()
 const resumed=await rig.waitTurns('crashc',2,{timeout:45000}).catch(()=>rig.turns('crashc'))
 p.check('crash: the fresh retry completes once',resumed.length===2&&resumed.every(t=>t.ended_at)&&!resumed[1].error,resumed)
 p.check('crash: the original request is present after restart',rig.fakeLog('crashc').filter(l=>l.kind==='turn').at(-1)?.prompt?.includes('PROOF-CRASH'))
 p.check('restart preserves the same recovery events',rig.one("SELECT count(*)::int AS n FROM ot.mail WHERE extra ? 'context_retry_turn'").n===wakeCount)
 p.check('all original receipts remain singular',rig.one('SELECT count(*)::int AS n FROM (SELECT uid FROM ot.context_proof_acks GROUP BY uid HAVING count(*)>1) repeated').n===0)
 p.keep(rig,{agents:names,grep:/context.*(size|full|split|retry)|after-turn compaction/})
 return p.summary()
}
