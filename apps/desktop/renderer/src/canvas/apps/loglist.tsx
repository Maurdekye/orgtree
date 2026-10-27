import {useEffect,useId,useRef,useState} from 'react'
import type {ReactNode,UIEvent} from 'react'
import {useLoadWhenSeen} from '../loadmore'
import {onAppsLog} from './store'
import type {AppsLogChange} from './store'

/** Rows per page; the engine's retention (not this) decides where the list ends. */
export const LOG_PAGE=50
/** One page of a log. Newest-first pages continue with before, after pages with after. */
export interface LogPage<T> {items:T[];next_cursor:number|null}
/** No cursor or before: a page newest first. after: newer rows, oldest first. */
export type LogCursor={before:number}|{after:number}|Record<string,never>
const newestFirst=<T extends {seq:number}>(rows:T[]):T[]=>[...new Map(rows.map(r=>[r.seq,r])).values()].sort((a,b)=>b.seq-a.seq)

/** History and Permission history (user 2026-10-27 md2006b10cf40: "make the hidtory
 * tab reload in realtime, be more list like wity expandable rows, and lazily losd as
 * you sfrollcdown (remof3 th4 refresh button)"; m838e66af753b: "ssme for permission
 * history"). One compact row per entry, newest first, that expands to its details
 * and collapses again. The newest page loads first and older pages as the list's
 * end comes into view, like the desks' history tables. Each live change it follows
 * reads only rows newer than the newest shown; the two cursors read disjoint
 * ranges and rows merge by seq, so a row never repeats or goes missing. The list
 * ends at the oldest row the engine keeps. */
export function LogList<T extends {seq:number}>({slug,label,read,follows,summary,details,empty}:{
  slug:string;label:string;read:(cursor:LogCursor)=>Promise<LogPage<T>>;follows:(change:AppsLogChange)=>boolean
  summary:(row:T)=>ReactNode;details:(row:T)=>ReactNode;empty:string
}){
  // The rows live in a ref so overlapping reads merge into the latest list; render() shows it.
  const log=useRef<{rows:T[]|null;older:number|null}>({rows:null,older:null}),[,render]=useState(0)
  const [open,setOpen]=useState<ReadonlySet<number>>(new Set()),[error,setError]=useState(''),[loading,setLoading]=useState(false),[failed,setFailed]=useState(false)
  const id=useId(),mounted=useRef(true),paging=useRef(false),following=useRef(false),pending=useRef(false),more=useRef<HTMLLIElement>(null)
  const latest=useRef({read,follows});latest.current={read,follows}
  const show=(rows:T[],older:number|null)=>{log.current={rows:newestFirst(rows),older};render(n=>n+1)}
  // Newer rows, oldest first, until there are none; a change arriving meanwhile reads again.
  const follow=async()=>{
    if(log.current.rows===null||following.current){pending.current=true;return}
    following.current=true
    try{
      for(let after=log.current.rows?.[0]?.seq??0;;){
        const page=await latest.current.read({after});if(!mounted.current)return
        if(page.items.length)show([...log.current.rows??[],...page.items],log.current.older)
        if(page.next_cursor===null)break;after=page.next_cursor
      }
    }catch(e){if(mounted.current)setError(String(e))}
    finally{following.current=false;if(pending.current&&mounted.current){pending.current=false;void follow()}}
  }
  const loadOlder=()=>{
    const before=log.current.older;if(before===null||paging.current)return
    paging.current=true;setLoading(true);setFailed(false)
    void latest.current.read({before}).then(page=>{if(mounted.current&&log.current.older===before)show([...log.current.rows??[],...page.items],page.next_cursor)})
      .catch(()=>{if(mounted.current)setFailed(true)}).finally(()=>{paging.current=false;if(mounted.current)setLoading(false)})
  }
  useEffect(()=>{let alive=true;mounted.current=true
    void latest.current.read({}).then(page=>{if(!alive)return;show([...log.current.rows??[],...page.items],page.next_cursor);if(pending.current){pending.current=false;void follow()}})
      .catch(e=>{if(alive)setError(String(e))})
    const stop=onAppsLog(slug,change=>{if(latest.current.follows(change))void follow()})
    return()=>{alive=false;mounted.current=false;stop()}
  },[slug])
  useLoadWhenSeen(more,log.current.older===null?null:String(log.current.older),loadOlder)
  const onScroll=(event:UIEvent<HTMLOListElement>)=>{const el=event.currentTarget;if(el.scrollHeight>el.clientHeight&&el.scrollHeight-el.clientHeight-el.scrollTop<160)loadOlder()}
  const toggle=(seq:number)=>setOpen(old=>{const next=new Set(old);if(!next.delete(seq))next.add(seq);return next})
  const {rows,older}=log.current
  if(rows===null)return error?<p role="alert">{error}</p>:<p className="dim">Loading…</p>
  return <>
    {rows.length?<ol className="custom-app-log" aria-label={label} onScroll={onScroll}>
      {rows.map(row=>{const expanded=open.has(row.seq),region=`${id}-${row.seq}`;return <li key={row.seq} className={expanded?'open':undefined}>
        <button type="button" className="custom-app-log-row" aria-expanded={expanded} aria-controls={expanded?region:undefined} onClick={()=>toggle(row.seq)}>{summary(row)}</button>
        {expanded&&<div id={region} className="custom-app-log-details">{details(row)}</div>}
      </li>})}
      {older!==null&&<li ref={more} className="custom-app-log-more" role="status">{loading?'Loading older entries…':failed?<>Could not load older entries. <button type="button" onClick={loadOlder}>Retry</button></>:'Scroll for older entries'}</li>}
    </ol>:<p className="dim">{empty}</p>}
    {error&&<p role="alert">{error}</p>}
  </>
}
