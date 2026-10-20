// canvas/inboxwarning.tsx — the project message box's note while the
// project's inbox has no listeners (Orgtree 4.4.0; docket
// warn-senders-when-they-mail-a-project-whose-inbo, user 2026-10-20 11:04Z:
// "make sure they're warned that their mail may not be read by anyone or
// delivered anywhere unless the inbox has any listeners attached"). The
// engine warns every sender in the send's own note (projects.rs
// `no_listener_warning`); this says it before the user sends.

import { WarnIcon } from '../icons'
import { mailListenerState } from './listeners'
import type { Watchdog } from '../types'

/** Whether a listener is attached to the project's inbox: a fair_queue dog on
 *  the project, armed or paused, as the inbox's listeners folder lists them.
 *  A paused listener is attached; the engine's send note says the mail waits
 *  for it to resume. */
export const inboxListened = (project: string, dogs: Watchdog[]) =>
  mailListenerState(project, dogs).listeners.length > 0

/** The note, for a box whose project's inbox has no listener (`inboxListened`). */
export function InboxNoListeners({ project }: { project: string }) {
  return <div className="inbox-no-listeners cache-send-warning compact" role="note"
    title={`No agent listens on project ${project}'s inbox with a fair_queue watchdog. Mail sent here waits in its mailbox `
      + 'until an agent above or below the project arms one. The megaphone (Alt+B) sends to every agent under the project instead.'}>
    <WarnIcon fontSize="inherit" />
    <span>No mail listeners: mail sent here may not be received by anyone. Turn on broadcast (megaphone) to send to all project participants.</span>
  </div>
}
