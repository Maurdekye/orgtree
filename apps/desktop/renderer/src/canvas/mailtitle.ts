import { fmtFull } from '../timefmt'

export function mailTitle(mail: { from?: unknown; at?: unknown; id?: unknown }, actionLabel?: string | null): string {
  const identity = [mail.from, typeof mail.at === 'string' ? fmtFull(mail.at) : '', mail.id].filter(v => typeof v === 'string' && v).join(' · ')
  return actionLabel ? `${actionLabel}\n${identity}` : identity
}
