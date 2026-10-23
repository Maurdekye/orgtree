import { verifySelectionProjection } from './selectionprojection'
import type { SourceIdentity, SourcePart } from '../replySelection'
import type { SelectionSource } from './replyselection'
import { sourceDomRange } from './selectionmap'

const eventName='orgtree-selection-location'
type Location={key:string;target:SourceIdentity;part:SourcePart;hash:string;start:number;end:number;at:number}
const pending=new WeakMap<Document,Location>()
function key(target:SourceIdentity,part:SourcePart) {
  const identity=typeof target==='string'?['mail',target]:'source_event_ref'in target
    ? ['event',target.source_event_ref.org,target.source_event_ref.agent,target.source_event_ref.generation,target.source_event_ref.eventId,target.mail_id??'']
    : [target.kind==='presentation'?'document':target.kind,target.org,'slug'in target?target.slug:target.id]
  return JSON.stringify([identity,part.part,part.tool_id??'',part.pointer??'',part.role??'value',part.entry??null])
}
export function requestSelectionLocation(doc:Document,target:SourceIdentity,part:SourcePart,hash:string,start:number,end:number) {
  pending.set(doc,{key:key(target,part),target,part,hash,start,end,at:Date.now()})
  doc.dispatchEvent(new (doc.defaultView?.Event??Event)(eventName))
}
export function listenSelectionLocation(root:HTMLElement,source:SelectionSource) {
  const doc=root.ownerDocument;let active=true
  const locate=()=>{
    const wanted=pending.get(doc)
    if(!wanted||Date.now()-wanted.at>15000||wanted.key!==key(source.target,source.part))return
    const offset=source.offset??0,shown=source.shown??source.text
    if(wanted.start<offset||wanted.end>offset+[...shown].length)return
    void verifySelectionProjection(source,wanted.hash).then(()=>{
      if(!active||!root.isConnected||pending.get(doc)!==wanted)return
      let revealed=false
      for(let owner:Element|null=root;owner&&owner!==doc.body;owner=owner.parentElement){
        const selector=owner.matches('.docket-detail-section-body[hidden]') ? '.docket-detail-toggle[aria-expanded="false"]'
          : owner.matches('.docket-desc-fold.folded') ? '.docket-desc-toggle[aria-expanded="false"]'
          : owner.matches('.turn-mail-preview.folded') ? '.turn-mail-toggle[aria-expanded="false"]' : null
        if(selector){const button=(owner.matches('.docket-detail-section-body')?owner.parentElement:owner)?.querySelector<HTMLButtonElement>(selector);if(button){button.click();revealed=true}}
        if(owner instanceof doc.defaultView!.HTMLDetailsElement&&!owner.open){owner.open=true;revealed=true}
      }
      if(revealed){doc.defaultView?.requestAnimationFrame(locate);return}
      const range=sourceDomRange(root,shown,wanted.start-offset,wanted.end-offset,source.format)
      if(!range){
        const thought=root.querySelector<HTMLButtonElement>('.thoughtline[title="read the thought process"]')
        if(thought){thought.click();doc.defaultView?.requestAnimationFrame(locate)}
        return
      }
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
    }).catch(()=>{/* The retained quote stays readable when the projection changed. */})
  }
  doc.addEventListener(eventName,locate);locate()
  return()=>{active=false;doc.removeEventListener(eventName,locate)}
}

/** A folded tool has no input DOM until opened. Reveal its retained call by
 * exact event/tool identity, then the mounted part performs digest validation. */
export function listenSelectionReveal(doc:Document,target:SourceIdentity,tool:string,reveal:()=>void) {
  const check=()=>{const wanted=pending.get(doc);if(!wanted||Date.now()-wanted.at>15000||wanted.part.tool_id!==tool)return
    if(key(wanted.target,{part:wanted.part.part})===key(target,{part:wanted.part.part}))reveal()}
  doc.addEventListener(eventName,check);check();return()=>doc.removeEventListener(eventName,check)
}
