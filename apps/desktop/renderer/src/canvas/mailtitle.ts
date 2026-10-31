import { fmtFull } from '../timefmt'

/** `state` (an unread message's "Unread") leads the hover, the way a ticket's status or an unread presentation's word does. */
export function mailTitle(mail: { from?: unknown; at?: unknown; id?: unknown }, actionLabel?: string | null, state?: string | null): string {
  const identity = [state, mail.from, typeof mail.at === 'string' ? fmtFull(mail.at) : '', mail.id].filter(v => typeof v === 'string' && v).join(' · ')
  return actionLabel ? `${actionLabel}\n${identity}` : identity
}
