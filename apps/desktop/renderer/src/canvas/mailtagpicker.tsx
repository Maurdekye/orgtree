import { useEffect,useId,useLayoutEffect,useRef,useState } from 'react'
import { createPortal } from 'react-dom'
import type { CSSProperties } from 'react'
import { useSurfaceDocument } from '../popout'
import { mailTagKey,mailTagHue } from './mailtags'
import { useEsc } from './shared'

export interface MailTagPickerProps {
  selected:string[]
  choices:string[]
  onChange:(tags:string[])=>void
  onSearch?:(text:string)=>void
  onLoadMore?:()=>void
  hasMore?:boolean
  loading?:boolean
  error?:string|null
  onRetry?:()=>void
}

/** A searchable wrapping set of toggle pills, not another mail-body search. */
export function MailTagPicker({selected,choices,onChange,onSearch,onLoadMore,hasMore,loading,error,onRetry}:MailTagPickerProps) {
  const [open,setOpen]=useState(false),[query,setQuery]=useState('')
  const root=useRef<HTMLDivElement>(null),trigger=useRef<HTMLButtonElement>(null),search=useRef<HTMLInputElement>(null)
  const ownerDocument=useSurfaceDocument(),id=useId(),popover=useRef<HTMLDivElement>(null)
  const [position,setPosition]=useState({left:8,top:8,width:320})
  useEsc(()=>{setOpen(false);trigger.current?.focus()},open,ownerDocument)
  useLayoutEffect(()=>{
    if(!open)return
    const place=()=>{const r=trigger.current?.getBoundingClientRect(),w=ownerDocument.defaultView;if(!r||!w)return
      const width=Math.min(320,w.innerWidth-24);setPosition({left:Math.max(8,Math.min(r.left,w.innerWidth-width-12)),top:r.bottom+310>w.innerHeight?Math.max(8,r.top-310):r.bottom+4,width})}
    place();ownerDocument.addEventListener('scroll',place,true);ownerDocument.defaultView?.addEventListener('resize',place)
    return ()=>{ownerDocument.removeEventListener('scroll',place,true);ownerDocument.defaultView?.removeEventListener('resize',place)}
  },[open,ownerDocument])
  useEffect(()=>{
    if(!open)return
    search.current?.focus()
    const outside=(e:PointerEvent)=>{if(!root.current?.contains(e.target as Node)&&!popover.current?.contains(e.target as Node))setOpen(false)}
    ownerDocument.addEventListener('pointerdown',outside,true)
    return ()=>{ownerDocument.removeEventListener('pointerdown',outside,true)}
  },[open,ownerDocument])
  const chosen=new Set(selected.map(mailTagKey))
  const options=choices.filter(t=>mailTagKey(t).includes(mailTagKey(query)))
  const pill=(tag:string)=>({'--mail-tag-hue':mailTagHue(tag)} as CSSProperties)
  const toggle=(tag:string)=>onChange(chosen.has(mailTagKey(tag))?selected.filter(t=>mailTagKey(t)!==mailTagKey(tag)):[...selected,tag])
  return <div className="mail-tag-picker" ref={root}>
    <button type="button" ref={trigger} className="mail-tag-trigger" aria-label="Filter mail by tags"
      aria-expanded={open} aria-controls={id} onClick={()=>setOpen(v=>!v)}>
      {selected.length?selected.map(tag=><span className="mail-tag" style={pill(tag)} key={mailTagKey(tag)} title={tag}>{tag}</span>):'all tags'}
    </button>
    {selected.length>0&&<button type="button" aria-label="Clear tag filter" onClick={()=>onChange([])}>clear</button>}
    {open&&createPortal(<div className="mail-tag-popover settings" id={id} ref={popover} style={position}>
      <input ref={search} aria-label="Search tags" placeholder="Search tags" value={query}
        onChange={e=>{setQuery(e.target.value);onSearch?.(e.target.value)}}/>
      <div className="mail-tag-options" role="group" aria-label="Tag choices" onScroll={e=>{
        const box=e.currentTarget;if(hasMore&&!loading&&box.scrollTop+box.clientHeight>=box.scrollHeight-40)onLoadMore?.()
      }}>
        {options.map(tag=><button type="button" className="mail-tag mail-tag-choice" aria-pressed={chosen.has(mailTagKey(tag))}
          style={pill(tag)} key={mailTagKey(tag)} title={tag} onClick={()=>toggle(tag)}>{tag}</button>)}
        {!options.length&&!loading&&!error&&<span className="dim">No matching tags</span>}
      </div>
      {loading&&<div role="status" className="dim">loading tags...</div>}
      {error&&<div role="alert">Could not load tags. <button type="button" onClick={onRetry}>Retry</button></div>}
      {hasMore&&<button type="button" disabled={loading} onClick={onLoadMore}>Load more tags</button>}
    </div>,ownerDocument.body)}
  </div>
}
