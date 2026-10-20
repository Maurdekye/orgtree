// canvas/jobackpane.tsx — the acknowledge pane of a job the project's mail
// queue handed the USER (docket let-the-user-manually-hold-a-number-of-a-project;
// USER 2026-10-20 13:04:56Z "queued jobs dispatched to the user arrive as
// normal mail in their inbox, and the user can acknowledge them", 13:22Z layout
// B: "Reply & acknowledge" is the main action on a queued job, "Acknowledge
// without reply" the secondary). It sits in the inbox's reading pane in place
// of the ordinary reply box while the job is unacknowledged: reading the job
// never acknowledges it, and the job is theirs until they do (even after
// leaving the queue). The host does the sending and the acknowledging
// (`jobacks.ts`); this pane gathers the reply and shows what became of it.
// USER 2026-10-20 18:26:29Z: the reply UI looks like the ordinary one, so the
// reply box here IS `MailReplyBox` (its send button reads "reply & acknowledge"),
// and "Acknowledge without reply" sits under it in the composer's button style.

import { useState } from 'react'
import type { MailQueueState, ToastFn } from '../types'
import { fmtFull } from '../timefmt'
import { MailReplyBox } from './mail'

export type QueueJob = NonNullable<MailQueueState['job']>

/** Does this job's reading pane offer the acknowledge pane: a job of an
 *  ACK-mode queue (a round-robin job needs none). */
export const needsAck = (job: QueueJob | undefined): job is QueueJob => !!job && job.ack === true

export function JobAckPane({ job, onAck, target, slug, toast }: {
  job: QueueJob
  /** send the reply (when there is one) and acknowledge the job */
  onAck: (reply?: string, opts?: { attachments?: string[]; notice?: boolean }) => Promise<unknown>
  /** the job's sender, whom the reply goes to */
  target?: string
  slug?: string
  toast?: ToastFn
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  if (job.acked_at) {
    return <div className="job-ack acked" role="status">
      <span className="job-ack-done">✓ Job acknowledged</span>
      <span className="dim"> {fmtFull(job.acked_at)}. Project {job.name} can hand the next job.</span>
    </div>
  }
  const skip = () => {
    if (busy) return
    setBusy(true); setError(null)
    onAck(undefined)
      .catch((e: Error) => setError(e?.message || 'could not acknowledge the job'))
      .finally(() => setBusy(false))
  }
  return <div className="job-ack">
    <div className="cache-send-warning compact job-ack-note"><span aria-hidden="true">⚠</span>
      <span>This job came from project {job.name}'s mail queue and is held until it is acknowledged. Reading it does not acknowledge it.</span></div>
    <MailReplyBox target={target} slug={slug} toast={toast}
      sendLabel="reply & acknowledge" sendTitle="send this reply to the sender, then acknowledge the job"
      onSend={(text, attachments, notice) => onAck(text, { attachments, notice })}
      below={<button type="button" className="job-ack-skip" data-action="ack" disabled={busy}
        title="acknowledge the job without replying to its sender" onClick={skip}>Acknowledge without reply</button>} />
    {error && <div role="alert" className="job-ack-error">{error}</div>}
  </div>
}
