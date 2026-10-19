// User 2026-10-19 20:35Z: peer mail uses placement, command-chain mail does not.
import { Proof } from '../proof.mjs'
export async function setup() {
  return {fixture:{org:{name:'Project mail boundaries'},agents:[{name:'boss',tier:'sol',grant:120}]}}
}
export default async function(rig) {
  const p=new Proof('project-mail-boundaries')
  rig.scenario({default:{turns:[{steps:[{text:'OK.'}]}]}})
  const hire=(name,parent,grant=0)=>rig.op({op:'hire',name,parent,tier:'sol',grant})
  const project=(name,parent)=>rig.op({op:'create_project',name,...(parent?{parent}:{})})
  const send=(from,to)=>rig.tool(from,'orgtree_message',{to,body:'Synthetic mail boundary proof.',notice:true})
  const aud=(who,args)=>rig.tool(who,'orgtree_audience',args)
  await project('outer','boss');await project('inner','outer');await project('other','boss')
  await hire('a','inner',5);await hire('b','inner');await hire('c','other');await hire('direct','boss')
  await hire('child','a')
  for(const [from,to,allowed] of [['a','b',true],['b','a',true],['a','c',false],['c','a',false],['a','direct',false],['direct','a',false],['a','boss',true],['boss','a',true],['boss','child',true]]) {
    const r=await send(from,to)
    p.check(`${from} -> ${to}: ${allowed?'allowed':'requires an audience'}`,r.ok===allowed,r.text)
  }
  const allowed=await aud('a',{action:'grant',from:'child',target:'b'})
  const refused=await aud('a',{action:'grant',from:'child',target:'c'})
  const superior=await aud('a',{action:'grant',from:'child',target:'boss'})
  p.check('an agent delegates its physical peer and actual superior, not a cross-project coworker',allowed.ok&&!refused.ok&&superior.ok,{allowed:allowed.text,refused:refused.text,superior:superior.text})
  p.check('refused cross-project delegation creates no grant',rig.one("SELECT count(*)::int AS n FROM ot.audiences WHERE grantee='child' AND grantor='c' AND revoked_at IS NULL").n===0)
  await rig.op({op:'configure_project',node:'inner',settings:{peer_mail:false}})
  for(const [from,to,ok] of [['a','b',false],['b','a',false],['a','boss',true],['boss','a',true]]) {
    const r=await send(from,to);p.check(`OFF: ${from} -> ${to}`,r.ok===ok,r.text)
  }
  const wrap=await rig.tool('a','orgtree_project',{action:'create',name:'wrapped',above:'a',index:0})
  p.check('self-wrap remains permitted as a structural operation',wrap.ok,wrap.text)
  const after=await send('a','b'),reverse=await send('b','a'),up=await send('a','boss')
  p.check('self-wrap does not escape the mail boundary',!after.ok&&!reverse.ok&&up.ok,{after:after.text,reverse:reverse.text,up:up.text})
  const ask=await aud('a',{action:'request',target:'c'})
  const grant=await aud('c',{action:'grant',from:'a'})
  const forward=await send('a','c'),back=await send('c','a')
  p.check('a requested directional audience permits cross-project mail in that direction only',ask.ok&&grant.ok&&forward.ok&&!back.ok,{ask:ask.text,grant:grant.text,forward:forward.text,back:back.text})
  await project('root-one');await project('root-two')
  await hire('root-a','root-one');await hire('root-b','root-two');await hire('root-peer','root-one')
  const crossRoot=await send('root-a','root-b'),sameRoot=await send('root-a','root-peer'),user=await send('root-a','user')
  p.check('root projects also bound peers, while top-level user reach stays intact',!crossRoot.ok&&sameRoot.ok&&user.ok,{crossRoot:crossRoot.text,sameRoot:sameRoot.text,user:user.text})
  p.keep(rig,{agents:[],grep:/error|audience/})
  return p.summary()
}
