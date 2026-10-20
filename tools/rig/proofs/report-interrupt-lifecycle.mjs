// Synthetic-only lifecycle controls, including real ACP transport and parallel
// completion ordering. The historical self-interrupt proof remains separate.
import fs from 'node:fs'
import path from 'node:path'
import { seed } from '../fixture.mjs'
import { Proof } from '../proof.mjs'
import { setup as keysSetup } from './openrouter-keys.mjs'

export async function setup() { return { ...(await keysSetup()), name:'report-interrupt-lifecycle', fixture:'none' } }
const lines = file => fs.existsSync(file) ? fs.readFileSync(file,'utf8').trim().split(/\r?\n/).filter(Boolean).map(JSON.parse) : []
export default async function(rig) {
  const p = new Proof('report-interrupt-lifecycle')
  rig.scenario({agents:{
    ann:{turns:[
      {name:'pending',match:'PENDING-CHANGE',once:true,steps:[
        {tool:'orgtree_status',args:{status:'working',summary:'hold mail',dnd:true}},
        {tool:'Bash',args:{command:'synthetic'},run_ms:3500,result:'finished'},
        {sleep_ms:10000},{text:'NOT-REACHED'},
      ]},
      {name:'immediate',match:'IMMEDIATE-RESTART',once:true,steps:[{sleep_ms:10000},{text:'NOT-REACHED'}]},
      {name:'background',match:'BACKGROUND-REFUSAL',once:true,steps:[
        {bg:{task:'restart-bg',id:'toolu_restart_bg',command:'synthetic',finish_ms:2200,status:'completed',exit_code:0,output:'ok'}},
        {sleep_ms:3000},{text:'BACKGROUND-COMPLETE'},
      ]},
      {name:'natural',match:'NATURAL-NO-RESTART',once:true,steps:[{sleep_ms:1000},{text:'NATURAL-COMPLETE'}]},
      {name:'after-natural',match:'LATER-TURN',once:true,steps:[{tool:'Bash',args:{command:'synthetic'},run_ms:250,result:'ok'},{text:'LATER-COMPLETE'}]},
      {name:'default',steps:[{text:'Continue.'}]},
    ]},
  },default:{turns:[{name:'default',steps:[{text:'OK.'}]}]}})
  await seed(rig,{org:{name:'Interrupt lifecycle'},agents:[
    {name:'boss',tier:'haiku',grant:50},{name:'ann',tier:'haiku',parent:'boss'},
  ]})
  const finish=async(name,index)=>rig.waitFor(()=>rig.turns(name)[index]?.ended_at && rig.turns(name)[index],
    {what:`${name} turn ${index}`,timeout:30000})
  const begin=async(text,script)=>{
    const n=rig.turns('ann').length
    await rig.userMail('ann',text)
    await rig.waitFor(()=>rig.fakeLog('ann').some(l=>l.kind==='turn' && l.script===script),{what:script})
    return n
  }
  const ask=args=>rig.tool('boss','orgtree_interrupt',{node:'ann',...args})
  const state=async()=>JSON.stringify((await rig.tool('boss','orgtree_state_inspect',{node:'ann'})).json)
  let n=await begin('PENDING-CHANGE','pending')
  await rig.waitFor(()=>rig.fakeLog('ann').some(l=>l.kind==='step' && l.step?.tool==='Bash'),{what:'current tool'})
  const retool=await rig.tool('boss','orgtree_retool',{node:'ann',charter:'PENDING-CHARTER-CANARY'})
  for(const body of ['WAITING-MAIL-ONE','WAITING-MAIL-TWO']) await rig.userMail('ann',body)
  const q=await ask({queued:true,restart:true})
  await finish('ann',n); await finish('ann',n+1)
  const prompts=rig.fakeLog('ann').filter(l=>l.kind==='turn').map(l=>l.prompt??'')
  const after=prompts.at(-1)
  p.check('pending retool applies through normal restart placement',retool.ok && q.ok && after.includes('PENDING-CHARTER-CANARY'),{retool,q,hasCharter:after.includes('PENDING-CHARTER-CANARY')})
  p.check('waiting mail survives once and in order',prompts.filter(x=>x.includes('WAITING-MAIL-ONE')).length===1
    && prompts.filter(x=>x.includes('WAITING-MAIL-TWO')).length===1
    && after.indexOf('WAITING-MAIL-ONE')>=0 && after.indexOf('WAITING-MAIL-TWO')>after.indexOf('WAITING-MAIL-ONE'))
  const mail=rig.sql("SELECT m.body,m.state FROM ot.mail m JOIN ot.agents a ON a.id=m.recipient_agent_id WHERE a.name='ann' AND m.body LIKE 'WAITING-MAIL-%'")
  p.check('both waiting rows are consumed',mail.length===2 && mail.every(m=>m.state==='delivered'),mail)

  n=await begin('IMMEDIATE-RESTART','immediate')
  const immediate=await ask({restart:true})
  await finish('ann',n);await finish('ann',n+1)
  p.check('immediate descendant restart starts one new turn',immediate.ok && rig.turns('ann').length===n+2,immediate)

  n=await begin('BACKGROUND-REFUSAL','background')
  await rig.waitFor(()=>rig.fakeLog('ann').some(l=>l.kind==='bg_started'),{what:'background task'})
  for(const args of [{restart:true},{queued:true,restart:true}]) {
    const r=await ask(args)
    p.check(`background work explicitly refuses ${JSON.stringify(args)}`,!r.ok && /background work/.test(r.text),r)
  }
  await finish('ann',n)
  p.check('refused interrupt leaves the current work running',rig.fakeLog('ann').some(l=>l.kind==='step' && l.step?.text==='BACKGROUND-COMPLETE'))

  n=await begin('NATURAL-NO-RESTART','natural')
  const natural=await ask({queued:true})
  await finish('ann',n)
  p.check('natural completion resolves queued stop as no-op',natural.ok && (await state()).includes('"noop"'))
  n=await begin('LATER-TURN','after-natural'); await finish('ann',n)
  p.check('queued stop does not leak into a later turn',rig.fakeLog('ann').some(l=>l.kind==='step' && l.step?.text==='LATER-COMPLETE'))

  await rig.waitFor(async()=>(await rig.api('GET','/api/harnesses')).harnesses?.find(h=>h.id==='opencode' && h.installed),{what:'ACP discovery'})
  await rig.api('PUT','/api/openrouter/keys/openrouter-1',{harness:'opencode'})
  await rig.op({op:'hire',name:'acp',parent:'boss',tier:'or-rig-fake-model',grant:1})
  await rig.userMail('acp','initial ACP control'); await finish('acp',0)
  const a=rig.agentRow('acp')
  const scratch=rig.one(`SELECT scratch_dir FROM ot.agents WHERE id=${a.id}`).scratch_dir
  const fixture=path.join(scratch,'acp-fixture.json'), events=path.join(scratch,'acp-events.jsonl')
  fs.writeFileSync(fixture,JSON.stringify({toolTimeline:[
    {id:'long'},{id:'short'},{id:'short',completed:true,delayMs:500},
    {id:'short',completed:true,delayMs:100}, // replay is not a fresh boundary
    {id:'long',completed:true,delayMs:2200},
  ],afterToolsMs:8000}))
  n=rig.turns('acp').length
  await rig.userMail('acp','ACP parallel control')
  await rig.waitFor(()=>lines(events).length>=2,{what:'both ACP tools started'})
  // The current request already owns its parsed fixture; the restart sees this.
  fs.writeFileSync(fixture,JSON.stringify({text:'RESTARTED'}))
  const acp=await rig.tool('boss','orgtree_interrupt',{node:'acp',queued:true,restart:true})
  const cut=await finish('acp',n);if(acp.ok)await finish('acp',n+1)
  const ev=lines(events), duration=Date.parse(cut.ended_at)-Date.parse(cut.started_at)
  p.check('ACP waits for all observed active tools, then restarts',acp.ok && duration>=2700 && duration<7500
    && ev.some(x=>x.id==='long' && x.completed),{acp,duration,events:ev})
  const acpState=await rig.tool('boss','orgtree_state_inspect',{node:'acp'})
  p.check('ACP completion caveat and applied outcome are visible',acp.ok && /cut off early/.test(acp.json?.result?.boundary??'')
    && JSON.stringify(acpState.json).includes('"applied"'),acpState.json)
  p.keep(rig,{agents:['ann','acp'],grep:/interrupt|restart/})
  return p.summary()
}
