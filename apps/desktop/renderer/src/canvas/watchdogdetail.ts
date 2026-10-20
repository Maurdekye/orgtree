import { useEffect, useState, useSyncExternalStore } from 'react'
import type { Watchdog } from '../types'
import { getWatchdog } from '../api'
import { liveRevision, onLiveBump } from '../livebus'

/** An exact handle outside the eight-row preview is still a real destination. */
export function useWatchdogDetail(org:string,id:string|null,dogs:Watchdog[]) {
  const known=dogs.find(w=>w.id===id&&!w.metadata_only)
  const epoch=useSyncExternalStore(onLiveBump,liveRevision)
  const [loaded,setLoaded]=useState<{key:string;dog?:Watchdog;error?:string}|null>(null)
  const key=org+'\n'+id
  useEffect(()=>{
    if(!id||known)return
    let current=true
    getWatchdog(org,id).then(page=>{
      if(current)setLoaded({key,dog:page.watchdogs.find(w=>w.id===id),error:page.watchdogs.length?undefined:'This watchdog is no longer available.'})
    },e=>{if(current)setLoaded({key,error:e.message})})
    return()=>{current=false}
  },[org,id,known,key,epoch])
  return {dog:known??(loaded?.key===key?loaded.dog:undefined),error:loaded?.key===key?loaded.error:undefined}
}
