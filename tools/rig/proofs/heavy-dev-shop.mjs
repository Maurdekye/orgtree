// Bounded synthetic creation/save proof. No real provider or live org is used.
import fs from 'node:fs'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {Proof} from '../proof.mjs'
export async function setup() { return {name:'heavy-dev-shop',fixture:'none',prepare:({dir})=>{
  const fake=path.join(dir,'fakecli');fs.mkdirSync(fake,{recursive:true})
  fs.writeFileSync(path.join(fake,'agy-models.txt'),'gemini-4-argon-high\tGemini 4 Argon (High)\n')
}} }
export default async function(rig) {
  const p=new Proof('heavy-dev-shop')
  const source=JSON.parse(fs.readFileSync(fileURLToPath(new URL('../../../engine/docs/templates/heavy-dev-shop.json',import.meta.url)),'utf8'))
  await rig.api('POST','/api/providers/agy-models/refresh')
  await rig.waitFor(async()=>((await rig.api('GET','/api/providers')).providers??[]).find(p=>p.id==='google')?.tiers?.some(t=>t.tier==='argon'),{what:'synthetic conditional Argon discovery',timeout:60000})
  await rig.waitFor(async()=>!(await rig.api('GET','/api/templates')).loading,{what:'synthetic model availability',timeout:30000})
  const plan=await rig.api('POST','/api/templates/resolve',{id:source.id,name:'Heavy proof',dirs:[]})
  p.check('the shipped template resolves all fifteen seats and one free project',plan.ok&&plan.agents.length===16&&plan.top_grant===80&&plan.standing_notes===7,plan)
  if(!plan.ok) return p.summary()
  const expect=Object.fromEntries(plan.agents.map(a=>[a.slot,a.tier]))
  const made=await rig.api('POST','/api/orgs',{name:'Heavy proof',dirs:[],net_autoconnect:false,template:{id:source.id,expect}})
  const slug=made.slug
  const rows=rig.sql(`SELECT a.id,a.name,a.tier,a.kind,a.scope,a.charter,a.scratch_dir,p.name AS parent,a.grant_credits::float8 AS grant,a.seat::float8 AS seat
    FROM ot.agents a JOIN ot.orgs o ON o.id=a.org_id LEFT JOIN ot.agents p ON p.id=a.parent_id
    WHERE o.slug='${slug}' AND a.state='live' ORDER BY a.id`)
  p.check('creation makes the exact hierarchy and all 64 seat credits plus 20 spare',made.hired.length===15&&made.projects?.length===1&&rows.length===16&&rows[1].parent==='liaison'&&rows[2].kind==='project'&&rows[2].seat===0&&rows[0].grant===80&&rows[1].grant===72&&rows[2].grant===56&&rows.reduce((n,r)=>n+r.seat,0)===64&&rows[2].grant===rows.slice(3).reduce((n,r)=>n+r.seat+r.grant,0)&&rows.slice(3).every(r=>r.parent==='build-slot'),rows.map(({name,parent,kind,seat,grant})=>({name,parent,kind,seat,grant})))
  p.check('coordinator has the explicit user audience',rig.one(`SELECT count(*)::int AS n FROM ot.audiences a JOIN ot.orgs o ON o.id=a.org_id WHERE o.slug='${slug}' AND a.grantee='coordinator' AND a.grantor='@user' AND a.revoked_at IS NULL`).n===1)
  p.check('project policy is three slots and coworker mail ON',rows[2].scope.slots_capacity===3&&rows[2].scope.peer_mail===true,rows[2].scope)
  const developer=fs.readFileSync(fileURLToPath(new URL('../../../engine/docs/charters/developer.md',import.meta.url)),'utf8')
  const developers=rows.filter(r=>r.name.startsWith('developer-'))
  p.check('all eleven created developers receive the complete Developer preset (normal hire trimming)',developers.length===11&&developers.every(r=>r.charter===developer.trim()))
  p.check('medium leadership, five medium developers, Sol/Argon high and exactly one Opus plus one Astra at max are stored',rows[0].scope.effort==='medium'&&rows[1].scope.effort==='medium'&&developers.filter(r=>r.scope.effort==='medium').length===5&&JSON.stringify(developers.filter(r=>r.scope.effort==='high').map(r=>r.name).sort())===JSON.stringify(['developer-argon','developer-sol-1','developer-sol-2','developer-sol-3'])&&JSON.stringify(developers.filter(r=>r.scope.effort==='max').map(r=>[r.name,r.tier]).sort())===JSON.stringify([['developer-astra-max','astra'],['developer-opus-max','opus']])&&rows.filter(r=>['test-rig','curator'].includes(r.name)).every(r=>r.tier==='sol'&&r.scope.effort==='high'))
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
  const savedWorkers=copy.agents[0].reports[0].reports[0].reports
  p.check('saving preserves spare credits and all eleven developer names, tiers and efforts',copy.agents[0].spare===4&&copy.agents[0].reports[0].spare===16&&savedWorkers.filter(s=>s.name.startsWith('developer-')).length===11&&savedWorkers.every(s=>{const original=source.agents[0].reports[0].reports[0].reports.find(r=>r.name===s.name);return original&&s.tier===original.tier&&s.effort===original.effort}))
  const second=await rig.api('POST','/api/orgs',{name:'Heavy saved copy',dirs:[],net_autoconnect:false,template:{id:copy.id}})
  p.check('saved project/notes template creates another isolated org',second.hired.length===15&&second.projects?.length===1&&second.standing_notes?.created===(saved.content.match(/"(?:shared|team|scratch)_agents_md"/g)??[]).length,second)
  // Recognizable secret controls are synthetic, never actual credentials.
  fs.writeFileSync(path.join(scratch,'_shared','AGENTS.md'),'password=synthetic-secret-value')
  const refused=await rig.api('POST',`/api/orgs/${slug}/template`,{name:'Never export credential',include:{standing_notes:true}}).then(()=>null,e=>e)
  p.check('credential-containing notes refuse export without writing a template',refused?.status===422&&!fs.existsSync(path.join(rig.data,'rig-home','.orgtree','templates','never-export-credential.json')))
  fs.writeFileSync(path.join(scratch,'_shared','AGENTS.md'),source.shared_agents_md)
  return p.summary()
}
