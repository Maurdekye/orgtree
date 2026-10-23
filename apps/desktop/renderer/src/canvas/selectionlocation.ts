import { sourceDigest } from '../replySelection'
import type { SourceIdentity, SourcePart } from '../replySelection'
import type { SelectionSource } from './replyselection'
import { sourceDomRange } from './selectionmap'

const eventName='orgtree-selection-location'
type Location={key:string;hash:string;start:number;end:number;at:number}
const pending=new WeakMap<Document,Location>()
function key(target:SourceIdentity,part:SourcePart) {
  const identity=typeof target==='string'?['mail',target]:'source_event_ref'in target
    ? ['event',target.source_event_ref.org,target.source_event_ref.agent,target.source_event_ref.generation,target.source_event_ref.eventId,target.mail_id??'']
    : [target.kind==='presentation'?'document':target.kind,target.org,'slug'in target?target.slug:target.id]
  return JSON.stringify([identity,part.part,part.tool_id??'',part.pointer??'',part.role??'value',part.entry??null])
}
export function requestSelectionLocation(doc:Document,target:SourceIdentity,part:SourcePart,hash:string,start:number,end:number) {
  pending.set(doc,{key:key(target,part),hash,start,end,at:Date.now()})
  doc.dispatchEvent(new (doc.defaultView?.Event??Event)(eventName))
}
export function listenSelectionLocation(root:HTMLElement,source:SelectionSource) {
  const doc=root.ownerDocument;let active=true
  const locate=()=>{
    const wanted=pending.get(doc)
    if(!wanted||Date.now()-wanted.at>15000||wanted.key!==key(source.target,source.part))return
    const offset=source.offset??0,shown=source.shown??source.text
    if(wanted.start<offset||wanted.end>offset+[...shown].length)return
    void sourceDigest(source.text).then(hash=>{
      if(!active||!root.isConnected||pending.get(doc)!==wanted||hash!==wanted.hash)return
      const range=sourceDomRange(root,shown,wanted.start-offset,wanted.end-offset,source.format)
      if(!range)return
      pending.delete(doc)
      const selection=doc.getSelection();selection?.removeAllRanges();selection?.addRange(range)
      // Scroll only the nearest owning overflow surface, never the canvas or
      // every ancestor as scrollIntoView would. Fold/paging remains the caller's route.
      if(typeof range.getBoundingClientRect!=='function')return
      const box=range.getBoundingClientRect()
      for(let owner=root.parentElement;owner&&owner!==doc.body;owner=owner.parentElement){
        if(!/(auto|scroll)/.test(doc.defaultView!.getComputedStyle(owner).overflowY))continue
        const view=owner.getBoundingClientRect();owner.scrollTop+=box.top-view.top-owner.clientHeight/2+box.height/2;break
      }
    })
  }
  doc.addEventListener(eventName,locate);locate()
  return()=>{active=false;doc.removeEventListener(eventName,locate)}
}
