// canvas/mailqueuejoin.tsx — the Mail tab header's "Join mail queue" control
// (docket slots-tab-header-hold-n-slots-button-with-number; USER 2026-10-20
// 16:39Z: "move this button in the same way. make the text variable: with a
// value of 1, make it say "Join mail queue". with a value of 2, say "Join mail
// queue twice". 3, "Join mail queue 3 times" ... it can be changed after and
// pressed again to update the batch size"). A number input beside the button
// is the user's batch (jobs held at once); one click joins the project's mail
// queue at once, no dialog. Already in the queue, the input shows their batch,
// the button is grey until the number differs, and a click sends the same op,
// which changes the batch in place on the engine (their place in the order and
// any job they hold are kept). Leaving stays on the listeners folder itself.

import { useState } from 'react'
import type { ToastFn } from '../types'
import type { CanvasNode, OpFn } from './shared'
import type { MailListenerState } from './listeners'
import { isUserName } from './usermention'
import { MAX_QUEUE_BATCH } from './userdialogs'

/** the button's words for a batch: once, twice, N times */
export function mailQueueJoinLabel(batch: number): string {
  return batch === 1 ? 'Join mail queue' : batch === 2 ? 'Join mail queue twice' : `Join mail queue ${batch} times`
}

export function MailQueueJoin({ node, state, op, toast }: {
  node: CanvasNode; state: MailListenerState; op?: OpFn; toast?: ToastFn
}) {
  const mine = state.listeners.find((w) => isUserName(w.owner))
  const current = mine ? Math.min(Math.max(mine.batch ?? 1, 1), MAX_QUEUE_BATCH) : null
  // null: follow the tree's own batch for the user (1 before they join)
  const [typed, setTyped] = useState<string | null>(null)
  if (node.state !== 'live') return null
  // a typed number is brought into 1..the engine's limit; an empty or fractional one stays as typed and sends nothing
  const bring = (text: string) => /^\d+$/.test(text.trim()) ? String(Math.min(Math.max(Number(text.trim()), 1), MAX_QUEUE_BATCH)) : text
  const shown = typed === null ? String(current ?? 1) : bring(typed)
  const n = /^\d+$/.test(shown) ? Number(shown) : null
  const unchanged = current !== null && n === current
  const send = () => {
    if (n === null || unchanged || !op) return
    op({ op: 'user_queue_join', node: node.id, batch: n })
      .then(() => toast?.([mine ? `mail queue batch of project ${node.id} changed to ${n}` : `joined project ${node.id}'s mail queue (batch ${n})`]))
      .catch(() => {})
  }
  return (
    <span className="queue-join" role="group" aria-label="Join the mail queue">
      <input type="number" min={1} max={MAX_QUEUE_BATCH} step={1} value={shown} aria-label="Mail queue batch size"
        title={`how many jobs are handed to the user at once: 1 to ${MAX_QUEUE_BATCH} (the engine's limit)`}
        onChange={(e) => setTyped(bring(e.target.value))} />
      <button type="button" data-action="join-queue" disabled={n === null || unchanged}
        title={n === null ? `choose a batch of 1 to ${MAX_QUEUE_BATCH}`
          : unchanged ? `already in the queue with a batch of ${n}: change the number to update it`
          : mine ? `change the batch to ${n}: the place in the order and any job held are kept`
          : `take a share of ${node.id}'s mail, up to ${n} job${n === 1 ? '' : 's'} at a time: they arrive as normal mail in your inbox`}
        onClick={send}>{n === null ? 'Join mail queue' : mailQueueJoinLabel(n)}</button>
    </span>)
}
