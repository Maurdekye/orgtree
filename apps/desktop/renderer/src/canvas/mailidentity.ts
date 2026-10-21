import { objectNavProps } from './objectnav'
import { objectTooltipProps } from './objecttooltip'
import type { MenuEntry } from './contextmenu'

export type MailIdentity = { org: string; id: string; box: 'user' | 'org' | 'node'; node?: string }
export function mailIdentityAt(anchor: Element, org: string, id: string): MailIdentity | null {
  const box = anchor.getAttribute('data-mail-box'), node = anchor.getAttribute('data-mail-node') || undefined
  return (box === 'user' || box === 'org' || box === 'node' && node) && id !== '@user'
    ? { org, id, box, node } : null
}
export function mailTooltipProps(ref: MailIdentity) {
  return { ...objectTooltipProps('mail', ref.id, ref.org), 'data-mail-box': ref.box, 'data-mail-node': ref.node }
}
export function mailLinkProps(ref: MailIdentity): Record<string, string | undefined> {
  return ref.id === '@user' ? {} : { ...objectNavProps('mail', ref.id, ref.org), ...mailTooltipProps(ref) }
}
export function mailTargetIdentity(org: string, mail: { id: string; to: string }): MailIdentity {
  return { org, id: mail.id, box: mail.to === 'user_inbox' ? 'user' : mail.to.startsWith('@') ? 'org' : 'node',
    node: !mail.to.startsWith('@') && mail.to !== 'user_inbox' ? mail.to : undefined }
}
/** Contextual capabilities belong before the identical copy block. A row can
 * close/read/retract; a reference has only its actual Open route. */
export function mailMenuEntries(actions: { leading: MenuEntry[]; copy: () => void; canCopy: boolean;
  reference?: string | null; copyReference?: () => void }): MenuEntry[] {
  return [...actions.leading, ...(actions.leading.length ? ['sep' as const] : []),
    { label: 'Copy message text', disabled: !actions.canCopy, onSelect: actions.copy },
    ...(actions.reference && actions.copyReference ? [{ label: 'Copy reference', title: actions.reference, onSelect: actions.copyReference }] : [])]
}
