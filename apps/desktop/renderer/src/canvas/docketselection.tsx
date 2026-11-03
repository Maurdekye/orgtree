import { createContext, useContext } from 'react'
import type { ReactNode } from 'react'
import { ReplySelectionSurface } from './replyselection'

export const DocketSelectionContext=createContext<{org:string;slug:string}|null>(null)
export function DocketSelection({field,text,entry,format='plain',children}:{field:string;text:string;entry?:number;format?:'plain'|'markdown';children:ReactNode}){
  const item=useContext(DocketSelectionContext)
  // data-docket-field/-entry name the text for attract mode, which scrolls a changed ticket to it (attract/ticketdom.ts)
  const marked=<span data-docket-field={field} data-docket-entry={entry} style={{display:'contents'}}>{children}</span>
  return item ? <ReplySelectionSurface source={{org:item.org,target:{kind:'work_item',...item},
    part:{part:`work_item.${field}`,...(entry===undefined?{}:{entry})},text,format}}>{marked}</ReplySelectionSurface> : marked
}
