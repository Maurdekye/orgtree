import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { getWorkReferences } from '../api'
import { DocketIcon } from '../icons'
import type { WorkLinkFn } from './shared'
import { useAgentDirectory } from './identity'
import { DogChip, useDogRoute } from './deskdogs'
import type { ToolChip } from '../types'
import { objectNavProps } from './objectnav'
import { WorkStatusTransition } from './docketstatus'

/** A docket ticket the call names: a chip that opens it in the docket. The slug
 *  is looked up first; one that does not exist (typo, deleted) stays plain
 *  text, like an unknown agent name gets no link. */
function TicketRef({ org, id, onOpen }: { org: string; id: string; onOpen?: WorkLinkFn }) {
  const [known, setKnown] = useState<boolean | null>(null)
  useEffect(() => {
    let live = true
    getWorkReferences(org, '', [id]).then(rows => { if (live) setKnown(!!rows.get(id)) })
      .catch(() => { if (live) setKnown(null) })
    return () => { live = false }
  }, [org, id])
  if (known === false || !onOpen) return <span className="tool-ticket-plain dim">{id}</span>
  return (
    <button type="button" {...objectNavProps('ticket', id, org)} className="desk-nav-chip tool-ticket"
      title={`open ${id} in the work docket`} aria-label={`ticket ${id}`}
      onClick={() => onOpen({ slug: id } as Parameters<WorkLinkFn>[0])}>
      <DocketIcon fontSize="inherit" />{id}
    </button>
  )
}

/** The links drawn beside an orgtree tool call: one per agent it names, and a
 *  card for the watchdog it creates or manages. Clicking inside never folds
 *  the call (the header row is the fold's own button). An agent that is not in
 *  the directory (a typo, a name that never existed) gets no link, and a
 *  watchdog that has since fired or been removed keeps a muted card that opens
 *  nothing — the cheaper of the two options the ticket allowed. */
export function ToolRefs({ refs, owner, agent, org, onWorkLink }: {
  refs: NonNullable<ToolChip['refs']>; owner: string; agent: (id: string) => ReactNode
  org: string; onWorkLink?: WorkLinkFn
}) {
  const dir = useAgentDirectory()
  const route = useDogRoute()
  return <span className="tool-refs" onClick={(e) => e.stopPropagation()}>
    {refs.map((r, i) => {
      if (r.kind === 'agent') return dir?.resolve(r.id)
        ? <span key={'a' + r.id + i} className="tool-ref tool-ref-agent">{agent(r.id)}</span> : null
      if (r.kind === 'ticket') return <span key={'t' + r.id + i} className="tool-ref">
        <TicketRef org={org} id={r.id} onOpen={onWorkLink} /><WorkStatusTransition change={r.status_change} />
      </span>
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
