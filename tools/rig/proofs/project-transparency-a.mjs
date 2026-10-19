// Stage A: projects are invisible to supervisory runtime alerts and scope
// propagation. All fault injection and migration rehearsal use this scratch DB.
import { isDeepStrictEqual as same } from 'node:util'
import { Proof } from '../proof.mjs'

export async function setup() {
  return { recover: true, fixture: { org: { name: 'Project transparency A' },
    agents: [{ name: 'boss', tier: 'sol', grant: 200 }] } }
}

const migration = '0035_project_supervision'
const limited = () => ({ match: 'PT-LIMIT', once: true, steps: [
  { rate_limit: { primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: Math.floor(Date.now()/1000)+7200 } } },
  { error: { message: "You've hit your usage limit. Try again later.", codexErrorInfo: 'usageLimitExceeded' } },
] })
const ordinary = { steps: [{ text: 'OK.' }] }
const policy = { peer_mail: false, slots: 3, mail_queue: 'ack', exclude_sender: true,
  ack_timeout: false, max_attempts: 7, ack_reminders: 5, turn_end_reminder: false }

export default async function(rig) {
  const p = new Proof('project-transparency-a')
  const shapes = [
    { name: 'direct', parent: 'boss', recipient: 'boss' },
    { name: 'one', parent: 'one-project', recipient: 'boss' },
    { name: 'nested', parent: 'inner-project', recipient: 'boss' },
    { name: 'root', parent: 'root-inner', recipient: '@user' },
  ]
  const agents = Object.fromEntries(shapes.map(s => [s.name, { turns: [limited(),
    { match: 'PT-TERMINAL', times: 2, steps: [{ error: { message: 'permanent fixture refusal', codexErrorInfo: 'other' } }] },
    { match: 'PT-LAUNCH', times: 2, steps: [{ start_error: 'fixture refused turn start' }] },
  ] }]))
  for (const s of shapes) agents[`${s.name}-recovery`] = { turns: [
    { match: 'PT-NET', once: true, steps: [{ text: 'Starting.' }, { exit: 1 }] },
    { match: 'PT-AUTH', times: 2, steps: [{ result: { is_error: true, api_error_status: 401, text: 'fixture credential rejected' } }] },
  ] }
  rig.scenario({ agents, default: { turns: [ordinary] } })
  const project = (name,parent) => rig.op({ op:'create_project',name,...(parent?{parent}:{}),description:'Synthetic project' })
  await project('one-project','boss')
  await project('outer-project','boss')
  await project('inner-project','outer-project')
  await project('empty-project','boss')
  await project('root-project')
  await project('root-inner','root-project')
  for (const s of shapes) {
    await rig.op({op:'hire',name:s.name,parent:s.parent,tier:'sol',grant:0,account_fallback:false})
    await rig.op({op:'hire',name:`${s.name}-recovery`,parent:s.parent,tier:'sonnet',grant:0,account_fallback:false})
  }
  const orgId = rig.one(`SELECT id FROM ot.orgs WHERE slug='${rig.org}' AND state='active'`).id
  const id = name => rig.agentRow(name).id
  const scope = name => rig.one(`SELECT scope FROM ot.agents WHERE id=${id(name)}`).scope
  const unstick = name => rig.api('POST',`/api/orgs/${rig.org}/nodes/${name}/unstick`,{})
  const reports = (subject,variant) => rig.sql(`SELECT recipient_name,recipient_kind,notice,ev FROM ot.mail
    WHERE org_id=${orgId} AND ev->>'variant'='${variant}' AND ev->>'report'='${subject}' ORDER BY id`)
  const checkReport = async (s,variant,count=1) => {
    await rig.waitFor(()=>reports(s.name,variant).length>=count,{what:`${s.name} ${variant}`,timeout:2500}).catch(()=>null)
    const rows=reports(s.name,variant)
    p.check(`${s.name}: ${variant} goes exactly to real supervisor/user`,rows.length===count && rows.every(r=>
      r.recipient_name===s.recipient && r.ev.audience===(s.recipient==='@user'?'user':'superior') && !r.notice),rows)
    return rows
  }
  const settle = async name => {
    const before=rig.turns(name).filter(t=>t.ended_at).length
    await rig.userMail(name,'PT-GOOD: complete normally and clear the failure episode.')
    await rig.waitTurns(name,before+1)
  }

  for (const s of shapes) {
    await rig.userMail(s.name,'PT-LIMIT: hold this request.')
    await rig.waitFor(()=>rig.agentRow(s.name)?.frozen,{what:`${s.name} limit freeze`,timeout:45000})
    await checkReport(s,'runtime.report_limited')
    const before=rig.turns(s.name).filter(t=>t.ended_at).length
    await unstick(s.name)
    await rig.waitTurns(s.name,before+1)
    p.check(`${s.name}: manual release keeps recovery behavior`,!rig.agentRow(s.name).frozen)

    for (let n=0;n<2;n++) {
      const before=rig.turns(s.name).filter(t=>t.ended_at).length
      await rig.userMail(s.name,`PT-TERMINAL ${n}`)
      await rig.waitTurns(s.name,before+1)
    }
    await checkReport(s,'runtime.report_stalled')
    await settle(s.name)
    const own=()=>rig.sql(`SELECT notice FROM ot.mail WHERE recipient_agent_id=${id(s.name)} AND ev->>'variant'='runtime.turn_failed_terminal'`)
    for (let n=1;n<=2;n++) {
      await rig.userMail(s.name,`PT-LAUNCH ${n}`)
      await rig.waitFor(()=>rig.fakeLog(s.name).filter(x=>x.kind==='turn_refused').length>=n,{what:`${s.name} refused start`,timeout:45000})
      await rig.waitFor(()=>Number(rig.agentRow(s.name).extra?.hard_fail_run)>=n,{what:'settled launch error',timeout:15000})
    }
    const launched=await checkReport(s,'runtime.report_stalled',2)
    p.check(`${s.name}: launch tells own agent once passively; retains typed cause`,own().length===1 && own()[0].notice===true
      && launched.at(-1)?.ev.cause==='terminal' && /fixture refused/.test(launched.at(-1)?.ev.err??''),own())
    await settle(s.name)
  }

  // Seed only a scratch retry counter: the NEXT real fake-CLI failure takes
  // the exhausted branch without waiting through production backoff timers.
  for (const shape of shapes) {
    const s={...shape,name:`${shape.name}-recovery`}
    rig.exec(`UPDATE ot.agents SET extra=extra || '{"net_fail_run":4}'::jsonb WHERE id=${id(s.name)}`)
    const before=rig.turns(s.name).filter(t=>t.ended_at).length
    await rig.userMail(s.name,'PT-NET: start then die mid-response.')
    await rig.waitTurns(s.name,before+1,{timeout:60000})
    await checkReport(s,'runtime.report_stalled_repeated')
    p.check(`${s.name}: exhausted retries retain subject notice`,rig.sql(`SELECT id FROM ot.mail WHERE recipient_agent_id=${id(s.name)} AND ev->>'variant'='runtime.turn_failed_repeated'`).length===1)
    await settle(s.name)
    await rig.userMail(s.name,'PT-AUTH: reject this credential.')
    await rig.waitFor(()=>rig.agentRow(s.name)?.frozen?.parked,{what:`${s.name} parked`,timeout:45000})
    await checkReport(s,'runtime.report_parked')
    await unstick(s.name)
    await rig.waitFor(()=>Number(rig.agentRow(s.name).extra?.parked_run)>=2,{what:`${s.name} same parked episode`,timeout:45000})
    p.check(`${s.name}: parked announcement remains once per episode`,reports(s.name,'runtime.report_parked').length===1)
  }
  p.check('no supervisory report ever enters a project queue',rig.sql(`SELECT m.id FROM ot.mail m JOIN ot.agents a ON a.id=m.recipient_agent_id WHERE a.kind='project' AND m.ev->>'variant' LIKE 'runtime.report_%'`).length===0)

  // First real-agent frontier including an inactive manager: the runtime
  // fallback is nearest LIVE agent, rather than the inactive agent or project.
  await rig.op({op:'hire',name:'inactive-manager',parent:'boss',tier:'sol',grant:15})
  await project('inactive-wrapper','inactive-manager')
  await rig.op({op:'hire',name:'inactive-worker',parent:'inactive-wrapper',tier:'sol'})
  rig.exec(`UPDATE ot.agents SET state='archived' WHERE id=${id('inactive-manager')}`)
  const liveSuperior=rig.sql("SELECT to_regprocedure('ot.live_superior_of(bigint)') IS NOT NULL AS present")[0]?.present
  p.check('shared live-superior helper skips projects and inactive agents',liveSuperior && rig.one(`SELECT ot.live_superior_of(${id('inactive-worker')}) AS id`)?.id===id('boss'))

  // Scope mutation: controls remain on the project while the agent below is
  // still permanently restricted. Empty/nested project rows are both covered.
  await rig.op({op:'hire',name:'scope-manager',parent:'boss',tier:'sol',grant:25})
  await project('scope-outer','scope-manager')
  await project('scope-inner','scope-outer')
  await project('scope-empty','scope-manager')
  await rig.op({op:'hire',name:'scope-worker',parent:'scope-inner',tier:'sol'})
  const scopes=()=>rig.sql(`SELECT id,name,scope,charter,row_version FROM ot.agents WHERE name IN ('scope-outer','scope-inner','scope-empty') AND org_id=${orgId} ORDER BY id`)
  for (const n of scopes()) await rig.op({op:'configure_project',node:n.name,settings:policy})
  const saved=scopes()
  p.check('fixture projects have a nonempty Summary before scope edits',saved.every(n=>n.charter==='Synthetic project'))
  await rig.op({op:'retool',node:'scope-manager',tools:{web:false}})
  p.check('restriction never writes a nested or empty project scope',scopes().every((n,i)=>same(n.scope,saved[i].scope) && n.row_version===saved[i].row_version),scopes().map(n=>({name:n.name,scope:n.scope})))
  p.check('restriction still persists on real descendant agents',scope('scope-worker').tools?.web===false)
  p.check('retool preserves every project Summary',scopes().every((n,i)=>n.charter===saved[i].charter))
  // Reset only synthetic damage so the upward check is independent on red.
  for (const n of saved) rig.exec(`UPDATE ot.agents SET scope='${JSON.stringify(n.scope).replaceAll("'","''")}'::jsonb WHERE id=${n.id}`)
  const beforeRaise=scopes()
  const raised=await rig.op({op:'retool',node:'scope-worker',tools:{web:true},org_visibility:'full'})
  p.check('agent retool raises only real ancestors, preserving project config',scopes().every((n,i)=>same(n.scope,beforeRaise[i].scope) && n.row_version===beforeRaise[i].row_version) && !(raised.cascaded??[]).some(n=>saved.some(p=>p.name===n)),raised.cascaded)
  await rig.op({op:'retool',node:'scope-manager',tools:{web:false},org_visibility:'team'})
  for (const n of saved) rig.exec(`UPDATE ot.agents SET scope='${JSON.stringify(n.scope).replaceAll("'","''")}'::jsonb WHERE id=${n.id}`)
  const beforeHttp=scopes()
  await rig.api('POST',`/api/orgs/${rig.org}/nodes/scope-worker/scope`,{tools:{web:true},org_visibility:'full'})
  p.check('desktop upward grant skips project scope writes',scopes().every((n,i)=>same(n.scope,beforeHttp[i].scope) && n.row_version===beforeHttp[i].row_version))

  // Moving into a project and moving a whole project subtree must retain
  // both sides' policy and Summary, despite changed credits/row versions.
  const projectSettings=()=>rig.sql(`SELECT id,scope,charter FROM ot.agents WHERE org_id=${orgId} AND kind='project' ORDER BY id`)
  const beforeMove=projectSettings()
  await rig.op({op:'move',node:'scope-worker',new_parent:'inner-project'})
  p.check('moving an agent through projects retains all project settings and Summaries',same(projectSettings(),beforeMove))
  await rig.op({op:'move',node:'scope-worker',new_parent:'scope-inner'})
  await rig.op({op:'move',node:'scope-outer',new_parent:'outer-project'})
  p.check('moving a nested project subtree retains settings and Summaries',same(projectSettings(),beforeMove))
  await rig.op({op:'moves',moves:[{node:'scope-outer',new_parent:'scope-manager'},{node:'scope-worker',new_parent:'scope-empty'}]})
  p.check('batch moves retain project settings and Summaries',same(projectSettings(),beforeMove))

  // Rehearse an upgrade ONLY through the engine startup migration path.
  // All surviving current settings, including an unknown future key, survive.
  await project('repair-empty','boss')
  const damaged={...saved[0].scope,transparent:false,tools:{web:false},future_project_setting:{keep:7}}
  rig.exec(`UPDATE ot.agents SET scope='${JSON.stringify(damaged).replaceAll("'","''")}'::jsonb WHERE id=${saved[0].id};
    UPDATE ot.agents SET scope='{}'::jsonb WHERE id=${id('repair-empty')};
    DELETE FROM public.ot_migrations WHERE name='${migration}'`)
  await rig.restart()
  const repaired=scopes().find(n=>n.id===saved[0].id)
  const want={...damaged,transparent:true}
  p.check('startup repairs transparency and preserves every surviving setting',same(repaired.scope,want),repaired.scope)
  p.check('startup repairs an empty damaged project scope',scope('repair-empty').transparent===true)
  p.check('repair is a registered one-time migration',!!rig.one(`SELECT name FROM public.ot_migrations WHERE name='${migration}'`))
  const version=repaired.row_version
  await rig.restart()
  p.check('second startup does not repeat the repair write',scopes().find(n=>n.id===saved[0].id).row_version===version)
  p.keep(rig,{agents:shapes.map(s=>s.name),grep:/report|parked|project|migration/i})
  return p.summary()
}
