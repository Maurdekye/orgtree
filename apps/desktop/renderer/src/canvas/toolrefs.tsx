import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { getWorkReferences } from '../api'
import { DocketIcon } from '../icons'
import type { WorkLinkFn } from './shared'
import { useAgentDirectory } from './identity'
import { WatchdogLink } from './watchdoglink'
import type { ToolChip } from '../types'
import { objectNavProps } from './objectnav'
import { WorkStatusTransition } from './docketstatus'
import { liveRevision, onLiveBump } from '../livebus'
import type { WorkReference } from '../workreferences'
import { useOrgRecordCursor } from '../recordsession'
import { HubContactChip } from './agentmentions'
import { ModelChange } from './modelchange'

/** A docket ticket the call names: a chip that opens it in the docket. The slug
 *  is looked up first; one that does not exist (typo, deleted) stays plain
 *  text, like an unknown agent name gets no link. */
function TicketRef({ org, id, onOpen }: { org: string; id: string; onOpen?: WorkLinkFn }) {
  const cursor = useOrgRecordCursor(org)
  const key = JSON.stringify([org, id])
  const [settled, setSettled] = useState<{ key: string; row: WorkReference | null } | null>(null)
  useEffect(() => {
    let live = true
    let request = 0
    const refresh = () => {
      const current = ++request
      getWorkReferences(org, JSON.stringify([cursor, liveRevision()]), [id])
        .then(rows => { if (live && current === request) setSettled({ key, row: rows.get(id) ?? null }) })
        .catch(() => { if (live && current === request) setSettled(null) })
    }
    refresh()
    const off = onLiveBump(refresh)
    return () => { live = false; off() }
  }, [org, id, cursor])
  const current = settled?.key === key ? settled : null
  if (current?.row === null || !onOpen) return <span className="tool-ticket-plain dim">{id}</span>
  const status = current?.row?.status
  return (
    <button type="button" {...objectNavProps('ticket', id, org)} className={`desk-nav-chip tool-ticket${status ? ` status-${status}` : ''}`}
      title={current?.row?.title} aria-label={`ticket ${id}`}
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
export function ToolRefs({ refs, owner, agent, org, onWorkLink, modelChanges = false }: {
  refs: NonNullable<ToolChip['refs']>; owner: string; agent: (id: string) => ReactNode
  org: string; onWorkLink?: WorkLinkFn; modelChanges?: boolean
}) {
  const dir = useAgentDirectory()
  return <span className="tool-refs" onClick={(e) => e.stopPropagation()}>
    {refs.map((r, i) => {
      if (r.kind === 'agent') {
        const current = dir?.resolve(r.id)
        const change = modelChanges ? r.model_change : undefined
        if (!current && !change) return null
        return <span key={'a' + r.id + i} className="tool-ref tool-ref-agent">
          <ModelChange change={change} currentTier={current?.tier}>
            {current ? agent(r.id) : <span className="dim">{r.id}</span>}
          </ModelChange>
        </span>
      }
      if (r.kind === 'ticket') return <span key={'t' + r.id + i} className="tool-ref">
        <TicketRef org={org} id={r.id} onOpen={onWorkLink} /><WorkStatusTransition change={r.status_change} />
      </span>
      if ((r.kind as string) === 'hub') return <span key={'h' + r.id + i} className="tool-ref">
        <HubContactChip address={r.id} />
      </span>
      // `owner/uid` names a team member's dog; a bare id is this agent's own
      const handle = r.id.includes('/') ? r.id : `${owner}/${r.id}`
      return <WatchdogLink key={'w'+handle} id={handle} name={r.id} org={org}/>
    })}
  </span>
}
