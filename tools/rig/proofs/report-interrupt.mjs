// Actual engine, synthetic CLIs only: request a stop while a native tool runs.
import { seed } from '../fixture.mjs'
import { Proof } from '../proof.mjs'

export async function setup() { return { name: 'report-interrupt', fixture: 'none' } }
export default async function(rig) {
  const p = new Proof('report-interrupt')
  const providers = [
    ['ann', 'haiku', 'Bash'], ['cod', 'sol', 'shell'],
    ['mus', 'wonder', 'shell'], ['agy', 'flash', 'run_command'],
  ]
  const agents = Object.fromEntries(providers.map(([name,,tool]) => [name, { turns: [
    { name: 'long', match: 'QUEUED-LONG', once: true, steps: [
      { tool, args: {command:'synthetic work'}, run_ms: 3500, result:'CURRENT-TOOL-FINISHED' },
      { sleep_ms:8000 }, { text:'AFTER-BOUNDARY-MUST-NOT-RUN' },
    ] },
    { name: 'natural', match:'QUEUED-NATURAL', once:true, steps:[{sleep_ms:1500},{text:'NATURAL-END'}] },
    { name:'default', steps:[{text:'Continuing.'}] },
  ] }]))
  rig.scenario({agents,default:{turns:[{name:'default',steps:[{text:'OK.'}]}]}})
  await rig.waitFor(async () => (await rig.api('GET', '/api/providers'))?.providers?.find(x => x.id === 'muse' && x.muse?.catalog),
    {what:'synthetic Muse catalog',timeout:30000})
  await seed(rig, {org:{name:'Report interrupt'},agents:[
    {name:'boss',tier:'haiku',grant:80},
    ...providers.map(([name,tier])=>({name,tier,parent:'boss'})),
    {name:'peer',tier:'haiku'},
  ]})
  const finish = async (name,index) => rig.waitFor(()=>rig.turns(name)[index]?.ended_at && rig.turns(name)[index],
    {what:`${name} turn ${index} finished`,timeout:25000})
  for (const [name,,tool] of providers) {
    const before=rig.turns(name).length
    await rig.userMail(name,'QUEUED-LONG')
    await rig.waitFor(()=>rig.fakeLog(name).some(l=>l.kind==='step' && l.step?.tool===tool),
      {what:`${name} native tool started`,timeout:30000})
    const r=await rig.tool('boss','orgtree_interrupt',{node:name,queued:true,restart:true})
    p.check(`${name}: queues a restart and states the boundary`,r.ok && r.json?.result?.queued===true
      && typeof r.json.result.boundary==='string',r)
    const duplicate=await rig.tool('boss','orgtree_interrupt',{node:name,queued:true,restart:true})
    p.check(`${name}: duplicate attaches to the same turn`,duplicate.ok && duplicate.json?.result?.already_requested===true,duplicate)
    const turn=await finish(name,before)
    // Baseline refuses restart, so don't wait for a nonexistent second turn.
    if(r.ok) await finish(name,before+1)
    const ms=Date.parse(turn.ended_at)-Date.parse(turn.started_at)
    p.check(`${name}: current tool completes, next long step does not`,ms>=3000 && ms<9000
      && !rig.fakeLog(name).some(l=>l.kind==='step' && l.step?.text==='AFTER-BOUNDARY-MUST-NOT-RUN'),{ms,turn})
    const state=await rig.tool('boss','orgtree_state_inspect',{node:name})
    p.check(`${name}: outcome is observable`,JSON.stringify(state.json).includes('"interrupt"')
      && JSON.stringify(state.json).includes('"applied"'),state.json)
  }
  for (const args of [{node:'peer',restart:true},{node:'peer',queued:true},{node:'boss',queued:true}]) {
    const r=await rig.tool('ann','orgtree_interrupt',args)
    p.check(`authority refuses ${JSON.stringify(args)}`,!r.ok,r)
  }
  const before=rig.turns('ann').length
  await rig.userMail('ann','QUEUED-NATURAL')
  await rig.waitFor(()=>rig.fakeLog('ann').some(l=>l.kind==='turn' && l.script==='natural'),{what:'natural turn'})
  const r=await rig.tool('boss','orgtree_interrupt',{node:'ann',queued:true,restart:true})
  await finish('ann',before)
  if(r.ok) await finish('ann',before+1)
  p.check('natural end retains its response and restarts once',r.ok
    && rig.fakeLog('ann').some(l=>l.kind==='step' && l.step?.text==='NATURAL-END')
    && rig.turns('ann').length===before+2,{r,turns:rig.turns('ann').slice(before)})
  const idle=await rig.tool('boss','orgtree_interrupt',{node:'ann',queued:true,restart:true})
  p.check('idle refusal never arms a later turn',!idle.ok && /no turn/.test(idle.text),idle)
  p.keep(rig,{agents:['boss',...providers.map(x=>x[0])],grep:/interrupt|restart/})
  return p.summary()
}
