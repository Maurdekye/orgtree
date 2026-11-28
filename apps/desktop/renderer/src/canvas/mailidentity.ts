import { objectNavProps } from './objectnav'
import { objectTooltipProps } from './objecttooltip'
import type { MenuEntry, MenuItem } from './contextmenu'
import { VIEW_IN_CHAT, VIEW_IN_CLASSIC } from '../mailboxpref'
import { isMailboxViewLabel, isTranscriptViewLabel } from './mailboxviews'

export type MailIdentity = { org: string; id: string; box: 'user' | 'org' | 'node'; node?: string }
export function mailIdentityAt(anchor: Element, org: string, id: string): MailIdentity | null {
  const box = anchor.getAttribute('data-mail-box'), node = anchor.getAttribute('data-mail-node') || undefined
  return (box === 'user' || box === 'org' || box === 'node' && node) && id !== '@user'
    ? { org, id, box, node } : null
}
export function mailTooltipProps(ref: MailIdentity, actionLabel?: string) {
  return { ...objectTooltipProps('mail', ref.id, ref.org), 'data-mail-box': ref.box, 'data-mail-node': ref.node,
    'data-mail-action-label': actionLabel }
}
export function mailLinkProps(ref: MailIdentity, actionLabel?: string): Record<string, string | undefined> {
  return ref.id === '@user' ? {} : { ...objectNavProps('mail', ref.id, ref.org), ...mailTooltipProps(ref, actionLabel) }
}
export function mailTargetIdentity(org: string, mail: { id: string; to: string }): MailIdentity {
  return { org, id: mail.id, box: mail.to === 'user_inbox' ? 'user' : mail.to.startsWith('@') ? 'org' : 'node',
    node: !mail.to.startsWith('@') && mail.to !== 'user_inbox' ? mail.to : undefined }
}
/** Contextual capabilities belong before the identical copy block. A row can
 * close/read/retract; a reference has only its actual Open route. */
/** THE VIEW IN GROUP (USER 2026-11-25 21:38:09Z md7da554ce837 "on message context menus group the 'view in"
 *  items together"): every message menu (chats bubbles, mail rows, mail links) shows its "View in …" entries
 *  as one separated section, in this order, then any other "View in …" in the order given. */
export const VIEW_IN_ORDER: readonly string[] = [VIEW_IN_CHAT, VIEW_IN_CLASSIC, 'View in transcript']
const isViewIn = (e: MenuEntry): e is MenuItem => e !== 'sep' && e.label.startsWith('View in ')
// the mail's agent and org mailboxes come right after the classic inbox, its agents' transcripts in the transcript's
// place (mailboxviews.ts)
const viewRank = (e: MenuItem) => {
  if (isMailboxViewLabel(e.label)) return VIEW_IN_ORDER.indexOf(VIEW_IN_CLASSIC) + 0.5
  const i = VIEW_IN_ORDER.indexOf(isTranscriptViewLabel(e.label) ? 'View in transcript' : e.label)
  return i < 0 ? VIEW_IN_ORDER.length : i
}
export function mailMenuEntries(actions: { leading: MenuEntry[]; copy: () => void; canCopy: boolean;
  reference?: string | null; copyReference?: () => void }): MenuEntry[] {
  const own = actions.leading.filter(e => !isViewIn(e))
  // a stable sort: entries outside VIEW_IN_ORDER keep the order their surface gave them
  const views = actions.leading.filter(isViewIn).sort((a, b) => viewRank(a) - viewRank(b))
  return [...own, ...(own.length ? ['sep' as const] : []), ...views, ...(views.length ? ['sep' as const] : []),
    { label: 'Copy message text', disabled: !actions.canCopy, onSelect: actions.copy },
    ...(actions.reference && actions.copyReference ? [{ label: 'Copy reference', title: actions.reference, onSelect: actions.copyReference }] : [])]
}
