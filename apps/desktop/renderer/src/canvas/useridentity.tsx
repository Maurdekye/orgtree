import { agentLinkMenuEntries, useContextMenu } from './contextmenu'
import type { MenuEntry } from './contextmenu'
import type { ToastFn } from '../types'

export const USER_IDENTITY_TITLE = "open the user's inbox"
export function userMenuEntries(anchor: Element, open?: () => void, toast?: ToastFn): MenuEntry[] {
  return agentLinkMenuEntries(anchor, '@user', open ? [{ label: 'Open inbox', onSelect: open }] : [], toast)
}
/** The user is an inbox identity, never an agent or a message lookup. */
export function UserIdentityLink({ className, open }: { className: string; open?: () => void }) {
  const menu = useContextMenu()
  const Tag = open ? 'button' : 'span'
  return <><Tag className={className} title={USER_IDENTITY_TITLE} {...(open ? { type: 'button' as const } : {})}
    onMouseDown={e => { if (e.button !== 0) e.stopPropagation() }}
    onClick={open ? e => { e.stopPropagation(); open() } : undefined}
    onContextMenu={e => menu.open(e, userMenuEntries(e.currentTarget, open))}>@user</Tag>{menu.node}</>
}
