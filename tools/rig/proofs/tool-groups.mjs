// Real installed harnesses against an isolated fake language server. No model
// generation or live account. Keeps exact first requests for tokenization.
import fs from 'node:fs'
import path from 'node:path'
import { startFakeLlm } from '../fakellm.mjs'
import { seed } from '../fixture.mjs'
import { Proof } from '../proof.mjs'

const groups = ['docket','team','messaging','inspection','watchdogs','runtime','user','logo']
const off = Object.fromEntries(groups.map(g => [g,false]))
const cases = [
  ['default', {}],
  ['groupsoff', {orgtree:off}],
  ['alloff', {bash:false,web:false,edit:false,subagents:false,orgtree:off}],
  ['chores', {bash:true,web:false,edit:false,subagents:false,orgtree:{...off,messaging:true,watchdogs:true}}],
]
export async function setup() { return {name:'tool-groups', 'real-cli':true, fixture:'none'} }
export default async function(rig) {
  const p = new Proof('tool-groups')
  const llm = await startFakeLlm({ bodies:path.join(p.dir,'bodies'), models:[{name:'fake-model:latest',context:131072,running:65536}], rules:[] })
  const manifest=[]
  try {
    const tiers={}
    for(const [h,harness] of [['cc','claude-code'],['cx','codex-cli']]) {
      const r=await rig.api('POST','/api/langservers',{preset:'llamacpp',address:llm.url,harness,label:'Scope '+h,models:[{id:'fake-model:latest',context:65536}]})
      tiers[h]=Object.values(r.server.models)[0].tier
    }
    await seed(rig,{org:{name:'Tool Groups Proof'},agents:[{name:'lead',tier:tiers.cc,grant:20,charter:'You coordinate the isolated scope proof.'}]})
    for(const [h,tier] of Object.entries(tiers)) for(const [mode,tools] of cases) {
      const name=h+mode, token='PROOF-SCOPE-'+name
      await rig.op({op:'hire',name,parent:'lead',tier,grant:0,charter:'You report the outcome of a small housekeeping task.',
        add_dirs:[],org_visibility:'self',permission_mode:'bypassPermissions',tools:{mcp:[],...tools}})
      await rig.userMail(name,token+': answer OK.')
      const seen=await rig.waitFor(()=>llm.requests.find(r=>r.last_user?.includes(token)&&r.body_file),{what:name+' first request',timeout:90000})
      const bodyPath=path.join(p.dir,'bodies',seen.body_file)
      const body=JSON.parse(fs.readFileSync(bodyPath,'utf8'))
      const all=[...(body.tools??[]),...(body.input??[]).flatMap(x=>x.type==='additional_tools'?x.tools:[])]
      const flat=ts=>ts.flatMap(t=>t.tools?flat(t.tools):[t])
      const leaves=flat(all), names=leaves.map(t=>t.name??t.type)
      const org=names.filter(n=>n.includes('orgtree_')).map(n=>n.slice(n.lastIndexOf('orgtree_'))).sort()
      const identityFile=path.join(rig.data,'scratch',rig.org,name,'.orgtree-identity.md')
      const identity=fs.existsSync(identityFile)?fs.readFileSync(identityFile,'utf8'):String(body.instructions??'')
      manifest.push({name,mode,harness:h,body:bodyPath,orgtree_tools:org,tools:names,identity_chars:identity.length,request_bytes:Buffer.byteLength(JSON.stringify(body))})
      p.file(name+'-identity.md',identity)
      p.check(name+': identity instructions captured',identity.length>1000)
      p.check(name+': always has status',org.includes('orgtree_status'),org)
      if(mode==='default') p.check(name+': all groups enabled by default',
        ['work','hire','message','chart','watchdog','halt','ask','org_logo'].every(n=>org.includes('orgtree_'+n)),org)
      if(mode==='alloff'||mode==='groupsoff') {
        p.check(name+': all Orgtree groups omitted',org.length===1,org)
        p.check(name+': docket/staff/watchdog instructions omitted',!identity.includes('THE DOCKET')&&!identity.includes('orgtree_hire')&&!identity.includes('orgtree_watchdog'))
      }
      if(mode==='chores') p.check(name+': only messaging, watchdog and status',org.every(n=>['orgtree_status','orgtree_message','orgtree_send_notice','orgtree_inbox','orgtree_audience','orgtree_transfers','orgtree_watchdog'].includes(n))&&org.includes('orgtree_watchdog'),org)
      if(h==='cc') {
        p.check(name+': replaced built-ins omitted',!names.some(n=>['AskUserQuestion','EnterPlanMode','ExitPlanMode','CronCreate','CronDelete','CronList','ScheduleWakeup','Monitor','RemoteTrigger'].includes(n)),names)
        if(mode==='alloff'||mode==='chores') p.check(name+': scoped built-ins omitted',!names.some(n=>['Agent','Task','SendMessage','Workflow','ListAgents','Edit','Write','NotebookEdit','WebSearch','WebFetch','EnterWorktree','ExitWorktree'].includes(n)),names)
        if(mode==='alloff') p.check(name+': shell omitted',!names.includes('Bash')&&!names.includes('PowerShell'))
      }
      if(h==='cx'&&(mode==='alloff'||mode==='chores')) {
        const definitions=JSON.stringify(all)
        p.check(name+': subagent and patch definitions omitted',!names.some(n=>/spawn_agent|send_message|multi_agent/.test(n))&&!definitions.includes('### `apply_patch`')&&!names.includes('apply_patch'),names)
        if(mode==='alloff') p.check(name+': shell definitions omitted',!names.includes('exec_command')&&!definitions.includes('### `exec_command`'),names)
      }
      await rig.waitFor(()=>rig.sql(`SELECT 1 FROM ot.turns t JOIN ot.agents a ON a.id=t.agent_id WHERE a.name='${name}' AND t.ended_at IS NULL`).length===0,{what:name+' settled',timeout:60000})
    }
    // Calls are refused even if a caller remembers a previously offered tool.
    const denied=await rig.tool('ccalloff','orgtree_chart',{})
    p.check('disabled tool invocation refused',!denied.ok,denied.text)
    const reported=await rig.tool('ccalloff','orgtree_status',{status:'done',summary:'scope proof'})
    p.check('all-off agent can still report done',reported.ok,reported.text)
    const invalid=await rig.op({op:'retool',node:'ccchores',tools:{orgtree:{docket:'false'}}}).then(()=>false,e=>e.status===400)
    p.check('malformed group rejected at mutation',invalid)
    await rig.op({op:'retool',node:'lead',tools:{orgtree:{inspection:false}}})
    const child=await rig.tool('ccdefault','orgtree_chart',{})
    p.check('ancestor denial takes effect in existing child',!child.ok,child.text)
    const escalated=await rig.tool('lead','orgtree_retool',{node:'ccdefault',tools:{orgtree:{inspection:true}}})
    p.check('agent cannot grant denied group',!escalated.ok,escalated.text)
    await rig.op({op:'retool',node:'ccchores',tools:{orgtree:{user:true}}})
    await rig.api('POST',`/api/orgs/${rig.org}/audiences`,{action:'grant',node:'ccchores',reason:'scope proof'})
    const requested=await rig.tool('ccchores','orgtree_request_scope',{items:[{kind:'tool',tool:'orgtree.docket'}],reason:'Need to track the assigned task'})
    const ask=rig.one(`SELECT rev,body FROM ot.asks WHERE agent_id=${rig.agentRow('ccchores').id} AND status='open' ORDER BY id DESC LIMIT 1`)
    p.check('group scope request opens a real card',requested.ok&&!!ask,requested.text)
    if(ask) {
      await rig.api('POST',`/api/orgs/${rig.org}/nodes/ccchores/batch`,{revs:{scope:ask.rev},scope:['approve']})
      const got=await rig.tool('ccchores','orgtree_work',{action:'list'})
      p.check('approval grants the requested group',got.ok,got.text)
    }
  } finally {p.file('manifest.json',manifest);await llm.close()}
  return p.summary()
}
