// Project transparency at depth/width limits and empty/report-count boundaries.
import fs from 'node:fs'
import path from 'node:path'
import { Proof } from '../proof.mjs'

export async function setup() {
  return {recover:true,fixture:{org:{name:'Project edge cases'},agents:[{name:'boss',tier:'sol',grant:1000}]}}
}
export default async function(rig) {
  const p=new Proof('project-edge-cases')
  rig.scenario({default:{turns:[{steps:[{text:'OK.'}]}]}})
  const org=rig.one(`SELECT id FROM ot.orgs WHERE slug='${rig.org}'`).id
  const id=n=>rig.agentRow(n).id
  const project=(name,parent)=>rig.op({op:'create_project',name,...(parent?{parent}:{})})
  const hire=(name,parent,grant=0)=>rig.op({op:'hire',name,...(parent?{parent}:{}),tier:'sol',grant,org_visibility:'full'})
  await rig.op({op:'retool',node:'boss',org_visibility:'full'})

  // A count smoke and its runner baseline must use the same agent membership.
  await hire('watcher','boss',20)
  await project('count-outer','watcher');await project('count-inner','count-outer')
  await hire('count-child','count-inner')
  const dog=await rig.tool('watcher','orgtree_watchdog',{action:'create',name:'live-count',kind:'event',target:'agents.live',threshold:'below 2',notice:true,interval_s:5})
  const dogRow=()=>rig.one(`SELECT memo->'run' AS run,fired FROM ot.watchdogs WHERE owner_agent_id=${id('watcher')} AND name='live-count'`)
  await rig.waitFor(()=>dogRow()?.run?.counts?.['agents.live']!==undefined,{what:'count listener baseline',timeout:10000})
  p.check('count smoke excludes projects',dog.ok&&dog.json?.smoke?.current?.count===1,dog.json??dog.text)
  p.check('initial live-count baseline excludes projects',dogRow().run.counts['agents.live']===1,dogRow())
  await rig.op({op:'retool',node:'count-child',charter:'No live membership change.'})
  await rig.waitFor(()=>dogRow().run.counts['agents.live']===1,{what:'neutral event processed',timeout:10000})
  await new Promise(r=>setTimeout(r,700))
  p.check('a neutral tree operation never creates a false count crossing',Number(dogRow().fired)===0,dogRow())
  await hire('count-second','count-inner')
  await rig.waitFor(()=>dogRow().run.counts['agents.live']===2,{what:'real upward count transition',timeout:10000})
  await rig.op({op:'retire',node:'count-second'})
  await new Promise(r=>setTimeout(r,5500))
  p.check('a real downward count crossing fires exactly once',Number(dogRow().fired)===1,dogRow())
  await rig.tool('watcher','orgtree_watchdog',{action:'remove',id:'live-count'})
  const promoted=await rig.tool('watcher','orgtree_self_subjugate',{target:'count-child'})
  const promotion=rig.sql(`SELECT ev FROM ot.mail WHERE ev->>'variant'='lifecycle.subtree_promoted' AND ev->>'demoted'='watcher'`)
  p.check('promotion notices count agent reports, excluding empty project wrappers',promoted.ok&&promotion.length>0&&promotion.every(m=>m.ev.subtree===0),promotion)

  for(const shape of ['direct','one','nested','root','empty']) {
    let parent=shape==='root'?null:'boss'
    if(['one','nested','root'].includes(shape)) {await project(`above-${shape}`,parent);parent=`above-${shape}`}
    if(shape==='nested') {await project('above-inner',parent);parent='above-inner'}
    const name=`retire-${shape}`;await hire(name,parent)
    if(shape!=='direct') {await project(`empty-${shape}`,name);await project(`empty-inner-${shape}`,`empty-${shape}`)}
    const retired=await rig.tool(name,'orgtree_retire',{node:name})
    p.check(`${shape}: an agent with no agent reports can retire itself`,retired.ok&&rig.agentRow(name).state==='archived',retired.json??retired.text)
    p.check(`${shape}: empty project wrappers are not named as live reports`,retired.ok&&!retired.json?.warnings?.length,retired.json??retired.text)
  }
  await hire('has-report','boss',8);await project('report-wrapper','has-report');await hire('actual-report','report-wrapper')
  const denied=await rig.tool('has-report','orgtree_retire',{node:'has-report'})
  p.check('a live agent report through a project still blocks self-retirement',!denied.ok&&rig.agentRow('has-report').state==='live',denied.text)
  const retired=await rig.op({op:'retire',node:'has-report'})
  p.check('retire warning names the real report',retired.warnings?.some(w=>w.includes('[actual-report]')&&!w.includes('report-wrapper')),retired)
  await hire('archived-only','boss',4);await hire('old-report','archived-only');await rig.op({op:'retire',node:'old-report'})
  const noLive=await rig.tool('archived-only','orgtree_retire',{node:'archived-only'})
  p.check('an archived report does not block self-retirement',noLive.ok,noLive.text)

  // Credits must settle in one tree operation even beyond the old 64 passes.
  let parent='boss'
  const projects=[]
  for(let i=0;i<70;i++) {const name=`deep-${String(i).padStart(2,'0')}`;await project(name,parent);projects.push(id(name));parent=name}
  await hire('deep-leaf',parent,5);await hire('deep-grandchild','deep-leaf',1)
  const ledger=()=>rig.sql(`SELECT name,grant_credits::float8 AS grant,seat::float8 AS seat FROM ot.agents WHERE id IN (${projects}) ORDER BY id`)
  p.check('deep projects mirror first-agent stake without double-counting grandchildren',ledger().every(r=>r.grant===7&&r.seat===0),ledger())
  await rig.op({op:'reallocate',node:'deep-leaf',delta:-1})
  p.check('one credit cut settles every one of 70 nested project mirrors',ledger().every(r=>r.grant===6&&r.seat===0),ledger())
  await rig.op({op:'retire',node:'deep-leaf'})
  p.check('one retirement releases all 70 project mirrors',ledger().every(r=>r.grant===0&&r.seat===0),ledger())

  // Presentation authority and the fake CLI's launch instructions use the same list.
  const last=projects.at(-1),folder=path.join(rig.data,'scratch',rig.org,'_teams',String(last))
  fs.mkdirSync(folder,{recursive:true});const file=path.join(folder,'deep-proof.md');fs.writeFileSync(file,'Synthetic deepest project document.\n')
  const presented=await rig.tool('boss','orgtree_present',{title:'Deep project folder',path:file})
  p.check('project folders beyond the first 64 are readable for presentation',presented.ok,presented.text)
  const turns=rig.turns('boss').filter(t=>t.ended_at).length
  await rig.userMail('boss','Inspect synthetic project folder grants.');await rig.waitTurns('boss',turns+1)
  const instructions=rig.fakeLog('boss').filter(l=>l.kind==='recv'&&l.line?.method==='thread/start').at(-1)?.line?.params?.developerInstructions??''
  const text=instructions.replaceAll('\\','/').toLowerCase()
  const missing=projects.filter(n=>!text.includes(path.join(rig.data,'scratch',rig.org,'_teams',String(n)).replaceAll('\\','/').toLowerCase()+' (project '))
  p.check('CLI launch instructions expose every project folder below its superior',instructions.length>0&&missing.length===0,{missing,total:projects.length})

  await project('keep-root');await project('keep-nested','keep-root');await project('keep-empty')
  const moved=await rig.op({op:'move',node:'old-report',new_parent:'deep-69'})
  p.check('archived move warning names the nearest agent payer',moved.warnings?.some(w=>w.includes('falls on boss ')&&!w.includes('deep-69')),moved)
  const rootMove=await rig.op({op:'move',node:'old-report',new_parent:'keep-nested'})
  p.check('archived move under root projects names the user payer',rootMove.warnings?.some(w=>w.includes('falls on the user ')),rootMove)
  await hire('top-wrapped','keep-nested',10);await hire('top-child','top-wrapped')
  const roots=['keep-root','keep-nested','keep-empty']
  const settings=roots.map(name=>rig.one(`SELECT id,name,scope,charter FROM ot.agents WHERE id=${id(name)}`))
  await rig.api('POST',`/api/orgs/${rig.org}/dissolve-all`,{})
  p.check('retire-all archives every live agent',rig.one(`SELECT count(*)::int AS n FROM ot.agents WHERE org_id=${org} AND kind='agent' AND state='live'`).n===0)
  p.check('retire-all keeps root project wrappers and empty projects',roots.every(n=>rig.agentRow(n).state==='live'),roots.map(n=>rig.agentRow(n)))
  p.check('retire-all retains surviving project settings',settings.every(old=>{const now=rig.one(`SELECT scope,charter FROM ot.agents WHERE id=${old.id}`);return JSON.stringify(now.scope)===JSON.stringify(old.scope)&&now.charter===old.charter}))
  p.keep(rig,{agents:['boss'],grep:/watchdog|settle_credits|retire|dissolve/})
  return p.summary()
}
