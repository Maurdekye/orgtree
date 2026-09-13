import type { ReplyTarget } from '../generated/events'
import { replyMessage } from '../api'
import { addPending, bindPendingMail, dismissPending, mintClientOp } from '../convo'

/** Preserve one optimistic send across the typed response and remove only
 * that send on refusal, even when another draft has identical text. The
 * submission's own minted name rides both the ghost and the POST, so the
 * durable copy retires the ghost by identity even before this call returns
 * (see PendingGhost.op). */
export async function sendLinkedReply(org: string, node: string, text: string, target: ReplyTarget,
  attachments?: string[]) {
  const op = mintClientOp()
  const ghost = addPending(org, node, text, undefined, undefined, op)
  try {
    const response = await replyMessage(org, node, text, target, attachments, op)
    bindPendingMail(org, node, ghost, response)
    return response
  } catch (error) {
    dismissPending(org, node, ghost)
    throw error
  }
}
