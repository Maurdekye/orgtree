// canvas/deskcount.tsx — a number and the button it counts for, joined into
// one control (docket slots-tab-header-hold-n-slots-button-with-number; USER
// 2026-10-20 16:35Z-16:43Z): the project desk header's "Hold N slots" (Slots
// tab) and "Join mail queue N times" (Mail tab), and the Register… panel's
// "Register watcher for N listeners" (Listeners tab). Each puts a number
// input, default 1, beside a button whose words follow it, and a press acts
// at once; there is no dialog. The host owns the words, the limits and the
// op; this file owns how a typed count is read and how the pair looks (one
// joined control, the number on the left, styles.css `.desk-count`).

import type { ReactNode } from 'react'

/** The whole number in a count's text, else null (empty, fractional, a sign). */
export function countOf(text: string): number | null {
  const t = text.trim()
  return /^\d+$/.test(t) ? Number(t) : null
}

/** A typed count brought into `min`..`max` (a whole number outside it takes
 *  the nearer end); text that is not a whole number stays as typed, so the
 *  host's button reads it as nothing to send. */
export function bringCount(text: string, min: number, max: number): string {
  const n = countOf(text)
  return n === null ? text : String(Math.min(Math.max(n, min), Math.max(max, min)))
}

export function DeskCount({ className, groupLabel, value, min, max, onValue, inputLabel, inputTitle, inputDisabled,
  action, label, title, disabled, onAct }: {
  /** the host's own class, beside `desk-count` (`slot-hold`, `queue-join`, `register-watch-count`) */
  className: string
  groupLabel: string
  /** the input's text, already brought into range by the host (`bringCount`) */
  value: string
  min: number
  max: number
  /** the raw text typed: the host brings it into range and keeps it */
  onValue: (text: string) => void
  inputLabel: string
  inputTitle: string
  inputDisabled?: boolean
  /** the button's `data-action` */
  action: string
  label: ReactNode
  title: string
  disabled: boolean
  onAct: () => void
}) {
  return (
    <span className={'desk-count ' + className} role="group" aria-label={groupLabel}>
      <input type="number" min={min} max={max} step={1} value={value} disabled={inputDisabled}
        aria-label={inputLabel} title={inputTitle}
        onChange={(e) => onValue(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && !disabled) { e.preventDefault(); onAct() } }} />
      <button type="button" data-action={action} disabled={disabled} title={title}
        onClick={() => { if (!disabled) onAct() }}>{label}</button>
    </span>
  )
}
