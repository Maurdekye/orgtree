import type { ReactNode } from 'react'
import type { Event } from '../generated/events'
import { RefChip, resolveRef } from '../canvas/reflinks'
import type { RefWorld, ResolvedRef } from '../canvas/reflinks'
import { knownStatus, statusLabel, ticketFlare } from '../canvas/docketstatus'

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

/** The idle-docket reminder's items as ticket cards. Each links its ticket
 *  with the SAME LINK an inline mention is (USER 2026-10-27 md478a732e0c0 "same
 *  for in the docket reminder message", after m0baa7d0b5a61 / mffa2a51ed1b1):
 *  `RefChip`, so the one ticket context menu, the hover, the current full title
 *  and the status flare come with it. Until the surface's name read answers,
 *  the chip shows the title and status the reminder recorded. The card adds the
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
      const flare = resolved.flare ?? ticketFlare(item)
      const named = resolved.copyTitle ?? (item.title || undefined)
      const r: ResolvedRef = resolved.outcome !== 'ready' ? resolved
        : { ...resolved, label: named ?? resolved.label, ...(named ? { copyTitle: named } : {}), ...(flare ? { flare } : {}) }
      return <li key={item.slug} className="idle-ticket" data-idle-item={item.slug}>
        <RefChip r={r} onOpen={onOpen} />
        <span className={'docket-status idle-ticket-status' + (status ? ' status-' + status : '')}>{statusLabel(item.status)}</span>
        {note && <span className="idle-ticket-role dim">{note}</span>}
      </li>
    })}</ul>
    {event.more > 0 && <div className="idle-more dim">…and {event.more} more waiting on you; orgtree_work list shows them all</div>}
  </>
}
