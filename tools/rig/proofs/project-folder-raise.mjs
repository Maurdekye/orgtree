// Exact reported upward-folder raise: check project storage AND describe.
import fs from 'node:fs'
import path from 'node:path'
import { isDeepStrictEqual as same } from 'node:util'
import { Proof } from '../proof.mjs'

export async function setup() {
  return {fixture:{org:{name:'Project folder raise'},agents:[{name:'boss',tier:'sol',grant:30}]}}
}
export default async function(rig) {
  const p=new Proof('project-folder-raise')
  const folder=path.join(rig.data,'new-ro-folder');fs.mkdirSync(folder,{recursive:true})
  const summary='PTB Summary must survive an upward member folder grant.'
  const policy={peer_mail:false,slots:3,mail_queue:'ack',exclude_sender:true,ack_timeout:false,
    max_attempts:7,ack_reminders:5,turn_end_reminder:false}
  for(const [name,parent] of [['outer','boss'],['inner','outer']]) {
    await rig.op({op:'create_project',name,parent,description:summary})
    await rig.op({op:'configure_project',node:name,settings:policy})
  }
  await rig.op({op:'hire',name:'member',parent:'inner',tier:'sol',grant:0})
  const rows=()=>rig.sql(`SELECT id,name,scope,charter,row_version FROM ot.agents WHERE org_id=(SELECT id FROM ot.orgs WHERE slug='${rig.org}') AND kind='project' ORDER BY id`)
  const before=rows()
  // boss holds the granted folder, intermediate projects do not store agent
  // folders. Tool path matches the coordinator's retool, not desktop /scope.
  await rig.op({op:'retool',node:'boss',add_dirs:[{path:folder,mode:'ro'}]})
  const saved=rows()
  p.check('superior folder grant preserves nested project settings and Summary',same(before,saved),{before,saved})
  const result=await rig.tool('boss','orgtree_retool',{node:'member',add_dirs:[{path:folder,mode:'ro'}],account:'primary',effort:'high'})
  const after=rows()
  p.check('member upward add_dirs preserves every project setting, Summary and row version',result.ok&&same(after,saved),{result:result.json??result.text,after})
  p.check('upward folder raise never reports a project as cascaded or raised',result.ok&&!(result.json?.cascaded??[]).some(n=>['outer','inner'].includes(n))&&!(result.json?.raised??[]).some(n=>['outer','inner'].includes(n.node)),result.json??result.text)
  const member=rig.one(`SELECT scope FROM ot.agents WHERE id=${rig.agentRow('member').id}`).scope
  p.check('the requested read-only folder actually reaches the member',member.add_dirs?.some(d=>path.resolve(d.path)===path.resolve(folder)&&d.mode==='ro'),member.add_dirs)
  for(const name of ['outer','inner']) {
    const description=await rig.tool('boss','orgtree_project',{action:'describe',name})
    const settings=await rig.tool('boss','orgtree_project',{action:'settings',name})
    p.check(`${name}: describe retains the exact Summary after folder raise`,description.ok&&description.json?.description===summary,description.json??description.text)
    p.check(`${name}: project settings retain every slot and queue control`,settings.ok&&same(settings.json?.settings,{name,description:summary,...policy}),settings.json??settings.text)
  }
  p.check('reading descriptions/settings changes no project row',same(rows(),saved),rows())
  const cleared=await rig.tool('boss','orgtree_project',{action:'describe',name:'inner',description:''})
  p.check('explicit empty description still clears only the requested Summary',cleared.ok&&rows().find(r=>r.name==='inner').charter===null&&rows().find(r=>r.name==='outer').charter===summary)
  p.keep(rig,{agents:[],grep:/retool|project|error/})
  return p.summary()
}
