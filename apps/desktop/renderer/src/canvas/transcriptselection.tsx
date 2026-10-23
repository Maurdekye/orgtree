import { createContext, useContext, useLayoutEffect } from 'react'
import type { ReactNode } from 'react'
import { useSurfaceDocument } from '../popout'
import { listenSelectionReveal } from './selectionlocation'
import { ReplySelectionSurface } from './replyselection'
import type { SourcePart } from '../replySelection'

export const TranscriptSelectionContext = createContext<{ org: string; agent: string; generation: number } | null>(null)

/** Only retained event identities are eligible. The server separately refuses
 * the entire active turn, even if an individual block already looks finished. */
export function TranscriptSelection({ org, agent, eventId, part, text, children, format = 'markdown', offset = 0, shown }: {
  org: string; agent: string; eventId?: string; part: SourcePart; text: string; children: ReactNode;
  format?: 'markdown' | 'plain'; offset?: number; shown?: string
}) {
  const desk = useContext(TranscriptSelectionContext)
  if (!desk || desk.org !== org || desk.agent !== agent || !/^e[1-9]\d*$/.test(eventId ?? '')) return children
  return <ReplySelectionSurface source={{ org, target: { source_event_ref: { ...desk, eventId: eventId! } },
    part, text, format, offset, shown }}>{children}</ReplySelectionSurface>
}

export function useTranscriptSelectionReveal(org:string,agent:string,eventId:string|undefined,tool:string|null|undefined,open:boolean,reveal:()=>void){
  const desk=useContext(TranscriptSelectionContext),doc=useSurfaceDocument()
  useLayoutEffect(()=>!open&&tool&&eventId&&desk?.org===org&&desk.agent===agent
    ?listenSelectionReveal(doc,{source_event_ref:{...desk,eventId}},tool,reveal):undefined,[doc,desk,org,agent,eventId,tool,open,reveal])
}
