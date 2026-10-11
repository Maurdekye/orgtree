import { Proof } from '../proof.mjs'
import { spawn } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs'

export default async function (rig) {
  const p = new Proof('parent-hire')
  rig.scenario({ default: { turns: [{ name: 'default', steps: [{ text: 'OK.' }] }] } })
  await rig.waitFor(() => rig.sql(`SELECT 1 FROM ot.turns WHERE ended_at IS NULL`).length === 0, { timeout: 60000, what: 'seed turns' })
  const ORG = `(SELECT id FROM ot.orgs WHERE slug='${rig.org}' AND state='active')`
  const ledger = () => Object.fromEntries(rig.sql(`SELECT a.id,a.name,a.parent_id,a.state,a.seat::float8 AS seat,a.grant_credits::float8 AS grant,a.sibling_order::float8 AS ord,a.scope,a.account,
    a.grant_credits::float8-coalesce((SELECT sum(c.seat+c.grant_credits) FROM ot.agents c WHERE c.parent_id=a.id AND c.state='live'),0)::float8 AS free
    FROM ot.agents a WHERE a.org_id=${ORG} AND a.state<>'deleted'`).map(a => [a.name,a]))
  const stake = a => a.seat+a.grant
  const near = (a,b) => Math.abs(a-b)<1e-6
  const roots = L => Object.values(L).filter(a=>a.state==='live'&&a.parent_id===null).reduce((n,a)=>n+stake(a),0)
  const valid = () => Object.values(ledger()).filter(a=>a.state==='live').every(a=>a.free>=-1e-6)
  const hire = (name,grant,parent) => rig.op({op:'hire',name,tier:'haiku',grant,...(parent?{parent}:{}),charter:'Isolated proof agent.'})
  const parent = (caller,name,extra={}) => rig.tool(caller,'orgtree_hire',{name,tier:'haiku',grant:0,charter:'An isolated superior.',hire_type:'superior',...extra})
  const has = name => !!ledger()[name]
  const unchanged = (a,b) => JSON.stringify(a)===JSON.stringify(b)

  await hire('root-self',12)
  await hire('kept-child',3,'root-self')
  let before=ledger()
  const first=await parent('root-self','first-parent',{grant:2,kickoff:'Proof kickoff.'})
  let after=ledger()
  p.check('top-level self hire succeeds through the agent tool',first.ok,first)
  if(!first.ok) { p.keep(rig,{grep:/hire|credit|subjugat/i}); return p.summary() }
  p.check('external stake and original sibling position are conserved',near(roots(before),roots(after))&&near(stake(before['root-self']),stake(after['first-parent']))&&after['first-parent'].parent_id===null&&near(before['root-self'].ord,after['first-parent'].ord),{before:before['root-self'],after:after['first-parent']})
  p.check('caller pays new seat plus free grant; child allocation stays unchanged',near(after['root-self'].grant,before['root-self'].grant-after['first-parent'].seat-2)&&near(after['first-parent'].free,2)&&unchanged(before['kept-child'],after['kept-child'])&&valid())
  p.check('kickoff committed once',rig.one(`SELECT count(*)::int AS n FROM ot.mail WHERE org_id=${ORG} AND recipient_name='first-parent' AND body='Proof kickoff.'`).n===1)

  before=ledger()
  const second=await parent('root-self','second-parent',{parent:'root-self',grant:1})
  after=ledger()
  p.check('non-root self insertion works and keeps ancestor allocation fixed',second.ok&&near(roots(before),roots(after))&&after['second-parent'].parent_id===before['root-self'].parent_id&&near(after['first-parent'].grant,before['first-parent'].grant)&&near(after['first-parent'].free,before['first-parent'].free)&&near(after['second-parent'].free,1)&&valid(),second)

  await hire('empty-root',0)
  before=ledger()
  const empty=await parent('empty-root','must-not-exist')
  p.check('insufficient caller free is refused without any tree or credit changes',!empty.ok&&!has('must-not-exist')&&unchanged(before,ledger()),empty)
  before=ledger()
  const badScope=await parent('root-self','scope-escalation',{tools:{bash:true}})
  p.check('scope override rejected atomically',!badScope.ok&&unchanged(before,ledger()),badScope)
  const badAccount=await parent('root-self','bad-account',{account:'nonexistent-proof-account'})
  p.check('invalid account rejected atomically',!badAccount.ok&&unchanged(before,ledger()),badAccount)
  const badKickoff=await parent('root-self','bad-kickoff',{kickoff:'Must never deliver.',kickoff_kind:'invalid'})
  p.check('late composite failure rolls back seat, grant, topology and mail',!badKickoff.ok&&unchanged(before,ledger())&&rig.one(`SELECT count(*)::int AS n FROM ot.mail WHERE org_id=${ORG} AND body='Must never deliver.'`).n===0,badKickoff)
  const badTarget=await parent('root-self','above-sibling',{target:'empty-root'})
  p.check('another root cannot be selected to gain its position',!badTarget.ok&&unchanged(before,ledger()),badTarget)

  // Raw child scope is deliberately wider than its ancestor: insertion must
  // capture effective scope, including the Orgtree group ceiling.
  const scopeDir=path.join(rig.data,'parent-scope')
  fs.mkdirSync(scopeDir,{recursive:true})
  await rig.api('POST',`/api/orgs/${rig.org}/settings`,{org_dirs:[{path:scopeDir,mode:'rw'}]})
  await hire('scope-root',12)
  await hire('scope-caller',7,'scope-root')
  rig.exec(`UPDATE ot.agents SET scope=scope||'{"permission_mode":"plan","org_visibility":"self","tools":{"bash":false,"web":false,"edit":false,"subagents":false,"mcp":[],"orgtree":{"inspection":false}}}'::jsonb WHERE org_id=${ORG} AND name='scope-root';
    UPDATE ot.agents SET scope=scope||'{"permission_mode":"bypassPermissions","org_visibility":"full","account_fallback":false}'::jsonb WHERE org_id=${ORG} AND name='scope-caller';`)
  rig.exec(`UPDATE ot.agents SET scope=jsonb_set(scope,'{add_dirs}',${"'"+JSON.stringify([{path:scopeDir,mode:'ro'}]).replaceAll("'","''")+"'"}::jsonb) WHERE org_id=${ORG} AND name='scope-root'`)
  before=ledger()
  const scoped=await parent('scope-caller','scoped-parent')
  after=ledger();const sc=after['scoped-parent']?.scope
  p.check('new superior inherits effective folders/tools/visibility/mode, not org defaults or raw broader child scope',scoped.ok&&sc.permission_mode==='plan'&&sc.org_visibility==='self'&&sc.tools.bash===false&&sc.tools.edit===false&&sc.tools.orgtree.inspection===false&&sc.account_fallback===false&&sc.add_dirs.length===1&&sc.add_dirs[0].mode==='ro'&&near(roots(before),roots(after)),{scoped,sc})
  const deniedRead=await rig.tool('scoped-parent','orgtree_state_inspect',{})
  p.check('inherited tool denial enforced on the new parent',!deniedRead.ok,deniedRead)

  await hire('staff-caller',8)
  before=ledger()
  const staffed=await rig.tool('staff-caller','orgtree_staff',{name:'staff-parent',tier:'haiku',grant:1,charter:'Own this proof item.',hire_type:'superior',title:'Parent hire proof item',objective:'Test atomic parent staffing.',kind:'non-code',audiences:['user']})
  after=ledger()
  p.check('staff alias validates item and audience before atomic promotion',staffed.ok&&after['staff-caller'].parent_id===after['staff-parent']?.id&&near(roots(before),roots(after))&&near(after['staff-parent'].free,1),staffed)
  p.check('staffed item belongs to final parent',rig.one(`SELECT count(*)::int AS n FROM ot.work_items WHERE org_id=${ORG} AND owner_agent_id=(SELECT id FROM ot.agents WHERE org_id=${ORG} AND name='staff-parent')`).n===1)

  before=ledger()
  const failedStaff=await rig.tool('root-self','orgtree_staff',{name:'failed-staff-parent',tier:'haiku',grant:0,charter:'Must roll back.',hire_type:'superior',title:'Must not persist',objective:'Atomic failure proof.',parent:'missing-work-item'})
  p.check('late staff validation failure rolls back the temporary parent and item',!failedStaff.ok&&unchanged(before,ledger())&&rig.one(`SELECT count(*)::int AS n FROM ot.work_items WHERE org_id=${ORG} AND title='Must not persist'`).n===0,failedStaff)

  // Two overlapping reservations contend for the same final seat. No ancestor
  // capacity can be borrowed when the second operation retries.
  await hire('race-caller',0.5)
  before=ledger()
  const races=await Promise.all([parent('race-caller','race-a'),parent('race-caller','race-b')])
  after=ledger()
  p.check('concurrent self insertions cannot spend one seat twice',races.filter(r=>r.ok).length===1&&near(roots(before),roots(after))&&valid(),races)

  // Hold the caller row with an uncommitted authority change. The tool's
  // admission lookup sees the old generation/scope, then waits inside hire.
  // Serializable retry must revalidate rather than use that stale admission.
  async function authorityRace(name, update, hiredName) {
    const {port,password}=rig.pgConn()
    const child=spawn(path.join(rig.run.pgBin,'psql.exe'),['-X','-q','-At','-v','ON_ERROR_STOP=1','-h','127.0.0.1','-p',String(port),'-U','orgtree_admin','-d','orgtree_engine','-c',
      `BEGIN; UPDATE ot.agents SET ${update} WHERE org_id=${ORG} AND name='${name}'; SELECT pg_sleep(2); COMMIT;`],
      {windowsHide:true,env:{...process.env,PGPASSWORD:password,PGAPPNAME:'parent-hire-authority-race'}})
    let error='';child.stderr.on('data',b=>error+=b)
    const done=new Promise((resolve,reject)=>{child.on('error',reject);child.on('exit',code=>code?reject(Error(error)):resolve())})
    await rig.waitFor(()=>rig.sql(`SELECT 1 FROM pg_stat_activity WHERE application_name='parent-hire-authority-race' AND wait_event='PgSleep'`).length>0,{timeout:5000,what:'authority update holding caller row'})
    const result=await parent(name,hiredName)
    await done
    return result
  }
  await hire('stale-generation',2)
  const stale=await authorityRace('stale-generation','generation=generation+1','stale-generated-parent')
  p.check('generation changed after admission is refused after transactional retry',!stale.ok&&!has('stale-generated-parent')&&/caller changed/.test(stale.text),stale)
  await hire('stale-scope',2)
  const lost=await authorityRace('stale-scope',`scope=jsonb_set(scope,'{tools,orgtree,team}','false')`,'stale-scope-parent')
  p.check('team permission revoked after admission is rechecked under the transaction',!lost.ok&&!has('stale-scope-parent')&&/no longer holds/.test(lost.text),lost)

  // Hire -> promote the old caller back -> retire -> ordinary rehire: credits
  // remain within the same externally funded boundary throughout.
  before=ledger()
  const promote=await rig.tool('second-parent','orgtree_self_subjugate',{target:'root-self'})
  after=ledger()
  p.check('promoting original caller back conserves external allocation',promote.ok&&near(roots(before),roots(after))&&valid(),promote)
  const retire=await rig.tool('root-self','orgtree_retire',{node:'second-parent'})
  const rehire=await rig.tool('root-self','orgtree_rehire',{node:'second-parent'})
  p.check('retire/rehire cycle mints no external credits',retire.ok&&rehire.ok&&near(roots(before),roots(ledger()))&&valid(),{retire,rehire})

  await hire('ordinary-caller',3)
  const ordinary=await rig.tool('ordinary-caller','orgtree_hire',{name:'ordinary-child',tier:'haiku',grant:0,charter:'Ordinary report.',add_dirs:[],org_visibility:'self',tools:{bash:false,web:false,edit:false,subagents:false,mcp:[]}})
  p.check('subordinate remains the default',ordinary.ok&&ledger()['ordinary-child']?.parent_id===ledger()['ordinary-caller'].id,ordinary)
  before=ledger()
  const otherTarget=await parent('ordinary-caller','child-superior',{target:'ordinary-child',grant:1})
  after=ledger()
  p.check('superior above another report retains existing funding and scope rules',otherTarget.ok&&after['ordinary-child'].parent_id===after['child-superior']?.id&&after['child-superior'].parent_id===before['ordinary-caller'].id&&near(after['ordinary-caller'].grant,before['ordinary-caller'].grant)&&near(after['ordinary-caller'].free,before['ordinary-caller'].free-1-after['child-superior'].seat)&&after['child-superior'].scope.org_visibility==='self',otherTarget)
  await rig.api('POST',`/api/orgs/${rig.org}/settings`,{disabled_accounts:['claude/primary']})
  before=ledger()
  const unavailable=await parent('root-self','blocked-account-parent',{account:'primary'})
  p.check('self insertion cannot bypass organization account exclusions',!unavailable.ok&&!has('blocked-account-parent')&&unchanged(before,ledger()),unavailable)
  await rig.api('POST',`/api/orgs/${rig.org}/settings`,{disabled_accounts:[]})
  before=ledger()
  const archived=await hire('archived-caller',2).then(()=>rig.op({op:'retire',node:'archived-caller'})).then(()=>parent('archived-caller','stale-parent')).catch(e=>({ok:false,text:e.message}))
  p.check('retired caller cannot insert a parent',!archived.ok&&!has('stale-parent'),archived)
  p.check('no final overdraft',valid())
  p.keep(rig,{grep:/hire|credit|subjugat|conflicted/i})
  return p.summary()
}
