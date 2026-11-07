import { ConfirmModal } from './modals'

/** Dropping a node on the org mailbox while only ONE holder is allowed would replace the current
 *  holder (spec rev 2 §4.2, USER 2026-11-03 mdf5da6c51202): ask first, for agents and projects alike. */
export function InboxReplaceConfirm({ id, current, onConfirm, close }: {
  id: string; current: string; onConfirm: () => void; close: () => void
}) {
  return <ConfirmModal title={`Replace ${current} as the org mailbox's holder with ${id}?`}
    body="Only one holder is allowed, so granting the org mailbox to this node revokes the current holder. Turn on multiple org-mailbox holders in the org's settings to keep both."
    confirmLabel="Replace" onConfirm={onConfirm} close={close} />
}
