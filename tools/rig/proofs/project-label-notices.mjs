// Project structure must not be described as an agent report or coworker.
import { Proof } from '../proof.mjs'
export async function setup() {
  return {fixture:{org:{name:'Project labels'},agents:[{name:'boss',tier:'sol',grant:100}]}}
}
export default async function(rig) {
  const p=new Proof('project-label-notices')
  rig.scenario({default:{turns:[{steps:[{text:'OK.'}]}]}})
  await rig.op({op:'hire',name:'coworker',parent:'boss',tier:'sol',grant:0})
  await rig.op({op:'create_project',name:'workspace',parent:'boss'})
  const turn=async name=>{
    const before=rig.turns(name).filter(t=>t.ended_at).length
    await rig.userMail(name,'Read the latest project notice.')
    await rig.waitTurns(name,before+1)
    return rig.fakeLog(name).filter(r=>r.kind==='turn').at(-1)?.prompt??''
  }
  for(const [op,word] of [['retire','retired'],['rehire','restored'],['dissolve','dissolved']]) {
    const since=rig.one('SELECT coalesce(max(id),0)::bigint AS id FROM ot.mail').id
    await rig.op({op,node:'workspace'})
    const mail=rig.sql(`SELECT recipient_name,notice FROM ot.mail WHERE id>${since} AND sender='@system' AND kind='notice' ORDER BY id`)
    p.check(`${op}: exactly one passive notice to each affected agent`,JSON.stringify(mail.map(r=>r.recipient_name).sort())===JSON.stringify(['boss','coworker'])&&mail.every(r=>r.notice),mail)
    for(const name of ['boss','coworker']) {
      const prompt=await turn(name)
      p.check(`${op}: ${name} sees project wording without a false reporting role`,prompt.includes(`Project "workspace" was ${word} by the user.`)&&!/(?:report|peer) "workspace"/.test(prompt),prompt.slice(-5000))
    }
  }
  await rig.op({op:'hire',name:'funded',parent:'boss',tier:'sol',grant:20})
  await rig.op({op:'create_project',name:'funded-project',parent:'funded'})
  await rig.op({op:'hire',name:'funded-child',parent:'funded-project',tier:'sol',grant:3})
  const since=rig.one('SELECT coalesce(max(id),0)::bigint AS id FROM ot.mail').id
  await rig.op({op:'reallocate',node:'funded',delta:1})
  const expected=rig.one("SELECT ((SELECT grant_credits FROM ot.agents WHERE name='funded')-(SELECT seat+grant_credits FROM ot.agents WHERE name='funded-child'))::float8 AS free").free
  const notices=rig.sql(`SELECT ev FROM ot.mail WHERE id>${since} AND ev->>'variant'='access.grant_changed'`)
  p.check('credit notices subtract report holdings through projects',notices.length===2&&notices.every(r=>r.ev.free===expected),{notices,expected})
  // Agent actions do not add user history, leaving the original hire undoable.
  const hire=await rig.op({op:'hire',name:'new-manager',parent:'boss',tier:'sol',grant:0})
  const created=await rig.tool('new-manager','orgtree_project',{action:'create',name:'empty-child',index:0})
  p.check('undo fixture has a live empty project child',created.ok,created.text)
  const undo=await rig.api('POST',`/api/orgs/${rig.org}/undo-history/undo`,{id:hire.history_entry.id})
    .then(json=>({ok:true,json}),e=>({ok:false,json:e.body,text:e.message}))
  const message=JSON.stringify(undo)
  p.check('undo-hire refusal names child nodes rather than agent reports',message.includes('live child nodes')&&message.includes('empty-child')&&!message.includes('live reports'),undo)
  p.check('refused undo preserves both agent and project',rig.agentRow('new-manager').state==='live'&&rig.agentRow('empty-child').state==='live',undo)
  p.keep(rig,{agents:['boss','coworker'],grep:/error|undo/})
  return p.summary()
}
