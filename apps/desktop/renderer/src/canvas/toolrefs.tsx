import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { getWorkReferences } from '../api'
import type { WorkLinkFn } from './shared'
import { useAgentDirectory } from './identity'
import { WatchdogLink } from './watchdoglink'
import type { ToolChip } from '../types'
import { WorkStatusTransition, ticketFlare } from './docketstatus'
import { RefChip, refToken } from './reflinks'
import type { ResolvedRef } from './reflinks'
import { liveRevision, onLiveBump } from '../livebus'
import type { WorkReference } from '../workreferences'
import { useOrgRecordCursor } from '../recordsession'
import { HubContactChip } from './agentmentions'
import { ModelChange } from './modelchange'

/** A docket ticket the call names: the SAME LINK an inline mention is (USER
 *  2026-10-27 m0baa7d0b5a61 "also change these links to look identical to how
 *  they render inline in a chat", mffa2a51ed1b1 "just use the same link there
 *  as when rendering a mention"): `RefChip` itself, with the item's current
 *  full title (m3eb804e5023a) and its status flare, the shared ticket hover and
 *  menu; the slug until the read answers. The slug is looked up first; one that
 *  does not exist (typo, deleted) stays plain text, like an unknown agent name
 *  gets no link. This row's own live read (record cursor and live bumps) keeps
 *  the title and status current. */
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
  const row = current?.row
  const title = row?.title?.trim() ? row.title : undefined
  const flare = ticketFlare(row)
  const ref = { kind: 'item' as const, org, id }
  const resolved: ResolvedRef = { ref, token: refToken(ref), outcome: 'ready', label: title ?? id,
    ...(title ? { copyTitle: title } : {}), ...(flare ? { flare } : {}), why: `open the docket item ${id}` }
  return <RefChip r={resolved} onOpen={() => onOpen({ slug: id } as Parameters<WorkLinkFn>[0])} />
}

/** The links drawn beside an orgtree tool call: one per agent it names, and a
 *  card for the watchdog it creates or manages. Clicking inside never folds
 *  the call (the header row is the fold's own button). An agent that is not in
 *  the directory (a typo, a name that never existed) gets no link, and a
 *  watchdog that has since fired or been removed shows the shared gone chip
 *  with "(no longer exists)" and its stale copy menu, matching event cards. */
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
      return <WatchdogLink key={'w'+handle} id={handle} owner={owner} name={r.id} org={org} countdown />
    })}
  </span>
}
