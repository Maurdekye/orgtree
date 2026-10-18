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
  return {...b,pending:[...rows.values()].filter(m=>unread.has(m.id)),delivered:[...rows.values()].filter(m=>!unread.has(m.id)),sent:[],next_cursor:b.next_cursor}
}

/** One bounded read per deliberate filter/page or pushed inbox change. No poll. */
export function useTaggedUserMail(slug:string,base:InboxPayload|null|undefined,tags:readonly string[],visible:boolean,refresh:unknown=0){
  const labels=[...new Map(tags.map(t=>[mailTagKey(t),t.trim()])).values()]
  const key=JSON.stringify(labels.map(mailTagKey).sort()),active=labels.length>0,identity=JSON.stringify([slug,key])
  const generation=useRef(0),busy=useRef(false)
  const [retryKey,retry]=useState(0)
  const [state,setState]=useState<{identity:string;slug:string;box:InboxPayload;loading:boolean;error:string|null}>({identity,slug,box:empty(),loading:false,error:null})
  // Record views also change for turns and costs; those must not refetch mail.
  const revision=JSON.stringify([base?.mail_revision,base?.pending.map(m=>m.id),base?.delivered.map(m=>m.id)])
  useEffect(()=>{
    const request=++generation.current;busy.current=false
    if(!visible||!base)return
    let live=true
    if(!active){setState({identity,slug,box:empty(),loading:false,error:null});return ()=>{live=false}}
    busy.current=true
    // Keep the last result for this inbox while the next filter is loading.
    // MailList applies the new selection locally, so matching rows remain in
    // place and aggregate controls do not disappear between requests.
    setState(old=>({identity,slug,box:old.slug===slug?old.box:empty(),loading:true,error:null}))
    void getTaggedInbox(slug,labels).then(box=>{
      if(live&&generation.current===request)setState({identity,slug,box,loading:false,error:null})
    }).catch((e:Error)=>{
      if(live&&generation.current===request)setState(old=>({...old,loading:false,error:e.message}))
    }).finally(()=>{if(generation.current===request)busy.current=false})
    return ()=>{live=false}
    // `revision` is the immutable mail membership, not the whole record object.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[slug,key,visible,revision,refresh,retryKey])
  const loadMore=useCallback(()=>{
    const cursor=state.identity===identity?state.box.next_cursor:null
    if(!visible||!active||!cursor||busy.current)return
    busy.current=true;const request=generation.current
    setState(old=>({...old,loading:true,error:null}))
    void getTaggedInbox(slug,labels,cursor).then(box=>{
      if(generation.current===request)setState(old=>({identity,slug,box:combine(old.box,box),loading:false,error:null}))
    }).catch((e:Error)=>{
      if(generation.current===request)setState(old=>({...old,loading:false,error:e.message}))
    }).finally(()=>{if(generation.current===request)busy.current=false})
  },[slug,key,visible,identity,state])
  useEffect(()=>()=>{++generation.current},[])
  const current=state.identity===identity?state:{identity,slug,box:state.slug===slug?state.box:empty(),loading:active&&visible,error:null}
  return {...current,loadMore,retry:()=>retry(v=>v+1)}
}

/** Used tags have their own cursor and search, independent of selected mail filters. */
export function useMailTagChoices(slug:string,base:InboxPayload|null|undefined,query:string,visible:boolean,refresh:unknown=0){
  const identity=JSON.stringify([slug,mailTagKey(query)])
  const revision=JSON.stringify([base?.mail_revision,base?.pending.map(m=>m.id),base?.delivered.map(m=>m.id)])
  const generation=useRef(0),busy=useRef(false)
  const [retryKey,setRetry]=useState(0)
  const [state,setState]=useState({identity,labels:[] as string[],cursor:null as string|null,loading:false,error:null as string|null})
  const read=useCallback(async(after:string|undefined,request:number,append:boolean)=>{
    busy.current=true
    setState(old=>({...old,loading:true,error:null}))
    try{
      let cursor=after,labels:string[]=[]
      do{
        const page=await getMailTagChoices(slug,query,cursor)
        if(generation.current!==request)return
        labels.push(...(page.tag_choices??[]));cursor=page.next_tag_cursor??undefined
        // Searching a page with no matches must not strand matches on later pages.
      }while(query.trim()&&labels.length===0&&cursor)
      if(generation.current===request)setState(old=>({identity,labels:[...new Map([...(append&&old.identity===identity?old.labels:[]),...labels].map(t=>[mailTagKey(t),t])).values()],cursor:cursor??null,loading:false,error:null}))
    }catch(e){if(generation.current===request)setState(old=>({...old,loading:false,error:(e as Error).message}))}
    finally{if(generation.current===request)busy.current=false}
  },[slug,query,identity])
  useEffect(()=>{
    const request=++generation.current;busy.current=false
    if(!visible||!base)return
    setState(old=>old.identity===identity?old:{identity,labels:[],cursor:null,loading:false,error:null})
    void read(undefined,request,false)
    return ()=>{++generation.current;busy.current=false}
  },[slug,identity,visible,revision,refresh,retryKey])
  const current=state.identity===identity?state:{identity,labels:[],cursor:null,loading:true,error:null}
  const loadMore=()=>{if(visible&&current.cursor&&!busy.current)void read(current.cursor,generation.current,true)}
  return {...current,loadMore,retry:()=>setRetry(v=>v+1)}
}
