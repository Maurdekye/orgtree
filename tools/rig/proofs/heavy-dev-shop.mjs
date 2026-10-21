// Bounded synthetic creation/save proof. No real provider or live org is used.
import fs from 'node:fs'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {Proof} from '../proof.mjs'
export async function setup() { return {name:'heavy-dev-shop',fixture:'none'} }
export default async function(rig) {
  const p=new Proof('heavy-dev-shop')
  const source=JSON.parse(fs.readFileSync(fileURLToPath(new URL('../../../engine/docs/templates/heavy-dev-shop.json',import.meta.url)),'utf8'))
  await rig.waitFor(async()=>!(await rig.api('GET','/api/templates')).loading,{what:'synthetic model availability',timeout:30000})
  const plan=await rig.api('POST','/api/templates/resolve',{id:source.id,name:'Heavy proof',dirs:[]})
  p.check('the shipped template resolves all nine seats and one free project',plan.ok&&plan.agents.length===10&&plan.top_grant===48&&plan.standing_notes===7,plan)
  if(!plan.ok) return p.summary()
  const expect=Object.fromEntries(plan.agents.map(a=>[a.slot,a.tier]))
  const made=await rig.api('POST','/api/orgs',{name:'Heavy proof',dirs:[],net_autoconnect:false,template:{id:source.id,expect}})
  const slug=made.slug
  const rows=rig.sql(`SELECT a.id,a.name,a.tier,a.kind,a.scope,a.scratch_dir,p.name AS parent,a.grant_credits::float8 AS grant,a.seat::float8 AS seat
    FROM ot.agents a JOIN ot.orgs o ON o.id=a.org_id LEFT JOIN ot.agents p ON p.id=a.parent_id
    WHERE o.slug='${slug}' AND a.state='live' ORDER BY a.id`)
  p.check('creation makes the exact hierarchy with no project seat or grant',made.hired.length===9&&made.projects?.length===1&&rows.length===10&&rows[1].parent==='liaison'&&rows[2].kind==='project'&&rows[2].seat===0&&rows[2].grant===0&&rows.slice(3).every(r=>r.parent==='build-slot'),rows)
  p.check('coordinator has the explicit user audience',rig.one(`SELECT count(*)::int AS n FROM ot.audiences a JOIN ot.orgs o ON o.id=a.org_id WHERE o.slug='${slug}' AND a.grantee='coordinator' AND a.grantor='@user' AND a.revoked_at IS NULL`).n===1)
  p.check('project policy is three slots and coworker mail ON',rows[2].scope.slots_capacity===3&&rows[2].scope.peer_mail===true,rows[2].scope)
  const scratch=path.join(rig.data,'scratch',slug)
  const byName=Object.fromEntries(rows.map(r=>[r.name,r]))
  let count=0,allNotes=true
  const verify=(file,want)=>{count++;allNotes=allNotes&&fs.readFileSync(file,'utf8')===want}
  verify(path.join(scratch,'_shared','AGENTS.md'),source.shared_agents_md)
  const walk=slots=>{for(const slot of slots){const r=byName[slot.name];if(slot.team_agents_md)verify(path.join(scratch,'_teams',String(r.id),'AGENTS.md'),slot.team_agents_md);if(slot.scratch_agents_md)verify(path.join(r.scratch_dir,'AGENTS.md'),slot.scratch_agents_md);walk(slot.reports??[])}}
  walk(source.agents)
  p.check('all seven notes are in the correct new org folders before any turn',count===7&&allNotes&&made.standing_notes?.created===7&&made.standing_notes?.warnings.length===0,{count,result:made.standing_notes})
  const mail=rig.one(`SELECT count(*)::int AS n FROM ot.mail m JOIN ot.orgs o ON o.id=m.org_id WHERE o.slug='${slug}' AND m.ev->>'variant'='lifecycle.kickoff'`)
  p.check('creation without first-message opt-in starts no kickoff',mail.n===0,mail)
  const without=await rig.api('POST',`/api/orgs/${slug}/template`,{name:'Heavy without notes',include:{standing_notes:false}})
  p.check('saving leaves standing notes out unless opted in',!without.content.includes('shared_agents_md')&&!without.content.includes('team_agents_md')&&!without.content.includes('scratch_agents_md'))
  const saved=await rig.api('POST',`/api/orgs/${slug}/template`,{name:'Heavy with notes',include:{standing_notes:true}})
  const copy=JSON.parse(saved.content)
  p.check('opt-in captures shared, project and personal notes and preserves the project tree',copy.shared_agents_md===source.shared_agents_md&&copy.agents[0].scratch_agents_md===source.agents[0].scratch_agents_md&&copy.agents[0].reports[0].reports[0].tier==='project'&&copy.agents[0].reports[0].reports[0].team_agents_md===source.agents[0].reports[0].reports[0].team_agents_md)
  const second=await rig.api('POST','/api/orgs',{name:'Heavy saved copy',dirs:[],net_autoconnect:false,template:{id:copy.id}})
  p.check('saved project/notes template creates another isolated org',second.hired.length===9&&second.projects?.length===1&&second.standing_notes?.created===7,second)
  // Recognizable secret controls are synthetic, never actual credentials.
  fs.writeFileSync(path.join(scratch,'_shared','AGENTS.md'),'password=synthetic-secret-value')
  const refused=await rig.api('POST',`/api/orgs/${slug}/template`,{name:'Never export credential',include:{standing_notes:true}}).then(()=>null,e=>e)
  p.check('credential-containing notes refuse export without writing a template',refused?.status===422&&!fs.existsSync(path.join(rig.data,'rig-home','.orgtree','templates','never-export-credential.json')))
  fs.writeFileSync(path.join(scratch,'_shared','AGENTS.md'),source.shared_agents_md)
  return p.summary()
}
