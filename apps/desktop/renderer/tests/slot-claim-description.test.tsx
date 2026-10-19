import test from 'node:test'
import assert from 'node:assert/strict'
import {mountView,inAct,flush} from './harness'
import {watchdogDescription} from '../src/canvas/watchdogdescription'
import {WatchdogPanel} from '../src/canvas/modals'
import type {Watchdog,OpResult} from '../src/types'
import {slotClaimLeaseState} from '../src/canvas/slotclaim'
const dog:Watchdog={id:'worker/claim',owner:'worker',name:'claim',kind:'slot',target:'build',once:true,state:'armed',fired:0,interval_s:15,at:'2026-10-19T00:00:00Z'}
const cases:Array<{name:string;patch?:Partial<Watchdog>;lease?:{state:'held'|'ended';how?:string};expect:RegExp;waiting?:boolean;dogs?:Watchdog[]}>= [
 {name:'queued claim has its place',dogs:[{...dog,id:'first/claim',at:'2026-10-18T00:00:00Z'},dog],expect:/2nd in line for build/},
 {name:'waiting position genuinely unknown',expect:/queue position unavailable/,waiting:true},
 {name:'paused claim rejoins at the back',patch:{state:'paused'},expect:/paused.*back of the line/},
 {name:'public lease-only grant pending notification',patch:{lease:'s1'},expect:/Granted.*lease s1.*grant notification pending/},
 {name:'public spent lease-only grant notified',patch:{lease:'s1',state:'spent',spent:true,fired:1},expect:/Granted.*lease s1.*grant notification sent/},
 {name:'fired grant without a lease',patch:{state:'spent',spent:true,fired:1},expect:/Granted.*lease details unavailable/},
 {name:'spent state without the legacy flag',patch:{state:'spent'},expect:/Granted.*lease details unavailable/},
 {name:'spent flag during a stale state snapshot',patch:{spent:true},expect:/Granted.*lease details unavailable/},
 {name:'fired count survives partial grant metadata',patch:{fired:1},expect:/Granted.*lease details unavailable/},
 {name:'last fired timestamp survives partial metadata',patch:{last_fired:'2026-10-19T00:01:00Z'},expect:/Granted.*lease details unavailable/},
 {name:'legacy slot-only grant',patch:{slot:1},expect:/Granted.*lease details unavailable/},
 {name:'held grant pending notification',patch:{lease:'s1'},lease:{state:'held'},expect:/lease is held.*grant notification pending/},
 {name:'held grant notification sent',patch:{lease:'s1',fired:1},lease:{state:'held'},expect:/lease is held.*grant notification sent/},
 {name:'released grant is historical',patch:{lease:'s1',spent:true,fired:1},lease:{state:'ended',how:'released'},expect:/lease released.*grant notification sent/},
 {name:'expired grant is historical',patch:{lease:'s1',spent:true,fired:1},lease:{state:'ended',how:'idle: not released after 3 reminders'},expect:/lease expired/},
 {name:'revoked grant is historical',patch:{lease:'s1',spent:true,fired:1},lease:{state:'ended',how:'released (forced by coordinator)'},expect:/lease revoked/},
 {name:'lease absent from complete active list with old history unavailable',patch:{lease:'s1',fired:1},lease:{state:'ended'},expect:/lease is no longer held.*end details unavailable/},
 {name:'exited claim with no grant is not waiting',patch:{state:'exited'},expect:/no longer waiting.*no grant is recorded/},
]
for(const c of cases)test('slot description: '+c.name,()=>{
 const summary=watchdogDescription({...dog,...c.patch},c.dogs??[],c.lease).summary
 assert.match(summary,c.expect)
 if(!c.waiting)assert.doesNotMatch(summary,/queue position unavailable/)
})

test('slot panel reads the existing project status to distinguish an ended lease',async t=>{
 const calls:unknown[]=[]
 const op=async(req:unknown)=>{calls.push(req);return {project:'build',holders:[],history:[{lease:'s1',how:'released'}]} as unknown as OpResult}
 const view=await mountView(<WatchdogPanel slug="fixture" dog={{...dog,state:'spent',spent:true,lease:'s1',fired:1}}
   dogs={[]} op={op} toast={()=>{}} close={()=>{}}/>,el=>el)
 t.after(()=>view.unmount());await inAct(async()=>flush(3))
 assert.deepEqual(calls,[{op:'slot_status',node:'build'}])
 assert.match(view.el.querySelector('.wd-description')?.textContent??'',/lease released/)
})

test('lease status trusts only a complete status response for this project',()=>{
 assert.deepEqual(slotClaimLeaseState({project:'build',holders:[{lease:'s1'}],history:[]},'s1','build'),{state:'held'})
 assert.deepEqual(slotClaimLeaseState({project:'build',holders:[],history:[]},'s1','build'),{state:'ended'})
 for(const value of [{project:'other',holders:[],history:[]},{project:'build',holders:[]},{project:'build',holders:[null],history:[]},null]){
  assert.equal(slotClaimLeaseState(value,'s1','build'),undefined)
 }
})

test('an older lease read cannot overwrite a new watchdog or organization',async t=>{
 const pending:Array<(r:OpResult)=>void>=[]
 const op=()=>new Promise<OpResult>(resolve=>pending.push(resolve))
 const show=(slug:string,lease:string)=><WatchdogPanel slug={slug} dog={{...dog,state:'spent',spent:true,lease,fired:1}}
   op={op} toast={()=>{}} close={()=>{}}/>
 const view=await mountView(show('old-org','s1'),el=>el);t.after(()=>view.unmount())
 await view.render(show('new-org','s2'))
 assert.equal(pending.length,2)
 await inAct(async()=>{pending[1]({project:'build',holders:[{lease:'s2'}],history:[]} as unknown as OpResult);await flush(3)})
 assert.match(view.el.querySelector('.wd-description')?.textContent??'',/lease s2.*lease is held/)
 await inAct(async()=>{pending[0]({project:'build',holders:[],history:[{lease:'s1',how:'released'}]} as unknown as OpResult);await flush(3)})
 assert.match(view.el.querySelector('.wd-description')?.textContent??'',/lease s2.*lease is held/)
 assert.doesNotMatch(view.el.querySelector('.wd-description')?.textContent??'',/released/)
})

test('a failed lease read preserves the grant with an honest unknown lease status',async t=>{
 const view=await mountView(<WatchdogPanel slug="fixture" dog={{...dog,lease:'s1',fired:1}}
   op={async()=>{throw Error('unavailable')}} toast={()=>{}} close={()=>{}}/>,el=>el)
 t.after(()=>view.unmount());await inAct(async()=>flush(3))
 assert.match(view.el.querySelector('.wd-description')?.textContent??'',/Granted.*lease status unavailable.*grant notification sent/)
 assert.doesNotMatch(view.el.querySelector('.wd-description')?.textContent??'',/queue position unavailable/)
})

test('a waiting claim does not issue a lease-status request',async t=>{
 const calls:unknown[]=[]
 const view=await mountView(<WatchdogPanel slug="fixture" dog={dog} dogs={[dog]}
   op={async req=>{calls.push(req);return {} as OpResult}} toast={()=>{}} close={()=>{}}/>,el=>el)
 t.after(()=>view.unmount());await inAct(async()=>flush(3))
 assert.deepEqual(calls,[])
 assert.match(view.el.querySelector('.wd-description')?.textContent??'',/1st in line/)
})
