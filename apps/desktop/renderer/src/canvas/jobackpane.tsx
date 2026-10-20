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

import { useState } from 'react'
import type { MailQueueState } from '../types'
import { fmtFull } from '../timefmt'

export type QueueJob = NonNullable<MailQueueState['job']>

/** Does this job's reading pane offer the acknowledge pane: a job of an
 *  ACK-mode queue (a round-robin job needs none). */
export const needsAck = (job: QueueJob | undefined): job is QueueJob => !!job && job.ack === true

export function JobAckPane({ job, onAck }: {
  job: QueueJob
  /** send the reply (when there is one) and acknowledge the job */
  onAck: (reply?: string) => Promise<unknown>
}) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  if (job.acked_at) {
    return <div className="job-ack acked" role="status">
      <span className="job-ack-done">✓ Job acknowledged</span>
      <span className="dim"> {fmtFull(job.acked_at)}. Project {job.name} can hand the next job.</span>
    </div>
  }
  const run = (reply?: string) => {
    if (busy) return
    setBusy(true); setError(null)
    onAck(reply)
      .then(() => setText(''))
      .catch((e: Error) => setError(e?.message || 'could not acknowledge the job'))
      .finally(() => setBusy(false))
  }
  const reply = text.trim()
  return <div className="job-ack">
    <div className="cache-send-warning compact job-ack-note"><span aria-hidden="true">⚠</span>
      <span>This job came from project {job.name}'s mail queue and is held until it is acknowledged. Reading it does not acknowledge it.</span></div>
    <textarea value={text} rows={3} disabled={busy} placeholder="Reply to the sender (optional)" aria-label="Reply to the job's sender"
      onChange={(e) => setText(e.target.value)} />
    <div className="job-ack-actions">
      <button type="button" className="primary" data-action="reply-ack" disabled={busy || !reply}
        title={reply ? 'send this reply to the sender, then acknowledge the job' : 'write a reply first, or acknowledge without one'}
        onClick={() => run(reply)}>Reply &amp; acknowledge</button>
      <button type="button" data-action="ack" disabled={busy}
        title="acknowledge the job without replying to its sender" onClick={() => run(undefined)}>Acknowledge without reply</button>
    </div>
    {error && <div role="alert" className="job-ack-error">{error}</div>}
  </div>
}
