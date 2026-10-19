// Alpha14 review: root contact, structural chart, inspection and scope writes.
import { isDeepStrictEqual as same } from 'node:util'
import { Proof } from '../proof.mjs'
export async function setup() {
  return {fixture:{org:{name:'Project review gaps'},agents:[{name:'boss',tier:'sol',grant:100,org_visibility:'full'}]}}
}
export default async function(rig) {
  const p=new Proof('project-review-gaps')
  rig.scenario({default:{turns:[{steps:[{text:'OK.'}]}]}})
  const hire=(name,parent,extra={})=>rig.op({op:'hire',name,...(parent?{parent}:{}),tier:'sol',grant:0,...extra})
  const project=(name,parent)=>rig.op({op:'create_project',name,...(parent?{parent}:{})})
  const turn=async name=>{
    const before=rig.turns(name).filter(t=>t.ended_at).length
    await rig.userMail(name,'Synthetic review context.')
    await rig.waitTurns(name,before+1)
    return rig.fakeLog(name).filter(r=>r.kind==='turn').at(-1)?.prompt??''
  }
  await project('root');await project('root-nested','root')
  await hire('top-direct');await hire('top-wrapper','root');await hire('top-nested','root-nested')
  for(const name of ['top-direct','top-wrapper','top-nested']) {
    await turn(name)
    const grants=rig.sql(`SELECT grantor FROM ot.audiences WHERE grantee='${name}' AND grantor='@user' AND revoked_at IS NULL`)
    p.check(`${name}: direct user contact creates no redundant top-level grant`,grants.length===0,grants)
  }
  await rig.op({op:'move',node:'top-wrapper',new_parent:'boss'})
  const stale=await rig.tool('top-wrapper','orgtree_message',{to:'user',body:'No persistent top-level grant.',notice:true})
  p.check('top-level contact does not persist as user access after moving under an agent',!stale.ok,stale.text)

  await project('own-project','boss');await project('sibling-project','own-project');await project('unrelated-project')
  await hire('member','own-project',{org_visibility:'team'})
  for(const [node,allowed] of [['own-project',true],['sibling-project',true],['unrelated-project',false]]) {
    const r=await rig.tool('member','orgtree_state_inspect',{node})
    p.check(`team inspection of ${node}: ${allowed?'visible':'refused'}`,r.ok===allowed,r.text)
  }
  await rig.op({op:'retool',node:'boss',org_visibility:'full'})
  const prompt=await turn('boss')
  const state=prompt.slice(prompt.indexOf('[ORG STATE'),prompt.indexOf('[END ORG STATE]'))
  p.check('ORG STATE keeps root and nested projects as structural chart rows',/root \[project\]/.test(state)&&/root-nested \[project\]/.test(state)&&/own-project \[project\]/.test(state),state)
  p.check('reports roster contracts projects while chart preserves placement',state.split('\n').find(l=>l.startsWith('Your reports:'))?.includes('member')&&!state.split('\n').find(l=>l.startsWith('Your reports:'))?.includes('own-project'),state)
  // Simulate a pre-upgrade structural project entry in the same session.
  // Old contracted charts delete it and produce a false Removed delta.
  const pid=rig.agentRow('own-project').id
  rig.exec(`UPDATE ot.agents SET extra=jsonb_set(extra,'{envelope,org_state,entries,agent:${pid}}','{"key":"previous-structural-row","label":"own-project"}'::jsonb) WHERE name='boss'`)
  const next=await turn('boss')
  p.check('existing structural project entries never become removed project deltas',!next.includes('Removed: own-project'),next.slice(0,2500))

  await rig.op({op:'retool',node:'boss',tools:{web:false}})
  const snapshots=()=>rig.sql("SELECT id,name,scope,charter,team_charter,row_version FROM ot.agents WHERE name IN ('boss','own-project') ORDER BY id")
  const api=body=>rig.api('POST',`/api/orgs/${rig.org}/nodes/own-project/scope`,body).then(json=>({ok:true,json}),e=>({ok:false,error:e.message}))
  for(const patch of [{tools:{web:true}},{permission_mode:'bypassPermissions'},{org_visibility:'full'},{add_dirs:[]},{charter:'Agent-only charter'},{effort:'high'},{fast_mode:false},{},{peer_mail:false,tools:{}},{unexpected:true}]) {
    const before=snapshots(),r=await api(patch),after=snapshots()
    p.check(`project scope rejects ${Object.keys(patch).join('+')||'empty'} without project/ancestor writes`,!r.ok&&same(before,after),{r,before,after})
  }
  await project('peer-only','boss')
  const before=rig.one("SELECT scope,row_version FROM ot.agents WHERE name='boss'")
  const allowed=await rig.api('POST',`/api/orgs/${rig.org}/nodes/peer-only/scope`,{peer_mail:false})
  const raw=rig.one("SELECT scope FROM ot.agents WHERE name='peer-only'").scope
  p.check('peer-mail-only project scope writes preserve raw settings and do not raise ancestors',allowed.ok&&same(raw,{transparent:true,peer_mail:false})&&same(before,rig.one("SELECT scope,row_version FROM ot.agents WHERE name='boss'")),{allowed,raw})
  p.keep(rig,{agents:['boss','top-wrapper'],grep:/error|scope|audience/})
  return p.summary()
}
