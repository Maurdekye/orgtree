// canvas/userdialogs.tsx — the focused dialogs of the user's own project
// registrations (docket let-the-user-manually-hold-a-number-of-a-project;
// USER 2026-10-20 13:22Z: layout B, "focused Add dialogs"): register an event
// listener, register a listener watch. Each is the shared in-page dialog
// (`ConfirmModal`, as a form dialog) with the engine's own limits in its
// fields; the caller sends the op (the desk's `op` toasts a refusal) and
// re-reads. No native OS dialog. Holding slots and joining the mail queue are
// controls in the desk header instead (USER 2026-10-20 16:35Z/16:39Z:
// slotsdesk.tsx, mailqueuejoin.tsx), not dialogs.

import { useState } from 'react'
import type { ReactNode } from 'react'
import { ConfirmModal } from './modals'

/** the engine's limits (domain/listeners.rs `MAX_COUNT`, projects.rs `MAX_QUEUE_BATCH`) */
export const MAX_WATCH_COUNT = 1024
export const MAX_QUEUE_BATCH = 20

/** a whole number from `min` to `max` typed in a field, else null */
export function wholeNumber(text: string, min: number, max: number): number | null {
  if (!/^\d+$/.test(text.trim())) return null
  const n = Number(text.trim())
  return n >= min && n <= max ? n : null
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className="user-reg-field"><span>{label}</span>{children}</label>
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
