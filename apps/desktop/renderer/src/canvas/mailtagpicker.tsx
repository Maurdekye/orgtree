import { useEffect,useId,useRef,useState } from 'react'
import type { CSSProperties } from 'react'
import { useSurfaceDocument } from '../popout'
import { mailTagKey,mailTagHue } from './mailtags'

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
  const ownerDocument=useSurfaceDocument(),id=useId()
  useEffect(()=>{
    if(!open)return
    search.current?.focus()
    const outside=(e:PointerEvent)=>{if(!root.current?.contains(e.target as Node))setOpen(false)}
    const escape=(e:KeyboardEvent)=>{if(e.key==='Escape'){e.preventDefault();e.stopPropagation();setOpen(false);trigger.current?.focus()}}
    ownerDocument.addEventListener('pointerdown',outside,true)
    ownerDocument.addEventListener('keydown',escape,true)
    return ()=>{ownerDocument.removeEventListener('pointerdown',outside,true);ownerDocument.removeEventListener('keydown',escape,true)}
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
    {open&&<div className="mail-tag-popover" id={id}>
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
    </div>}
  </div>
}
