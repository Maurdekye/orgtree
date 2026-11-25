// The switch between the user's chats and the classic mailbox, in the panel's
// title bar. It is the compact checkbox the Agents panel's bar has for
// "active" (`ActiveAgentsFilter`, canvas/agenttray.tsx): the same markup and
// class, so the two bars read alike. App settings > Display > Mailbox holds
// the same choice (canvas/accounts.tsx).
import {
  CLASSIC_MAILBOX_HINT, CLASSIC_MAILBOX_LABEL, setClassicMailbox, useClassicMailbox,
} from '../mailboxpref'

export function ClassicMailboxToggle() {
  const on = useClassicMailbox()
  return (
    <label className="modalpin-active-filter" title={CLASSIC_MAILBOX_HINT}>
      <input type="checkbox" aria-label={CLASSIC_MAILBOX_LABEL} checked={on}
        onChange={event => setClassicMailbox(event.currentTarget.checked)} />
      {/* "classic inbox" (USER 2026-11-25 mf9341d56d281) */}
      <span>classic inbox</span>
    </label>
  )
}
