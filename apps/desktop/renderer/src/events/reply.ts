import type { ReplyTarget } from '../generated/events'
import { replyMessage } from '../api'
import { addPending, bindPendingMail, dismissPending } from '../convo'

/** Preserve one optimistic send across the typed response and remove only
 * that send on refusal, even when another draft has identical text. */
export async function sendLinkedReply(org: string, node: string, text: string, target: ReplyTarget) {
  const ghost = addPending(org, node, text)
  try {
    const response = await replyMessage(org, node, text, target)
    bindPendingMail(org, node, ghost, response)
    return response
  } catch (error) {
    dismissPending(org, node, ghost)
    throw error
  }
}
