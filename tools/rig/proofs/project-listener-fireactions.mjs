import {Proof} from '../proof.mjs'
export async function setup(){return {recover:true,fixture:{org:{name:'Durable listener actions'},agents:[{name:'boss',tier:'sol',grant:100}]}}}
export default async function(rig){
 const p=new Proof('project-listener-fireactions')
 await rig.op({op:'create_project',name:'sync-action',parent:'boss'})
 const project=rig.one("SELECT id,org_id FROM ot.agents WHERE name='sync-action'")
 rig.exec(`INSERT INTO ot.agents(org_id,name,parent_id,state,tier,born) SELECT ${project.org_id},'sync-worker-'||g,${project.id},'live','sol','synthetic' FROM generate_series(1,2) g;
 INSERT INTO ot.watchdogs(uid,org_id,owner_agent_id,name,kind,target,interval_s,state,memo)
 SELECT 'sync-listener-'||a.id,a.org_id,a.id,'sync-listener','project_listener','sync-action',600,'armed',jsonb_build_object('target_id',${project.id},'notice',true)
 FROM ot.agents a WHERE parent_id=${project.id}`)
 const watch=await rig.tool('boss','orgtree_watchdog',{action:'create',kind:'listener_watch',target:'sync-action',name:'release-group',count:2,notice:true,
   fire_actions:[{tool:'orgtree_project',args:{action:'fire_event',name:'sync-action',body:'durable-action-release'}}]})
 const heard=()=>rig.one("SELECT count(*)::int AS n FROM ot.mail WHERE body LIKE '%durable-action-release%' AND body LIKE '%PROJECT EVENT%' ").n
 p.check('durable watch fire still executes its project-event action',watch.ok&&heard()===2,{ok:watch.ok,heard:heard(),text:watch.text?.slice(0,300)})
 const added=await rig.tool('boss','orgtree_watchdog',{action:'create',kind:'project_listener',target:'sync-action',name:'third-listener',notice:true})
 const fired=rig.one("SELECT fired FROM ot.watchdogs WHERE name='release-group'").fired
 p.check('remaining above threshold does not repeat the fire action',added.ok&&fired===1&&heard()===2,{ok:added.ok,fired,heard:heard()})
 p.check('every completed notification obligation is durable and finished',rig.one(`SELECT count(*)::int n FROM ot.listener_fire_outbox WHERE project_id=${project.id} AND done`).n===3,
   rig.sql(`SELECT done,actions_claimed,delivery IS NOT NULL AS has_mail FROM ot.listener_fire_outbox WHERE project_id=${project.id} ORDER BY id`))
 return p.summary()
}
