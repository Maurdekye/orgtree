// The user mailbox panel's icon, wherever a control opens that panel: a chat
// bubble, or the mail icon while the classic mailbox is chosen (USER
// 2026-11-22 m200806e4af28: "the icon should change to a chat bubble instead
// of a mail icon … a header checkbox to return the old ui (which restores the
// mail icon)"). An agent's own mailbox keeps the mail icon everywhere.
import { ChatBubbleIcon, MailIcon } from '../icons'
import { useClassicMailbox } from '../mailboxpref'

export function MailboxIcon() {
  return useClassicMailbox()
    ? <MailIcon fontSize="inherit" />
    : <ChatBubbleIcon fontSize="inherit" />
}
