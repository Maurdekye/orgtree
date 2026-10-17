// Real scratch-engine restarts with timestamp fixtures, never a live DB.
import fs from 'node:fs'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { Proof } from '../proof.mjs'

export async function setup(){return {recover:true}}
const H=3600_000,period=21600
const iso=t=>new Date(t).toISOString()
const lit=s=>`'${String(s).replaceAll("'","''")}'`

export default async function(rig){
  const p=new Proof('watchdog-recurrence')
  const owner=rig.agentRow('boss').id
  const rows=()=>rig.sql(`SELECT uid,state,fired,last_check,next_check_at,next_silence_at,silence_since,memo
    FROM ot.watchdogs WHERE owner_agent_id=${owner} ORDER BY id`)
  const row=name=>rows().find(r=>r.uid===name)
  const make=async(name,extra={})=>{
    const r=await rig.tool('boss','orgtree_watchdog',{action:'create',name,kind:'command',
      target:'echo quiet',pattern:'MATCH',interval_s:period,notice:true,...extra})
    if(!r.ok)throw new Error(`create ${name}: ${r.text}`)
  }
  const child=spawn(process.execPath,['-e','setTimeout(()=>{},600000)'],{stdio:'ignore',windowsHide:true})
  try{
    await make('future')
    await make('catchup',{target:'echo MATCH'})
    await make('many',{target:'echo MATCH'})
    await make('quiet',{fire_mode:'silence',quiet_period_s:period})
    await make('quiet-match',{target:'echo MATCH',fire_mode:'silence',quiet_period_s:period})
    await make('once',{once:true})
    await make('edge',{kind:'process',target:`pid:${child.pid}`})
    await make('pushed',{kind:'activity',target:'boss',pattern:'NEVER-MATCH'})
    await rig.waitFor(()=>rows().filter(r=>r.uid!=='pushed').every(r=>r.last_check),{what:'all seven initial periodic checks',timeout:15000,every:100})
    p.check('new pollers check immediately and pushed activity has no periodic deadline',
      rows().length===8&&row('pushed').next_check_at===null&&row('pushed').next_silence_at===null)

    // Exercise the unmodified migration body on a legacy-shaped temporary table.
    // No engine table is changed or dropped, and the session owns its temp table.
    const migration=fs.readFileSync(new URL('../../../engine/rs/orgtree-engine/migrations/0027_watchdog_schedule.sql',import.meta.url),'utf8')
      .replaceAll('ot.watchdogs','watchdog_schedule_legacy')
    let backfill=true,backfillError
    try{rig.exec(`CREATE TEMP TABLE watchdog_schedule_legacy(kind text,interval_s int,last_check timestamptz,
      created_at timestamptz,fire_mode text,quiet_period_s int,silence_since timestamptz,last_fired timestamptz);
      INSERT INTO watchdog_schedule_legacy VALUES
        ('command',21600,'2026-01-01T00:00Z','2025-12-01T00:00Z','silence',21600,'2026-01-01T00:00Z','2026-01-01T00:00Z'),
        ('file',21600,NULL,'2026-01-01T00:00Z','event',NULL,NULL,NULL),
        ('activity',21600,NULL,'2026-01-01T00:00Z','event',NULL,NULL,NULL);
      ${migration}
      DO $$ BEGIN
        IF NOT EXISTS(SELECT 1 FROM watchdog_schedule_legacy WHERE kind='command' AND next_check_at='2026-01-01T06:00Z'
          AND next_silence_at='2026-01-01T06:00Z' AND last_check='2026-01-01T00:00Z' AND last_fired='2026-01-01T00:00Z')
          OR NOT EXISTS(SELECT 1 FROM watchdog_schedule_legacy WHERE kind='file' AND next_check_at=created_at)
          OR NOT EXISTS(SELECT 1 FROM watchdog_schedule_legacy WHERE kind='activity' AND next_check_at IS NULL)
        THEN RAISE EXCEPTION 'legacy schedule backfill lost phase or original evidence'; END IF;
      END $$;`)}catch(e){backfill=false;backfillError=e.message}
    p.check('migration backfills fixed slots while preserving actual evidence and non-periodic kinds',backfill,backfillError)

    const base=Date.now(),origin=base-7*H,due=origin+6*H,next=origin+12*H
    const futureLast=base-5*H,futureDue=base+H
    const manyOrigin=base-37*H,manyDue=manyOrigin+6*H,manyNext=manyOrigin+42*H
    const before=Object.fromEntries(rows().map(r=>[r.uid,{fired:r.fired,checks:Number(r.memo.run?.checks_run??0)}]))
    rig.exec(`UPDATE ot.watchdogs SET last_check=${lit(iso(origin))},next_check_at=${lit(iso(due))}
      WHERE owner_agent_id=${owner} AND uid IN ('catchup','quiet','quiet-match','once','edge');
      UPDATE ot.watchdogs SET silence_since=${lit(iso(origin))},next_silence_at=${lit(iso(due))}
        WHERE owner_agent_id=${owner} AND uid IN ('quiet','quiet-match');
      UPDATE ot.watchdogs SET last_check=${lit(iso(futureLast))},next_check_at=${lit(iso(futureDue))}
        WHERE owner_agent_id=${owner} AND uid='future';
      UPDATE ot.watchdogs SET last_check=${lit(iso(manyOrigin))},next_check_at=${lit(iso(manyDue))}
        WHERE owner_agent_id=${owner} AND uid='many';
      UPDATE ot.watchdogs SET target='echo MATCH' WHERE owner_agent_id=${owner} AND uid='once'`)
    const exited=once(child,'exit');child.kill();await exited
    await rig.restart()
    await rig.waitFor(()=>['catchup','many','quiet','once','edge'].every(name=>row(name).fired===before[name].fired+1),
      {what:'one overdue catch-up per restored dog',timeout:15000,every:100})

    p.check('future deadline and actual last-check timestamp survive restart unchanged',
      Date.parse(row('future').next_check_at)===futureDue&&Date.parse(row('future').last_check)===futureLast)
    p.check('user h7 catch-up advances to original h12 rather than h13',
      row('catchup').fired===before.catchup.fired+1&&Date.parse(row('catchup').next_check_at)===next,
      {next:row('catchup').next_check_at,expected:iso(next)})
    p.check('many missed six-hour slots queue once and skip straight to next original slot',
      row('many').fired===before.many.fired+1&&Date.parse(row('many').next_check_at)===manyNext)
    p.check('unmatched overdue silence fires once and preserves both polling and quiet phases',
      row('quiet').fired===before.quiet.fired+1&&Date.parse(row('quiet').next_check_at)===next
        &&Date.parse(row('quiet').next_silence_at)===next)
    p.check('fresh target match suppresses overdue silence and resets its quiet reference',
      row('quiet-match').fired===before['quiet-match'].fired&&Date.parse(row('quiet-match').next_silence_at)>base+5.9*H)
    p.check('overdue one-shot spends itself once and a dead process still needs its observed UP baseline',
      row('once').state==='spent'&&row('once').fired===1&&row('edge').fired===before.edge.fired+1
        &&row('edge').memo.run.up===false)

    const listed=await rig.tool('boss','orgtree_watchdog',{action:'list'})
    const list=listed.json?.watchdogs??JSON.parse(listed.text).watchdogs
    const projected=await rig.waitFor(async()=>{
      const snapshot=await rig.api('GET',`/api/orgs/${rig.org}/records`)
      const dogs=(snapshot.records??[]).find(r=>r.entity==='org'&&r.id==='watchdogs')?.body?.watchdogs??[]
      return Date.parse(dogs.find(r=>r.name==='catchup')?.next_check_at)===next?dogs:null
    },{what:'durable watchdog deadline in desktop record group',timeout:10000,every:100})
    p.check('agent list and desktop record projection expose the same persisted next deadlines',
      Date.parse(list.find(r=>r.id==='catchup')?.next_check_at)===next
        &&Date.parse(projected.find(r=>r.name==='catchup')?.next_check_at)===next
        &&Date.parse(projected.find(r=>r.name==='quiet')?.next_silence_at)===next)

    const saved=rows().filter(r=>r.uid!=='pushed').map(r=>({id:r.uid,fired:r.fired,last:r.last_check,next:r.next_check_at,quiet:r.next_silence_at}))
    await rig.restart()
    // Bounded negative observation after a fully ready restart. Every timer's
    // next slot is hours away; a restarted immediate poll would change evidence.
    await new Promise(resolve=>setTimeout(resolve,1500))
    const again=rows().filter(r=>r.uid!=='pushed').map(r=>({id:r.uid,fired:r.fired,last:r.last_check,next:r.next_check_at,quiet:r.next_silence_at}))
    p.check('a second restart adds no catch-up or real check before the saved future slots',JSON.stringify(again)===JSON.stringify(saved))

    const resumeAt=Date.now()
    const paused=await rig.tool('boss','orgtree_watchdog',{action:'pause',id:'future'})
    const resumed=await rig.tool('boss','orgtree_watchdog',{action:'resume',id:'future'})
    await rig.waitFor(()=>Date.parse(row('future').last_check)>=resumeAt,{what:'explicit resume initial check',timeout:15000,every:100})
    const resumeNext=Date.parse(row('future').next_check_at)
    p.check('explicit resume starts a new recurrence and checks immediately',paused.ok&&resumed.ok
      &&resumeNext>=resumeAt+6*H&&resumeNext<resumeAt+6*H+15000)
    p.keep(rig)
    return p.summary()
  }finally{if(child.exitCode===null&&child.signalCode===null)child.kill()}
}
