import { useCallback,useEffect,useRef,useState } from 'react'
import type { InboxPayload,MailEntry } from './types'
import { mailMatchesTags,mailTagKey } from './canvas/mailtags'

export interface InboxSelectionRequest {key:string;id:string|null}
const arrivalsKey=(slug:string)=>`orgtree-user-inbox-arrivals:${slug}`
const openedKey=(slug:string)=>`orgtree-user-inbox-last-opened:${slug}`
function saved(slug:string){
  try{
    const ids:unknown=JSON.parse(window.sessionStorage.getItem(arrivalsKey(slug))??'null')
    return {id:window.sessionStorage.getItem(openedKey(slug)),ids:Array.isArray(ids)?new Set(ids.filter((v):v is string=>typeof v==='string')):null}
  }catch{return {id:null,ids:null}}
}

/** Filter changes and genuine matching arrivals may request selection. An
 * unrelated live revision never replays a request over a user's current choice. */
export function useInboxTagSelection(slug:string,base:InboxPayload|null|undefined,tags:readonly string[],visible:boolean,
  lookup:(id:string)=>Promise<MailEntry|null>){
  const tagKey=JSON.stringify([...new Set(tags.map(mailTagKey))].sort()),identity=JSON.stringify([slug,tagKey])
  const start=useRef<{slug:string;id:string|null;ids:Set<string>|null;tagKey:string|null}>({slug,...saved(slug),tagKey:null})
  if(start.current.slug!==slug)start.current={slug,...saved(slug),tagKey:null}
  const generation=useRef(0),sequence=useRef(0)
  const [state,setState]=useState<{identity:string;request:InboxSelectionRequest;extra:MailEntry|null}|null>(null)
  const revision=JSON.stringify([base?.mail_revision,base?.pending.map(m=>m.id),base?.delivered.map(m=>m.id)])
  const remember=useCallback((id:string)=>{
    if(start.current.id!==id){start.current.id=id;++generation.current}
    try{window.sessionStorage.setItem(openedKey(slug),id)}catch{/* storage is optional */}
  },[slug])
  const forget=useCallback((id:string)=>{
    if(start.current.id===id){
      start.current.id=null;++generation.current
      try{window.sessionStorage.removeItem(openedKey(slug))}catch{/* storage is optional */}
    }
    setState(old=>old?.extra?.id===id||old?.request.id===id
      ?{identity,request:{key:`${identity}:${++sequence.current}`,id:null},extra:null}:old)
  },[slug,identity])
  useEffect(()=>{
    if(!visible||!base)return
    const previous=start.current,rows=[...base.pending.map(m=>({...m,unread:true})),...base.delivered.map(m=>({...m,unread:false}))]
    const changed=previous.tagKey!==tagKey,wasFiltered=previous.tagKey!==null&&previous.tagKey!=='[]'
    const incoming=previous.ids===null?[]:rows.filter(m=>!previous.ids!.has(m.id)&&mailMatchesTags(m.tags,tags))
      .sort((a,b)=>b.at.localeCompare(a.at)||b.id.localeCompare(a.id))
    previous.ids=new Set(rows.map(m=>m.id));previous.tagKey=tagKey
    // Ordinary inbox opening keeps its existing unread/default policy. Clearing
    // a filter carries the currently viewed mail into that ordinary inbox.
    if(!tags.length&&!wasFiltered)return
    try{window.sessionStorage.setItem(arrivalsKey(slug),JSON.stringify([...previous.ids]))}catch{/* storage is optional */}
    if(!changed&&(!tags.length||!incoming.length))return
    const candidate=tags.length&&incoming.length?incoming[0]!.id:previous.id
    const request=++generation.current
    if(candidate)previous.id=candidate
    const publish=(row:MailEntry|null)=>{
      if(generation.current!==request)return
      const valid=!!row&&row.id===candidate&&mailMatchesTags(row.tags,tags)
      setState({identity,request:{key:`${identity}:${++sequence.current}`,id:valid?row!.id:null},extra:valid?row:null})
    }
    if(!candidate){publish(null);return}
    const known=rows.find(m=>m.id===candidate)
    if(known)publish(known)
    else void lookup(candidate).then(publish).catch(()=>publish(null))
    // Cancellation is owned by a new identity/request or an explicit selection,
    // not by a harmless record refresh while the exact lookup is in flight.
  },[slug,tagKey,visible,revision,lookup])
  useEffect(()=>()=>{++generation.current},[slug,tagKey,visible])
  if(state?.identity===identity)return {...state,remember,forget}
  return {identity,request:tags.length?{key:`pending:${identity}`,id:null}:undefined,extra:null,remember,forget}
}

/** Admit one exact lookup without throwing away retained history or guessing
 * the server's read state. The normal loaded row wins whenever it is present. */
export function includeSelectedMail(box:InboxPayload|null|undefined,row:MailEntry|null,tags:readonly string[]):InboxPayload|null|undefined{
  if(!box||!row||!mailMatchesTags(row.tags,tags)||[...box.pending,...box.delivered].some(m=>m.id===row.id))return box
  return row.unread===true?{...box,pending:[...box.pending,row]}:{...box,delivered:[...box.delivered,row]}
}
