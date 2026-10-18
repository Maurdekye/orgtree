import { useEffect,useId,useLayoutEffect,useRef,useState } from 'react'
import { createPortal } from 'react-dom'
import type { CSSProperties } from 'react'
import { useSurfaceDocument } from '../popout'
import { mailTagKey,mailTagHue,toggleMailTag } from './mailtags'
import { useEsc } from './shared'
import { ExpandMoreIcon } from '../icons'

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
      {selected.length>0&&<div className="mail-tag-selected">{selected.map(tag=><button type="button"
        className="mail-tag mail-tag-active" style={pill(tag)} key={mailTagKey(tag)} title={`Remove ${tag} filter`}
        aria-label={`Remove ${tag} filter`} aria-pressed="true" onClick={()=>toggle(tag)}>{tag}</button>)}</div>}
      <button type="button" ref={trigger} className="mail-tag-trigger" aria-label="Filter mail by tags"
        aria-expanded={open} aria-controls={id} onClick={()=>setOpen(v=>!v)}>
        {selected.length?<ExpandMoreIcon fontSize="inherit"/>:'all tags'}
      </button>
    </div>
    {selected.length>0&&<button type="button" className="mail-tag-clear" aria-label="Clear tag filter" onClick={()=>commit([])}>×</button>}
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
