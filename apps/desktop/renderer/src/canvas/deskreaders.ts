import { useEffect, useRef } from 'react'
import { getReaderAvailability } from '../api'
import type { ReaderAvailability } from '../api'
import { useDeskMemory } from './desktabs'
import { usePolled } from './shared'

/** Display availability follows the list's Show options, never its search or
 * badge count. An active tab stays available until the reader leaves it. */
export function deskReaderVisible(tab:string,shown:string,available:boolean | undefined):boolean {
  return tab===shown || available===true
}
export function useDeskReaderAvailability(org:string,nid:string,archived=false,backlogged=false,retired=false) {
  const key=JSON.stringify([org,nid,archived,backlogged,retired])
  const packet=usePolled(async()=>({key,value:await getReaderAvailability(org,nid,archived,backlogged,retired)}),[key],15000)
  return packet?.key===key ? packet.value : null
}
export function useDeskReaderTeam(org:string,nid:string,kind:'work'|'presented',
  rows:ReaderAvailability['work'] | undefined,active:boolean) {
  const [saved,save]=useDeskMemory(org,nid,kind==='work'?'work-team':'presented-team','auto',['auto','off','on'])
  const own=rows?.own
  // Arrival of own content ends the remembered manual opt-out. Do not move
  // an already-open reader merely because the default has changed.
  useEffect(()=>{if(own && saved==='off')save('auto')},[own,saved,save])
  const defaultTeam=saved==='on' || (!own && rows?.team===true && saved!=='off')
  const key=JSON.stringify([org,nid,kind])
  const hold=useRef({key,active:false,team:defaultTeam,ready:false})
  if(hold.current.key!==key)hold.current={key,active:false,team:defaultTeam,ready:false}
  if(!active)hold.current={key,active:false,team:defaultTeam,ready:!!rows}
  else if(!hold.current.active || !hold.current.ready)hold.current={key,active:true,team:defaultTeam,ready:!!rows}
  const team=active ? hold.current.team : defaultTeam
  const setTeam=(next:boolean)=>{
    hold.current={key,active,team:next,ready:true}
    save(next?'on':own?'auto':'off')
  }
  return {team,setTeam,ready:active ? hold.current.ready : !!rows}
}
