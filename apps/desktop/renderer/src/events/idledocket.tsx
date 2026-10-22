import type { ReactNode } from 'react'
import type { Event } from '../generated/events'
import { DocketIcon } from '../icons'
import { objectNavProps } from '../canvas/objectnav'
import { resolveRef } from '../canvas/reflinks'
import type { RefWorld, ResolvedRef } from '../canvas/reflinks'
import { knownStatus, statusLabel } from '../canvas/docketstatus'

type IdleDocket = Extract<Event, { variant: 'reminder.idle_docket' }>
type IdleItem = IdleDocket['items'][number]

/** What the engine's reminder text says about the agent's part in the item;
 *  `owner` is the ordinary case and says nothing. */
const ROLE_NOTE: Record<IdleItem['role'], string> = {
  owner: '',
  deployer: 'awaiting your deployment or publication',
  reviewer: 'awaiting your review',
  unassigned_review: 'no reviewer named: assign one, do not review your own work',
  stale_reviewer: 'its reviewer is no longer live: name another',
}

/** The idle-docket reminder's items as ticket cards. Each is the ticket link
 *  every other surface draws (the same `data-object-*` attributes, so the
 *  one ticket context menu and the hover title come with it), plus the
 *  status and role the reminder recorded. Built from the typed event, never
 *  from the reminder's text; the text the agent reads is unchanged. */
export function IdleDocketCards({ event, org, world, onOpen }: {
  event: IdleDocket; org: string; world?: RefWorld | null; onOpen?: (r: ResolvedRef) => void
}): ReactNode {
  return <>
    <ul className="idle-items">{event.items.map(item => {
      const resolved = resolveRef({ kind: 'item', org, id: item.slug }, world ?? { org })
      const status = knownStatus(item.status) ? item.status : null
      const note = ROLE_NOTE[item.role]
      const label = <><DocketIcon fontSize="inherit" />{item.slug}</>
      return <li key={item.slug} className={'idle-ticket' + (status ? ' status-' + status : '')} data-idle-item={item.slug}>
        {resolved.outcome === 'ready' && onOpen && !resolved.atDestination
          ? <button type="button" {...objectNavProps('ticket', item.slug, org)} data-copy-ticket-title={item.title}
              className="desk-nav-chip idle-ticket-link" title={item.title}
              onMouseDown={e => { if (e.button !== 0) e.stopPropagation() }}
              onClick={e => { e.stopPropagation(); onOpen({ ...resolved, copyTitle: item.title }) }}>{label}</button>
          : <span className="desk-nav-chip dim idle-ticket-link" data-copy-ticket-title={item.title} title={item.title}>{label}</span>}
        <span className="idle-ticket-title">{item.title}</span>
        <span className={'docket-status idle-ticket-status' + (status ? ' status-' + status : '')}>{statusLabel(item.status)}</span>
        {note && <span className="idle-ticket-role dim">{note}</span>}
      </li>
    })}</ul>
    {event.more > 0 && <div className="idle-more dim">…and {event.more} more waiting on you; orgtree_work list shows them all</div>}
  </>
}
