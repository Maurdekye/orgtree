import test from 'node:test'
import assert from 'node:assert/strict'
import {mountView,inAct,flush} from './harness'
import {watchdogDescription} from '../src/canvas/watchdogdescription'
import {WatchdogPanel} from '../src/canvas/modals'
import type {Watchdog,OpResult} from '../src/types'
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
