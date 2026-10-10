import type { ReactNode } from 'react'
import { useAgentDirectory } from './identity'
import { DogChip, useDogRoute } from './deskdogs'
import type { ToolChip } from '../types'

/** The links drawn beside an orgtree tool call: one per agent it names, and a
 *  card for the watchdog it creates or manages. Clicking inside never folds
 *  the call (the header row is the fold's own button). An agent that is not in
 *  the directory (a typo, a name that never existed) gets no link, and a
 *  watchdog that has since fired or been removed keeps a muted card that opens
 *  nothing — the cheaper of the two options the ticket allowed. */
export function ToolRefs({ refs, owner, agent }: {
  refs: NonNullable<ToolChip['refs']>; owner: string; agent: (id: string) => ReactNode
}) {
  const dir = useAgentDirectory()
  const route = useDogRoute()
  return <span className="tool-refs" onClick={(e) => e.stopPropagation()}>
    {refs.map((r, i) => {
      if (r.kind === 'agent') return dir?.resolve(r.id)
        ? <span key={'a' + r.id + i} className="tool-ref tool-ref-agent">{agent(r.id)}</span> : null
      // `owner/uid` names a team member's dog; a bare id is this agent's own
      const handle = r.id.includes('/') ? r.id : `${owner}/${r.id}`
      const dog = route?.dogs.find(w => w.id === handle && !w.spent)
      return dog
        ? <DogChip key={'w' + handle} dog={dog} onOpen={route!.open} />
        : <span key={'w' + handle} className="desk-nav-chip desk-dog-chip gone" role="note"
            title={`watchdog "${r.id}" is gone (fired or removed)`}>
            <span className="wd-glyph" aria-hidden="true">✕</span>{r.id}
          </span>
    })}
  </span>
}
