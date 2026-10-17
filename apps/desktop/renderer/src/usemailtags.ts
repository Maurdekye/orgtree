import { useCallback, useEffect, useRef, useState } from 'react'
import { getMailTagChoices, getTaggedInbox } from './api'
import type { InboxPayload, MailEntry } from './types'
import { mailTagKey } from './canvas/mailtags'

const empty = ():InboxPayload => ({pending:[],delivered:[],sent:[]})
const combine=(a:InboxPayload,b:InboxPayload):InboxPayload=>{
  const rows=new Map<string,MailEntry>()
  for(const row of [...a.pending,...a.delivered,...b.pending,...b.delivered])rows.set(row.id,row)
  const unread=new Set([...a.pending,...b.pending].map(m=>m.id))
  for(const row of b.delivered)unread.delete(row.id)
  return {pending:[...rows.values()].filter(m=>unread.has(m.id)),delivered:[...rows.values()].filter(m=>!unread.has(m.id)),sent:[],next_cursor:b.next_cursor}
}

/** One bounded read per deliberate filter/page or pushed inbox change. No poll. */
export function useTaggedUserMail(slug:string,base:InboxPayload|null|undefined,tag:string,visible:boolean,refresh:unknown=0){
  const key=mailTagKey(tag),identity=JSON.stringify([slug,key])
  const generation=useRef(0),busy=useRef(false)
  const [retryKey,retry]=useState(0)
  const [choices,setChoices]=useState<{slug:string;labels:string[]}>({slug,labels:[]})
  const [state,setState]=useState<{identity:string;box:InboxPayload;loading:boolean;error:string|null}>({identity,box:empty(),loading:false,error:null})
  // Record views also change for turns and costs; those must not refetch mail.
  const revision=JSON.stringify([base?.pending.map(m=>m.id),base?.delivered.map(m=>m.id)])
  useEffect(()=>{
    const request=++generation.current;busy.current=false
    if(!visible||!base)return
    let live=true
    void getMailTagChoices(slug,key).then(labels=>{if(live)setChoices({slug,labels})}).catch(()=>{})
    if(!key){setState({identity,box:empty(),loading:false,error:null});return ()=>{live=false}}
    busy.current=true
    setState(old=>({identity,box:old.identity===identity?old.box:empty(),loading:true,error:null}))
    void getTaggedInbox(slug,tag.trim()).then(box=>{
      if(live&&generation.current===request)setState({identity,box,loading:false,error:null})
    }).catch((e:Error)=>{
      if(live&&generation.current===request)setState(old=>({...old,loading:false,error:e.message}))
    }).finally(()=>{if(generation.current===request)busy.current=false})
    return ()=>{live=false}
    // `revision` is the immutable mail membership, not the whole record object.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[slug,key,visible,revision,refresh,retryKey])
  const loadMore=useCallback(()=>{
    const cursor=state.identity===identity?state.box.next_cursor:null
    if(!visible||!key||!cursor||busy.current)return
    busy.current=true;const request=generation.current
    setState(old=>({...old,loading:true,error:null}))
    void getTaggedInbox(slug,tag.trim(),cursor).then(box=>{
      if(generation.current===request)setState(old=>({identity,box:combine(old.box,box),loading:false,error:null}))
    }).catch((e:Error)=>{
      if(generation.current===request)setState(old=>({...old,loading:false,error:e.message}))
    }).finally(()=>{if(generation.current===request)busy.current=false})
  },[slug,key,tag,visible,identity,state])
  useEffect(()=>()=>{++generation.current},[])
  const current=state.identity===identity?state:{identity,box:empty(),loading:!!key,error:null}
  return {...current,choices:choices.slug===slug?choices.labels:[],loadMore,retry:()=>retry(v=>v+1)}
}
