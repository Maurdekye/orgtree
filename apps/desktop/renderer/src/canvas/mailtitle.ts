import { fmtFull } from '../timefmt'

export function mailTitle(mail: { from?: unknown; at?: unknown; id?: unknown }): string {
  return [mail.from, typeof mail.at === 'string' ? fmtFull(mail.at) : '', mail.id].filter(v => typeof v === 'string' && v).join(' · ')
}
