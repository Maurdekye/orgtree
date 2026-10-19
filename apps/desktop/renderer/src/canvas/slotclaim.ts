import type {Watchdog} from '../types'
import {ordinal,slotPlace} from './slots'

export interface SlotClaimLeaseState { state:'held'|'ended'; how?:string }

/** The public watchdog projection intentionally omits the private slot ordinal. */
export function slotGrantNotified(dog:Watchdog):boolean {
  return !!dog.spent||dog.state==='spent'||dog.fired>0||!!dog.last_fired
}

/** Read the existing per-project status, whose holder list is complete (<=64).
 * Never infer an ended lease from the org feed's capped active-lease list. */
export function slotClaimLeaseState(value:unknown,lease:string,project:string):SlotClaimLeaseState|undefined {
  const r=value as {project?:unknown;holders?:Array<{lease?:unknown}>;history?:Array<{lease?:unknown;how?:unknown}>}|null
  if(!r||r.project!==project||!Array.isArray(r.holders)||!Array.isArray(r.history)
    ||r.holders.some(h=>!h||typeof h.lease!=='string'))return undefined
  if(r.holders.some(h=>h.lease===lease))return {state:'held'}
  const ended=r.history.find(h=>h?.lease===lease)
  return {state:'ended',...(typeof ended?.how==='string'?{how:ended.how}:{})}
}

function leaseEnding(how?:string):string {
  if(how==='released')return 'lease released'
  if(how==='expired'||how?.startsWith('idle:'))return 'lease expired'
  if(how==='revoked'||how==='halted'||how==='retired'||how?.startsWith('released (forced'))return 'lease revoked'
  return how?`lease ended (${how})`:'lease is no longer held; end details unavailable'
}

export function slotClaimDescription(dog:Watchdog,dogs:Watchdog[],target:string,lease?:SlotClaimLeaseState):string {
  const notified=slotGrantNotified(dog)
  const granted=notified||!!dog.lease||(dog.slot!=null&&dog.slot>0)
  if(granted){
    const identity=`Granted a concurrency slot of ${target}${dog.lease?` (lease ${dog.lease})`:''}`
    const detail=lease?.state==='held'?'lease is held':lease?.state==='ended'?leaseEnding(lease.how)
      :dog.lease?'lease status unavailable':'lease details unavailable'
    return `${identity}; ${detail}; grant notification ${notified?'sent':'pending'}.`
  }
  if(dog.state==='paused')return `Concurrency slot claim for ${target} is paused; resuming rejoins at the back of the line.`
  if(dog.state!=='armed')return `Concurrency slot claim for ${target} is no longer waiting; no grant is recorded.`
  const place=slotPlace(dog,dogs)
  return place!=null?`Concurrency slot claim: ${ordinal(place)} in line for ${target}.`
    :`Concurrency slot claim for ${target}; queue position unavailable.`
}
