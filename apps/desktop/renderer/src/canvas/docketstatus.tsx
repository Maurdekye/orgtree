// Shared wording and existing .docket-status colours for docket and transcript.
import type { RefFlare } from './refnames'

const STATUS_LABEL: Record<string, string> = {
  backlogged: 'Backlogged',
  open: 'Open',
  in_progress: 'In progress',
  blocked: 'Blocked',
  review: 'Agent review',
  approved: 'Approved — not landed',
  deploy_ready: 'Deploy Ready',
  done: 'Done',
  superseded: 'Superseded',
  dropped: 'Dropped',
}

export const statusLabel = (status: string): string => STATUS_LABEL[status] ?? status
export const knownStatus = (status: unknown): status is string =>
  typeof status === 'string' && Object.prototype.hasOwnProperty.call(STATUS_LABEL, status)

/** A ticket link's status flare (USER 2026-10-27 m43beb8089dd4 "add a flare with
 *  the ticket's status as a color, similar to ticket links"): the docket's
 *  colour class and its wording, the hover's own (`Archived` for an archived
 *  item, as objecttooltip says). None for a status this renderer does not
 *  know: it is never invented. */
export function ticketFlare(row: { status?: unknown; archived?: unknown } | null | undefined): RefFlare | undefined {
  if (!row || !knownStatus(row.status)) return undefined
  return { cls: 'status-' + row.status, tip: row.archived === true ? 'Archived' : statusLabel(row.status) }
}

/** Missing historical before-states show nothing. The engine recorded these
 *  two states at mutation time; never read today's ticket to infer either. */
export function WorkStatusTransition({ change }: { change?: { from: string; to: string } }) {
  if (!change || !knownStatus(change.from) || !knownStatus(change.to) || change.from === change.to) return null
  const from = statusLabel(change.from), to = statusLabel(change.to)
  return <span className="tool-work-transition" aria-label={`Ticket status changed: ${from} → ${to}`}>
    <span className={`docket-status status-${change.from}`}>{from}</span>
    <span className="dim" aria-hidden="true"> → </span>
    <span className={`docket-status status-${change.to}`}>{to}</span>
  </span>
}
