import { useEffect } from 'react'
import type { RefObject } from 'react'

/** Pointer distance is measured in this surface document's viewport, including
 * its portal. Keyboard activity and a nonempty search protect deliberate use. */
export function useTagPointerDismiss(open:boolean,query:string,doc:Document,
  control:RefObject<HTMLElement|null>,popover:RefObject<HTMLElement|null>,close:()=>void){
  useEffect(()=>{
    if(!open)return
    let timer:ReturnType<typeof setTimeout>|undefined,last:{x:number;y:number}|null=null
    const keys=new Set<string>()
    const cancel=()=>{if(timer!==undefined){clearTimeout(timer);timer=undefined}}
    const near=(el:HTMLElement|null)=>{
      if(!el||!last)return false
      const r=el.getBoundingClientRect()
      return last.x>=r.left-100&&last.x<=r.right+100&&last.y>=r.top-100&&last.y<=r.bottom+100
    }
    const reconsider=()=>{
      if(query.trim()||keys.size||!last||near(control.current)||near(popover.current)){cancel();return}
      if(timer===undefined)timer=setTimeout(()=>{timer=undefined;close()},250)
    }
    const pointer=(e:PointerEvent)=>{
      if(e.pointerType==='touch')return
      last={x:e.clientX,y:e.clientY};reconsider()
    }
    const down=(e:KeyboardEvent)=>{keys.add(e.code||e.key);cancel()}
    const up=(e:KeyboardEvent)=>{keys.delete(e.code||e.key);reconsider()}
    const blur=()=>{keys.clear();cancel();last=null}
    doc.addEventListener('pointermove',pointer,true);doc.addEventListener('keydown',down,true);doc.addEventListener('keyup',up,true)
    doc.defaultView?.addEventListener('blur',blur)
    return()=>{cancel();doc.removeEventListener('pointermove',pointer,true);doc.removeEventListener('keydown',down,true);doc.removeEventListener('keyup',up,true);doc.defaultView?.removeEventListener('blur',blur)}
  },[open,query,doc,control,popover,close])
}
