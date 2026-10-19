// Exact counts matter: project placement must not manufacture reporting changes.
import { isDeepStrictEqual as same } from 'node:util'
import { Proof } from '../proof.mjs'

export async function setup() {
  return {fixture:{org:{name:'Project move notices'},agents:[{name:'boss',tier:'sol',grant:300}]}}
}
export default async function(rig) {
  const p=new Proof('project-move-notices')
  rig.scenario({default:{turns:[{steps:[{text:'OK.'}]}]}})
  const hire=(name,parent,grant=0)=>rig.op({op:'hire',name,parent,tier:'sol',grant})
  const project=(name,parent)=>rig.op({op:'create_project',name,parent})
  const mark=()=>rig.one('SELECT coalesce(max(id),0)::bigint AS id FROM ot.mail').id
  const rows=since=>rig.sql(`SELECT uid,recipient_name AS name,ev,notice FROM ot.mail WHERE id>${since} AND ev->>'variant'='lifecycle.moved' ORDER BY id`)
  const counts=(label,mail,expected)=>{
    p.check(`${label}: exactly one notice per intended recipient`,same(mail.map(r=>r.name).sort(),expected.sort()),mail)
    p.check(`${label}: all notices remain passive`,mail.length>0&&mail.every(r=>r.notice),mail)
  }
  const text=async row=>row?(await rig.tool(row.name,'orgtree_inbox',{action:'fetch',message_ids:[row.uid]})).text:''
  await hire('left','boss',70);await hire('right','boss',70)
  await hire('left-peer','left');await hire('right-peer','right')
  await project('left-project','left');await project('left-nested','left-project')
  await project('right-project','right')
  await hire('single','left')
  let since=mark()
  await rig.op({op:'move',node:'single',new_parent:'left-nested'})
  let mail=rows(since)
  counts('user same-superior move',mail,['single'])
  let rendered=await text(mail.find(r=>r.name==='single'&&r.ev.role==='self'))
  p.check('same-superior text states placement and unchanged superior',rendered.includes('left-nested')&&rendered.includes('still report to left')&&!rendered.includes('now report'),rendered)
  since=mark()
  const moved=await rig.tool('left','orgtree_move',{node:'single',new_parent:'left'})
  mail=rows(since)
  p.check('superior can move its report back out of a project',moved.ok,moved.text)
  counts('agent same-superior move',mail,['single'])
  since=mark()
  await rig.op({op:'move',node:'single',new_parent:'right-project'})
  mail=rows(since)
  counts('user different-superior move',mail,['single','left','right','left-peer','right-peer'])
  rendered=await text(mail.find(r=>r.name==='single'&&r.ev.role==='self'))
  p.check('different-superior text names actual reporting change',rendered.includes('now report to right')&&rendered.includes('left'),rendered)

  await project('moving','left');await project('moving-nested','moving')
  const members=['moving-a','moving-b','moving-c']
  for(const name of members) await hire(name,'moving-nested',name==='moving-a'?5:0)
  await hire('unchanged-child','moving-a')
  since=mark()
  await rig.op({op:'move',node:'moving',new_parent:'left-nested'})
  mail=rows(since)
  counts('same-superior wrapper move',mail,[...members])
  p.check('wrapper placement notices list every moved agent once',mail.length===3&&mail.every(r=>same(r.ev.nodes,members)&&r.ev.role==='self'),mail)
  since=mark()
  await rig.op({op:'move',node:'moving',new_parent:'right-project'})
  mail=rows(since)
  counts('different-superior wrapper move',mail,[...members,'left','right','left-peer','right-peer','single'])
  p.check('wrapper move aggregates the frontier for every recipient',mail.every(r=>same(r.ev.nodes,members)),mail)
  p.check('co-moved members receive only their own move notice',members.every(name=>mail.filter(r=>r.name===name).length===1&&mail.find(r=>r.name===name)?.ev.role==='self'),mail)
  rendered=await text(mail.find(r=>r.name==='right'))
  p.check('aggregate notice names every member and no project as a report',members.every(name=>rendered.includes(name))&&!rendered.includes('report "moving"'),rendered)

  // The destination superior was also a peer: superior role wins, never twice.
  await hire('nested-boss','left',10);await hire('overlap','left')
  since=mark()
  await rig.op({op:'move',node:'overlap',new_parent:'nested-boss'})
  mail=rows(since)
  counts('overlapping superior/peer roles',mail,['overlap','left','left-peer','nested-boss'])
  p.check('destination superior receives its superior role once',mail.filter(r=>r.name==='nested-boss').length===1&&mail.find(r=>r.name==='nested-boss')?.ev.role==='new_parent',mail)
  p.keep(rig,{agents:[],grep:/error|move/})
  return p.summary()
}
