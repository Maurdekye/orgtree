import { SEED_SETTLE_TIMEOUT } from '../seed-settle.mjs'
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import { runDesktop } from '../desktop.mjs';
import { Proof } from '../proof.mjs';
const here=path.dirname(fileURLToPath(import.meta.url));
export async function setup(){return {fixture:{org:{name:'Next-turn cards'},agents:[{name:'rhea',tier:'luna',grant:4,title:'Queued-change proof'}],scenario:{default:{turns:[{steps:[{text:'OK.'}]}]}}}}}
export default async function(rig) {
 const p=new Proof('next-turn-cards');
 const evidence=p.dir;
 let phase='fixture setup';
 try {
 await rig.waitFor(()=>rig.sql('SELECT 1 FROM ot.turns WHERE ended_at IS NULL').length===0,{what:'seed turn done',timeout:SEED_SETTLE_TIMEOUT});
 const add=async(n)=>{
  const home=path.join(rig.data,'rig-home','codex-'+n);fs.mkdirSync(home,{recursive:true});
  const enc=x=>Buffer.from(JSON.stringify(x)).toString('base64url');
  fs.writeFileSync(path.join(home,'auth.json'),JSON.stringify({OPENAI_API_KEY:null,tokens:{id_token:`${enc({alg:'none'})}.${enc({email:n+'@example.invalid'})}.rig`}}));
  return (await rig.api('POST','/api/accounts',{provider:'openai',kind:'imported',path:home})).id;
 };
 const current=await add('first'), target=await add('second');
 await rig.op({op:'account',node:'rhea',account:current});
 await rig.api('POST',`/api/orgs/${rig.org}/nodes/rhea/scope`,{effort:'medium'});
 rig.scenario({agents:{rhea:{turns:[{match:'LONG',steps:[{text:'Working while changes wait.'},{sleep_ms:600000}]}]}},default:{turns:[{steps:[{text:'OK.'}]}]}});
 await rig.userMail('rhea','LONG work');
 await rig.waitFor(()=>rig.fakeLog('rhea').some(x=>x.kind==='turn'&&JSON.stringify(x).includes('LONG'))||rig.sql("SELECT 1 FROM ot.turns WHERE ended_at IS NULL").length>0,{what:'long turn',timeout:30000});
 p.check('synthetic accounts and long-running serving turn are ready',true,{current,target});
 const capture=async(stage,account,model='sol')=>{
  phase=stage;
  const result=await runDesktop(rig,path.join(here,'../desktop/next-turn-cards.cjs'),{args:{stage,current,target:account,model},out:path.join(evidence,stage),timeout:60000});
  p.file(`${stage}/desktop-result.json`,result);
  // The driver saves each guard before it can throw, so an early failure
  // retains its named verdicts as well as the desktop error and screenshot.
  const checksFile=path.join(evidence,stage,'checks.json');
  const checks=fs.existsSync(checksFile)?JSON.parse(fs.readFileSync(checksFile,'utf8')):[];
  for(const check of checks)p.check(`${stage}: ${check.what}`,check.ok===true,check.detail);
  p.check(`${stage}: desktop driver completed with counted guards`,result.ok===true&&result.exit===0&&checks.length>0,result.error);
  if(!result.ok)throw Error(JSON.stringify(result));
  if(result.exit!==0||!checks.length||checks.some(c=>c.ok!==true))throw Error(`${stage}: invalid desktop verdicts`);
  return result.value;
 };
 const before=await capture('before',null);
 phase='queue account, model and effort';
 await rig.op({op:'account',node:'rhea',account:target});
 await rig.op({op:'switch_model',node:'rhea',tier:'sol'});
 const effort=await rig.api('POST',`/api/orgs/${rig.org}/nodes/rhea/scope`,{effort:'high'});
 p.check('effort change is deferred to the next turn',effort.effort_delivery?.delivery==='next_turn',effort);
 if(effort.effort_delivery?.delivery!=='next_turn')throw Error('effort not deferred: '+JSON.stringify(effort));
 const queued=await capture('queued',target);
 phase='retarget account to default';
 await rig.op({op:'account',node:'rhea',account:'primary'});
 const ambient=await capture('default','default');
 phase='cancel queued changes';
 await rig.op({op:'account',node:'rhea',account:current});
 await rig.op({op:'switch_model',node:'rhea',tier:'luna'});
 await rig.api('POST',`/api/orgs/${rig.org}/nodes/rhea/scope`,{effort:'medium'});
 const cancelled=await capture('cancelled',null);
 phase='queue through retool';
 await rig.op({op:'account',node:'rhea',account:target});
 await rig.op({op:'switch_model',node:'rhea',tier:'sol'});
 await rig.op({op:'retool',node:'rhea',effort:'high'});
 const retool=await capture('retool',target);
 phase='queue long Antigravity model label';
 await rig.op({op:'account',node:'rhea',account:'primary'});
 await rig.api('PUT','/api/app-settings/runtime',{antigravity_claude_enabled:true});
 await rig.op({op:'switch_model',node:'rhea',tier:'agy-sonnet',account:'primary'});
 const longLabel=await capture('long-label','default','sonnet (antigravity)');
 return {current,target,before,queued,ambient,cancelled,retool,longLabel,...p.summary()};
 }catch(error){
  p.check(`${phase}: proof completed without setup or driver error`,false,String(error?.stack||error));
  return p.summary();
 }
}
