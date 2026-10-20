// canvas/mailqueuejoin.tsx — the Mail tab header's "Join mail queue" control
// (docket slots-tab-header-hold-n-slots-button-with-number; USER 2026-10-20
// 16:39Z: "move this button in the same way. make the text variable: with a
// value of 1, make it say "Join mail queue". with a value of 2, say "Join mail
// queue twice". 3, "Join mail queue 3 times" ... number can be as high as the
// user wants. it can be changed after and pressed again to update the batch
// size"). It sits at the end of the Mail tab's folder strip, left of the
// pin / pop-out / modal buttons, on every folder.
//
// The number is the user's batch (jobs held at once), up to the engine's own
// limit of 20 (domain/projects.rs `MAX_QUEUE_BATCH`, which agents' fair_queue
// dogs share). One press joins the project's mail queue at once, no dialog.
// Already in the queue, the input shows their batch and the button is grey
// until the number differs; a press then sends the same op, and the engine
// changes the batch in place (their place in the order and any job they hold
// are kept). Leaving stays on the listeners folder itself. The old dialog's
// help text is the button's tooltip (USER 16:43Z).

import { useEffect, useState } from 'react'
import type { ToastFn } from '../types'
import type { CanvasNode, OpFn } from './shared'
import type { MailListenerState } from './listeners'
import { isUserName } from './usermention'
import { MAX_QUEUE_BATCH } from './userlimits'
import { DeskCount, bringCount, countOf } from './deskcount'

/** the button's words for a batch: once, twice, N times */
export function mailQueueJoinLabel(batch: number): string {
  return batch === 1 ? 'Join mail queue' : batch === 2 ? 'Join mail queue twice' : `Join mail queue ${batch} times`
}

export function MailQueueJoin({ node, state, ack, op, toast }: {
  node: CanvasNode; state: MailListenerState
  /** ACK mode (each job is the user's until they acknowledge it), else round-robin */
  ack: boolean
  op?: OpFn; toast?: ToastFn
}) {
  const mine = state.listeners.find((w) => isUserName(w.owner))
  const current = mine ? Math.min(Math.max(mine.batch ?? 1, 1), MAX_QUEUE_BATCH) : null
  // null: follow the tree's own batch for the user (1 before they join). The
  // typed number stays after a press until the tree reports a batch (the one
  // the press applied, or another surface's), which the input follows again
  const [typed, setTyped] = useState<string | null>(null)
  useEffect(() => { setTyped(null) }, [current])
  if (node.state !== 'live') return null
  const shown = typed === null ? String(current ?? 1) : typed
  const n = countOf(shown)
  const unchanged = current !== null && n === current
  const jobs = (k: number) => k === 1 ? 'one job at a time' : `up to ${k} jobs at a time`
  const help = `Jobs ${node.id}'s queue hands out arrive as normal mail in your inbox, one listener at a time in turn. `
    + (ack ? 'Acknowledge each job when it is finished; a job being held stays held until it is acknowledged, even after leaving the queue.'
      : 'The queue is round-robin, so no acknowledgement is needed.')
  const send = () => {
    if (n === null || unchanged || !op) return
    op({ op: 'user_queue_join', node: node.id, batch: n })
      .then(() => toast?.([mine ? `mail queue batch of project ${node.id} changed to ${n}` : `joined project ${node.id}'s mail queue (batch ${n})`]))
      .catch(() => {})
  }
  return (
    <DeskCount className="queue-join" groupLabel="Join the mail queue"
      value={shown} min={1} max={MAX_QUEUE_BATCH}
      onValue={(text) => setTyped(bringCount(text, 1, MAX_QUEUE_BATCH))}
      inputLabel="Mail queue batch size"
      inputTitle={`the batch: how many of ${node.id}'s jobs are handed over at once, 1 to ${MAX_QUEUE_BATCH} (the engine's limit)`}
      action="join-queue" disabled={n === null || unchanged || !op}
      label={n === null ? 'Join mail queue' : mailQueueJoinLabel(n)}
      title={n === null ? `choose a batch of 1 to ${MAX_QUEUE_BATCH}`
        : unchanged ? `already in ${node.id}'s mail queue with a batch of ${n}: change the number to update it. ${help}`
        : mine ? `change the batch to ${n}, ${jobs(n)}: the place in the order and any job held are kept. ${help}`
        : `take a share of ${node.id}'s mail, ${jobs(n)}. ${help}`}
      onAct={send} />)
}
