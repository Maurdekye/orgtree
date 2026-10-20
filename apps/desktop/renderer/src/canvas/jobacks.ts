// canvas/jobacks.ts — acknowledging a job the project's mail queue handed the
// user (docket let-the-user-manually-hold-a-number-of-a-project; USER
// 2026-10-20 13:22Z). "Reply & acknowledge" sends the reply to the job's sender
// FIRST, as an ordinary reply to the job's mail in the user's inbox, then
// acknowledges with that reply's id kept as the completion record; "Acknowledge
// without reply" only acknowledges. A reply that fails acknowledges nothing, so
// the job stays held and the draft can be sent again. Self-sent jobs only
// acknowledge: the user is not an agent recipient, and user_job_ack stores
// reply-mail IDs, not free-text notes. The sending and the
// engine call are the host's (the user's inbox in App.tsx); this is the order.

import type { MailRow } from './shared'
import { isUserName } from './username'

/** Mail uses the actor sentinel; retained rows may use the user's data name. */
export const jobWasSentByUser = (sender: string | null | undefined): boolean => sender === '@user' || isUserName(sender)

export interface AckJobDeps {
  row: MailRow
  /** the reply text, when there is one */
  reply?: string
  /** files staged on the reply and whether it was armed as a passive notice (the composer's own choices) */
  attachments?: string[]
  notice?: boolean
  /** send `text` to the job's sender as a reply to `row`; resolves with the sent mail's id */
  sendReply: (row: MailRow, text: string, opts?: { attachments?: string[]; notice?: boolean }) => Promise<{ id?: string | null }>
  /** the engine's `user_job_ack` for the job's mail (`copy`), naming the reply mail if any */
  ack: (copy: string, reply?: string) => Promise<unknown>
}

export async function acknowledgeJob({ row, reply, attachments, notice, sendReply, ack }: AckJobDeps): Promise<void> {
  if (!row.id) throw new Error('this job has no mail id to acknowledge')
  let replyId: string | undefined
  if (reply && !jobWasSentByUser(row.from)) {
    const receipt = await sendReply(row, reply, { attachments, notice })
    replyId = receipt.id ?? undefined
  }
  await ack(row.id, replyId)
}
