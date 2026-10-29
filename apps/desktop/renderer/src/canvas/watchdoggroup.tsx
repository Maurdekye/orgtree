import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { CSSProperties } from 'react'
import type { Watchdog } from '../types'
import { getWatchdogPage } from '../api'
import { ModalOverPins } from './modalpin'
import { useEsc } from './shared'
import { WatchdogLink } from './watchdoglink'
import { WatchdogSatellite } from './watchdogchip'
import { WATCHDOG_CARD_LIMIT } from './watchdogroute'
import type { WatchdogCount } from './watchdogroute'
import { DOG_W, DOG_H } from './shared'
import { liveRevision, onLiveBump } from '../livebus'
import { useSurfaceDocument } from '../popout'

export { WATCHDOG_CARD_LIMIT } from './watchdogroute'
export type { WatchdogCount } from './watchdogroute'
export const WATCHDOG_GROUP_W = 104
export const WATCHDOG_PAGE_SIZE = 50

/** Counts come from the feed, never from a possibly partial preview. */
export function watchdogGroups(dogs: Watchdog[], counts: Record<string, WatchdogCount> = {}) {
  const groups = new Map<string, { owner: string; dogs: Watchdog[]; total: number }>()
  for (const dog of dogs) {
    const group = groups.get(dog.owner) ?? { owner: dog.owner, dogs: [], total: 0 }
    group.dogs.push(dog); groups.set(dog.owner, group)
  }
  for (const [owner, count] of Object.entries(counts)) {
    const group = groups.get(owner) ?? { owner, dogs: [], total: 0 }
    group.total = count.total; groups.set(owner, group)
  }
  for (const group of groups.values()) if (!counts[group.owner]) group.total = group.dogs.length
  return [...groups.values()]
}

export function WatchdogCanvasCards({dogs,counts,org,onOpen,position,visible}: {
  dogs:Watchdog[];counts?:Record<string,WatchdogCount>;org:string;onOpen:(id:string)=>void
  position:(id:string)=>{x:number;y:number}|undefined
  visible:(owner:string,p:{x:number;y:number;w:number;h:number})=>boolean
}) {
  return <>{watchdogGroups(dogs,counts).map(group=>{
    const first=group.dogs[0]
    if(!first)return null
    if(group.total>WATCHDOG_CARD_LIMIT){
      const p=position(first.id)
      if(!p||!visible(group.owner,{...p,w:WATCHDOG_GROUP_W,h:DOG_H}))return null
      return <WatchdogGroup key={org+':'+group.owner} {...group} org={org} onOpen={onOpen} className="wd-chip armed"
        style={{transform:`translate(${p.x}px, ${p.y}px)`,width:WATCHDOG_GROUP_W,height:DOG_H}}/>
    }
    return group.dogs.map(w=>{
      const p=position(w.id)
      return !p||!visible(w.owner,{...p,w:DOG_W,h:DOG_H})?null:<WatchdogSatellite key={w.id} dog={w} dogs={dogs} org={org}
        style={{transform:`translate(${p.x}px, ${p.y}px)`,width:DOG_W,height:DOG_H}} onOpen={onOpen}/>
    })
  })}</>
}

export function WatchdogGroup({ owner, dogs, total, org, onOpen, className = 'desk-nav-chip', style, kept=false }: {
  owner: string; dogs: Watchdog[]; total: number; org?: string
  onOpen: (id: string) => void; className?: string; style?: CSSProperties; kept?:boolean
}) {
  const [open, setOpen] = useState(false)
  return <>
    <button type="button" data-watchdog-group={owner} className={className+' watchdog-group'} style={style}
      title={`${total} watchdogs owned by ${owner}; click to list`}
      aria-haspopup="dialog" aria-expanded={open} onPointerDown={e=>e.stopPropagation()}
      onClick={e=>{e.stopPropagation();setOpen(true)}}>{total} watchdogs</button>
    {open && <WatchdogList key={(org??'')+':'+owner} owner={owner} dogs={dogs} total={total} org={org} kept={kept}
      onOpen={id=>{setOpen(false);onOpen(id)}} close={()=>setOpen(false)}/>}
  </>
}

function WatchdogList({owner,dogs,total,org,onOpen,close,kept}: {
  owner:string;dogs:Watchdog[];total:number;org?:string;onOpen:(id:string)=>void;close:()=>void;kept:boolean
}) {
  useEsc(close)
  const [cursor,setCursor]=useState('0'),[back,setBack]=useState<string[]>([])
  const [page,setPage]=useState<{watchdogs:Watchdog[];next_cursor:string|null;total:number}|null>(null)
  const [error,setError]=useState(''),[retry,setRetry]=useState(0)
  const closeRef=useRef<HTMLButtonElement>(null)
  const surfaceDocument=useSurfaceDocument()
  const epoch=useSyncExternalStore(onLiveBump,liveRevision)
  useEffect(()=>{const opener=surfaceDocument.activeElement as HTMLElement|null;closeRef.current?.focus();return()=>{if(opener?.isConnected)opener.focus()}},[surfaceDocument])
  // The page replaces the previous page: expanding a large inventory does
  // not accumulate every row in memory. Ignore replies after close/org change.
  const revision=dogs.map(w=>w.id+':'+w.state+':'+w.fired).join('|')
  useEffect(()=>{
    let current=true;setError('');setPage(null)
    if(total<=dogs.length){
      const offset=Number(cursor)
      setPage({watchdogs:dogs.slice(offset,offset+WATCHDOG_PAGE_SIZE),total,
        next_cursor:offset+WATCHDOG_PAGE_SIZE<dogs.length?String(offset+WATCHDOG_PAGE_SIZE):null})
    } else if(org) getWatchdogPage(org,owner,cursor,kept).then(p=>{if(current)setPage(p)},e=>{if(current)setError(e.message)})
    else setError('Watchdog list is unavailable.')
    return()=>{current=false}
  },[org,owner,cursor,total,revision,retry,kept,epoch])
  return <ModalOverPins><div className="overlay" onClick={close} onPointerDown={e=>e.stopPropagation()}>
    <div className="settings content-height watchdog-list" role="dialog" aria-modal="true" aria-label={owner+' watchdogs'} onClick={e=>e.stopPropagation()}>
      <h3>{owner} · {page?.total??total} watchdogs</h3>
      <button ref={closeRef} type="button" className="watchdog-list-close" onClick={close}>close</button>
      {error?<div role="alert">{error} <button onClick={()=>setRetry(n=>n+1)}>retry</button></div>
        :!page?<div role="status">Loading watchdogs…</div>
          :<div className="watchdog-list-rows">{page.watchdogs.map(w=><WatchdogLink key={w.id} dog={w} org={org} onOpen={onOpen} countdown/>)}</div>}
      {page && <div className="row watchdog-list-pages">
        <button disabled={!back.length} onClick={()=>{setCursor(back[back.length-1]!);setBack(b=>b.slice(0,-1))}}>previous</button>
        <span>{page.watchdogs.length} shown · {page.total} total</span>
        <button disabled={!page.next_cursor} onClick={()=>{setBack(b=>[...b,cursor]);setCursor(page.next_cursor!)}}>next</button>
      </div>}
    </div>
  </div></ModalOverPins>
}
