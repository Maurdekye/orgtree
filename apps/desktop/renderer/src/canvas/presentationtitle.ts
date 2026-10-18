import { useEffect,useState } from 'react'
import { getDocument } from '../api'
import type { RefWorld } from './reflinks'

// Only coalesce concurrent reads. Do not retain titles after permissions or
// document lifetime can change, and never fetch the gallery's growing prefix.
const reading=new Map<string,Promise<string|null>>()
function readTitle(org:string,id:string,key:string):Promise<string|null>{
  let request=reading.get(key)
  if(!request){
    request=getDocument(org,id).then(doc=>typeof doc.title==='string'&&doc.title.trim()?doc.title:null).catch(()=>null)
    reading.set(key,request)
    void request.then(()=>{if(reading.get(key)===request)reading.delete(key)})
  }
  return request
}

/** A reply names an exact document; its quote text is never its title. */
export function usePresentationTitle(org:string,id?:string,world?:RefWorld|null,recordedTitle=''){
  const key=JSON.stringify([org,id]),foreign=!!world&&world.org!==org
  const removed=!!id&&!!world?.docs&&world.docs!=='loading'&&!world.docs.has(id)
  const indexed=!foreign&&id&&world?.docs&&world.docs!=='loading'?world.docs.get(id):undefined
  const pending=world?.docs==='loading'
  const [answer,setAnswer]=useState<{key:string;title:string|null}|null>(null)
  useEffect(()=>{
    if(!id||foreign||removed||pending||indexed?.trim())return
    let live=true
    void readTitle(org,id,key).then(title=>{if(live)setAnswer({key,title})})
    return()=>{live=false}
  },[org,id,key,foreign,removed,pending,indexed])
  if(!id||foreign)return {label:'presentation unavailable',ready:false,why:'Presentation unavailable here; quoted context is retained.'}
  if(removed)return {label:'presentation removed',ready:false,why:'Presentation removed; quoted context is retained.'}
  if(pending)return {label:recordedTitle||'loading presentation…',ready:false,why:'Loading presentation title'}
  const title=indexed?.trim()?indexed:answer?.key===key?answer.title:undefined
  if(title)return {label:title,ready:true,why:`Open presentation: ${title}`}
  if(title===null)return {label:'presentation unavailable',ready:false,why:'Presentation unavailable; quoted context is retained.'}
  return {label:recordedTitle||'loading presentation…',ready:false,why:'Loading presentation title'}
}
