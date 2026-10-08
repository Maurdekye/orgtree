import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import { runDesktop } from '../desktop.mjs';
import { rigHome } from '../lib.mjs';
const here=path.dirname(fileURLToPath(import.meta.url));
export async function setup(){return {fixture:{org:{name:'Next-turn cards'},agents:[{name:'rhea',tier:'luna',grant:4,title:'Queued-change proof'}],scenario:{default:{turns:[{steps:[{text:'OK.'}]}]}}}}}
export default async function(rig) {
 const evidence=path.join(rigHome(),'evidence','next-turn-cards-'+Date.now());
 await rig.waitFor(()=>rig.sql('SELECT 1 FROM ot.turns WHERE ended_at IS NULL').length===0,{what:'seed turn done',timeout:60000});
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
 const capture=async(stage,account)=>{
  const result=await runDesktop(rig,path.join(here,'../desktop/next-turn-cards.cjs'),{args:{stage,current,target:account},out:path.join(evidence,stage),timeout:60000});
  if(!result.ok)throw Error(JSON.stringify(result));
  return result.value;
 };
 const before=await capture('before',null);
 await rig.op({op:'account',node:'rhea',account:target});
 await rig.op({op:'switch_model',node:'rhea',tier:'sol'});
 const effort=await rig.api('POST',`/api/orgs/${rig.org}/nodes/rhea/scope`,{effort:'high'});
 if(effort.effort_delivery!=='next_turn')throw Error('effort not deferred: '+JSON.stringify(effort));
 const queued=await capture('queued',target);
 await rig.op({op:'account',node:'rhea',account:'primary'});
 const ambient=await capture('default','default');
 await rig.op({op:'account',node:'rhea',account:current});
 await rig.op({op:'switch_model',node:'rhea',tier:'luna'});
 await rig.api('POST',`/api/orgs/${rig.org}/nodes/rhea/scope`,{effort:'medium'});
 const cancelled=await capture('cancelled',null);
 await rig.op({op:'account',node:'rhea',account:target});
 await rig.op({op:'switch_model',node:'rhea',tier:'sol'});
 await rig.op({op:'retool',node:'rhea',effort:'high'});
 const retool=await capture('retool',target);
 return {ok:true,evidence,current,target,before,queued,ambient,cancelled,retool};
}
