import { ConfirmModal } from './modals'

/** Dropping a node on the org mailbox while only ONE holder is allowed would replace the current
 *  holder (spec rev 2 §4.2, USER 2026-11-03 mdf5da6c51202): ask first, for agents and projects alike.
 *  An engine with weak links (USER 2026-11-24 m020bbd1926c3) also offers an agent a WEAK link: it sends as the org
 *  and the holder keeps the arriving mail. `multi`: several holders allowed, so the choice is holder or weak link.
 *  `onWeak` is absent for a project, for an agent that already holds one, and on an older engine. */
export function InboxReplaceConfirm({ id, current, multi = false, onConfirm, onWeak, close }: {
  id: string; current: string; multi?: boolean; onConfirm: () => void; onWeak?: () => void; close: () => void
}) {
  const weak = onWeak ? ` Or give ${id} a weak link: it may send mail as the org, and new outside mail still goes to ${current}.` : ''
  if (multi) {
    return <ConfirmModal title={`Add ${id} to the org mailbox?`}
      body={`As a holder, ${id} reads and answers outside mail beside ${current}.${weak}`}
      confirmLabel="Add as holder" onConfirm={onConfirm} altLabel={onWeak ? 'Add a weak link' : undefined} onAlt={onWeak}
      close={close} />
  }
  return <ConfirmModal title={`Replace ${current} as the org mailbox's holder with ${id}?`}
    body={`Only one holder is allowed, so granting the org mailbox to this node revokes the current holder. Turn on multiple org-mailbox holders in the org's settings to keep both.${weak}`}
    confirmLabel="Replace" onConfirm={onConfirm} altLabel={onWeak ? 'Add a weak link' : undefined} onAlt={onWeak}
    close={close} />
}
