import { useEffect,useId,useLayoutEffect,useRef,useState } from 'react'
import { createPortal } from 'react-dom'
import type { CSSProperties,ReactNode } from 'react'
import { useSurfaceDocument } from '../popout'
import { mailTagKey,mailTagHue,toggleMailTag } from './mailtags'
import { useEsc } from './shared'
import { CheckIcon,LabelIcon } from '../icons'

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

/** A searchable wrapping set of toggle pills, not another mail-body search.
 *  ONE FIELD (user 2026-10-18 11:32Z): the tag icon trigger, the selected
 *  chips, the host's text filter (`children`) and the clear button share one
 *  24px control, so the bar reads as one search box instead of three boxes.
 *  The chips stay separate buttons beside the trigger, never inside it. */
export function MailTagPicker({selected,choices,onChange,onSearch,onLoadMore,hasMore,loading,error,onRetry,children}:MailTagPickerProps&{children?:ReactNode}) {
  const [open,setOpen]=useState(false),[query,setQuery]=useState('')
  const root=useRef<HTMLDivElement>(null),trigger=useRef<HTMLButtonElement>(null),search=useRef<HTMLInputElement>(null)
  const control=useRef<HTMLDivElement>(null)
  const ownerDocument=useSurfaceDocument(),id=useId(),popover=useRef<HTMLDivElement>(null)
  const [position,setPosition]=useState({left:8,top:8,width:320,maxHeight:310})
  useEsc(()=>{setOpen(false);trigger.current?.focus()},open,ownerDocument)
  useLayoutEffect(()=>{
    if(!open)return
    const place=()=>{const r=control.current?.getBoundingClientRect(),w=ownerDocument.defaultView;if(!r||!w)return
      const width=Math.min(320,w.innerWidth-24),maxHeight=Math.min(310,w.innerHeight-16)
      const height=Math.min(popover.current?.offsetHeight||maxHeight,maxHeight)
      setPosition({left:Math.max(8,Math.min(r.left,w.innerWidth-width-12)),top:r.bottom+height+8>w.innerHeight?Math.max(8,r.top-height-4):r.bottom+4,width,maxHeight})}
    place();ownerDocument.addEventListener('scroll',place,true);ownerDocument.defaultView?.addEventListener('resize',place)
    return ()=>{ownerDocument.removeEventListener('scroll',place,true);ownerDocument.defaultView?.removeEventListener('resize',place)}
  },[open,ownerDocument,choices,selected.length,query,loading,error,hasMore,position.width,position.maxHeight])
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
  const commit=(tags:string[])=>{onChange(tags);setOpen(false);trigger.current?.focus()}
  const toggle=(tag:string)=>commit(toggleMailTag(selected,tag))
  return <div className="mail-tag-picker" ref={root}>
    <div className="mail-tag-control" ref={control}>
      <button type="button" ref={trigger} className="mail-tag-trigger" aria-label="Filter mail by tags" title="Filter mail by tags"
        aria-expanded={open} aria-controls={id} onClick={()=>setOpen(v=>!v)}>
        <LabelIcon fontSize="inherit"/>{!selected.length&&<span className="mail-tag-trigger-text">all tags</span>}
      </button>
      {selected.length>0&&<div className="mail-tag-selected">{selected.map(tag=><button type="button"
        className="mail-tag mail-tag-active" style={pill(tag)} key={mailTagKey(tag)} title={`Remove ${tag} filter`}
        aria-label={`Remove ${tag} filter`} aria-pressed="true" onClick={()=>toggle(tag)}>{tag}</button>)}</div>}
      {children}
      {selected.length>0&&<button type="button" className="mail-tag-clear" aria-label="Clear tag filter" title="Clear tag filter"
        onClick={()=>commit([])}>×</button>}
    </div>
    {open&&createPortal(<div className="mail-tag-popover settings" id={id} ref={popover} style={position}>
      <input ref={search} aria-label="Search tags" placeholder="Search tags" value={query}
        onChange={e=>{setQuery(e.target.value);onSearch?.(e.target.value)}}/>
      <div className="mail-tag-options" role="group" aria-label="Tag choices" onScroll={e=>{
        const box=e.currentTarget;if(hasMore&&!loading&&box.scrollTop+box.clientHeight>=box.scrollHeight-40)onLoadMore?.()
      }}>
        {options.map(tag=>{const on=chosen.has(mailTagKey(tag))
          return <button type="button" className="mail-tag mail-tag-choice" aria-pressed={on} style={pill(tag)}
            key={mailTagKey(tag)} title={tag} onClick={()=>toggle(tag)}>{on&&<CheckIcon className="mail-tag-check" fontSize="inherit"/>}{tag}</button>})}
        {!options.length&&!loading&&!error&&<span className="dim mail-tag-note">No matching tags</span>}
      </div>
      {loading&&<div role="status" className="dim mail-tag-note">loading tags...</div>}
      {error&&<div role="alert" className="mail-tag-note">Could not load tags. <button type="button" className="mail-tag-link" onClick={onRetry}>Retry</button></div>}
      {hasMore&&<button type="button" className="mail-tag-link" disabled={loading} onClick={onLoadMore}>Load more tags</button>}
    </div>,ownerDocument.body)}
  </div>
}
