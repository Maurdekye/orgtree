// canvas/userdialogs.tsx — the focused dialogs of the user's own project
// registrations (docket let-the-user-manually-hold-a-number-of-a-project;
// USER 2026-10-20 13:22Z: layout B, "focused Add dialogs"): hold concurrency
// slots, register an event listener, register a listener watch, join the
// mail queue. Each is the shared in-page dialog (`ConfirmModal`, as a form
// dialog) with the engine's own limits in its fields; the caller sends the op
// (the desk's `op` toasts a refusal) and re-reads. No native OS dialog.

import { useState } from 'react'
import type { ReactNode } from 'react'
import { ConfirmModal } from './modals'
import { MAX_SLOTS } from './slots'

/** the engine's limits (domain/listeners.rs `MAX_COUNT`, projects.rs `MAX_QUEUE_BATCH`, ops/user_regs.rs `MAX_REASON`) */
export const MAX_WATCH_COUNT = 1024
export const MAX_QUEUE_BATCH = 20
export const MAX_REASON = 200

/** a whole number from `min` to `max` typed in a field, else null */
export function wholeNumber(text: string, min: number, max: number): number | null {
  if (!/^\d+$/.test(text.trim())) return null
  const n = Number(text.trim())
  return n >= min && n <= max ? n : null
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className="user-reg-field"><span>{label}</span>{children}</label>
}

/** Hold concurrency slots: a count from 1 to the project's slots, an optional reason. */
export function HoldSlotsDialog({ project, slots, onHold, close }: {
  project: string; slots: number; onHold: (slots: number, reason: string) => void; close: () => void
}) {
  const max = Math.min(slots, MAX_SLOTS)
  const [count, setCount] = useState('1')
  const [reason, setReason] = useState('')
  const n = wholeNumber(count, 1, max)
  return (
    <ConfirmModal form title="Hold concurrency slots" confirmLabel="Hold slots"
      confirmDisabled={n === null} confirmTitle={n === null ? `choose 1 to ${max} slots` : undefined}
      close={close} onConfirm={() => { if (n !== null) onHold(n, reason.trim()) }}
      body={<div className="user-reg-form">
        <Field label="Slots">
          <input type="number" min={1} max={max} step={1} value={count} aria-label="Slots to hold"
            onChange={(e) => setCount(e.target.value)} />
        </Field>
        <Field label="Reason (optional)">
          <input type="text" maxLength={MAX_REASON} value={reason} aria-label="Why the slots are held"
            onChange={(e) => setReason(e.target.value)} />
        </Field>
        <p className="dim user-reg-hint">The request waits in {project}'s line like an agent's claim and is granted when all
          the requested slots are free together. It lasts until it is released, across a restart too.</p>
      </div>} />
  )
}

/** Register as an event listener: every event, or the next one only. */
export function RegisterListenerDialog({ project, onRegister, close }: {
  project: string; onRegister: (once: boolean) => void; close: () => void
}) {
  const [mode, setMode] = useState<'every' | 'once'>('every')
  return (
    <ConfirmModal form title="Register an event listener" confirmLabel="Register event listener"
      close={close} onConfirm={() => onRegister(mode === 'once')}
      body={<div className="user-reg-form">
        <Field label="Receive">
          <select value={mode} aria-label="Which events to receive" onChange={(e) => setMode(e.target.value === 'once' ? 'once' : 'every')}>
            <option value="every">Every event</option>
            <option value="once">Next event only</option>
          </select>
        </Field>
        <p className="dim user-reg-hint">Each event fired on {project} arrives as normal mail in your inbox. It also counts
          toward listener watches.</p>
      </div>} />
  )
}

/** Register a listener watch: a one-time notice when the armed listeners reach a count. */
export function RegisterWatchDialog({ project, onRegister, close }: {
  project: string; onRegister: (count: number) => void; close: () => void
}) {
  const [count, setCount] = useState('2')
  const n = wholeNumber(count, 1, MAX_WATCH_COUNT)
  return (
    <ConfirmModal form title="Register a listener watch" confirmLabel="Register listener watch"
      confirmDisabled={n === null} confirmTitle={n === null ? `choose 1 to ${MAX_WATCH_COUNT} listeners` : undefined}
      close={close} onConfirm={() => { if (n !== null) onRegister(n) }}
      body={<div className="user-reg-form">
        <Field label="Notify when event listeners reach">
          <input type="number" min={1} max={MAX_WATCH_COUNT} step={1} value={count} aria-label="Listener watch count"
            onChange={(e) => setCount(e.target.value)} />
        </Field>
        <p className="dim user-reg-hint">A one-time notification arrives as normal mail in your inbox when this many event
          listeners are armed on {project}. An event listener of yours counts.</p>
      </div>} />
  )
}

/** Join the mail queue as a listener: a batch from 1 to 20. */
export function JoinQueueDialog({ project, ack, onJoin, close }: {
  project: string; ack: boolean; onJoin: (batch: number) => void; close: () => void
}) {
  const [batch, setBatch] = useState('1')
  const n = wholeNumber(batch, 1, MAX_QUEUE_BATCH)
  return (
    <ConfirmModal form title="Join the mail queue" confirmLabel="Join mail queue"
      confirmDisabled={n === null} confirmTitle={n === null ? `choose a batch of 1 to ${MAX_QUEUE_BATCH}` : undefined}
      close={close} onConfirm={() => { if (n !== null) onJoin(n) }}
      body={<div className="user-reg-form">
        <Field label="Batch">
          <input type="number" min={1} max={MAX_QUEUE_BATCH} step={1} value={batch} aria-label="Mail queue batch size"
            onChange={(e) => setBatch(e.target.value)} />
        </Field>
        <p className="dim user-reg-hint">Jobs {project}'s queue hands out arrive as normal mail in your inbox, one listener
          at a time in turn. {ack
            ? 'Acknowledge each job when it is finished; a job being held stays held until it is acknowledged, even after leaving the queue.'
            : 'The queue is round-robin, so no acknowledgement is needed.'}</p>
      </div>} />
  )
}
