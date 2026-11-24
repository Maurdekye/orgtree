import type { SelectionTarget } from '../replySelection'
import type { ReplyTarget } from '../generated/events'
import { replyMessage, sendMessage } from '../api'
import { addPending, bindPendingMail, dismissPending, mintClientOp } from '../convo'

/** Preserve one optimistic send across the typed response and remove only
 * that send on refusal, even when another draft has identical text. The
 * submission's own minted name rides both the ghost and the POST, so the
 * durable copy retires the ghost by identity even before this call returns
 * (see PendingGhost.op). */
export async function sendLinkedReply(org: string, node: string, text: string, target: ReplyTarget | SelectionTarget | (ReplyTarget | SelectionTarget)[],
  attachments?: string[], notice?: boolean, urgency?: { urgent: true; urgent_reason?: string }) {
  const op = mintClientOp()
  const ghost = addPending(org, node, text, undefined, undefined, op, notice)
  try {
    const response = await replyMessage(org, node, text, target, attachments, op, notice, urgency)
    bindPendingMail(org, node, ghost, response)
    return response
  } catch (error) {
    dismissPending(org, node, ghost)
    throw error
  }
}

/** A NEW MESSAGE TYPED IN THE USER'S CHATS (dm/DmPanel.tsx), not a reply.
 *
 * It is ordinary mail from the user to `node`, with the same optimistic entry
 * in that agent's chat as a linked reply. What differs is one word to the
 * engine, `surface: 'dm'`: the agent is then told the message came from the
 * chats, which show only mail, and to answer with at least one mail to the
 * user (USER 2026-11-23 m79c022311f95, m034b5c83b8f2). A notice expects no
 * reply and is not marked. */
export async function sendPanelMessage(org: string, node: string, text: string,
  attachments?: string[], notice?: boolean, urgency?: { urgent: true; urgent_reason?: string }) {
  const op = mintClientOp()
  const ghost = addPending(org, node, text, undefined, undefined, op, notice)
  try {
    const response = await sendMessage(org, node, text, attachments, undefined, op, notice,
      undefined, undefined, urgency, notice ? undefined : 'dm')
    bindPendingMail(org, node, ghost, response)
    return response
  } catch (error) {
    dismissPending(org, node, ghost)
    throw error
  }
}
