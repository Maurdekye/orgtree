import { useEffect } from 'react'

export interface UrgentAgentMail { urgent: true; urgent_reason: string }

/** Shared token on the card and desk header, beside effort. */
export function DndBadge({ active }: { active?: boolean }) {
  return active ? <span className="badge dnd-badge" title="Do Not Disturb: non-urgent mail waits until this turn ends">DND</span> : null
}

/** Urgency is a live DND bypass, never a persistent preference for agent mail. */
export function UrgentAgentOptions({ active, value, onChange }: {
  active?: boolean; value?: UrgentAgentMail; onChange: (value?: UrgentAgentMail) => void
}) {
  useEffect(() => { if (!active && value) onChange(undefined) }, [active, value, onChange])
  if (!active) return null
  return <div className="dnd-urgent-options">
    <button type="button" className={'cc-notice-toggle cc-urgent-toggle' + (value ? ' armed' : '')}
      aria-label="Urgent: bypass Do Not Disturb" aria-pressed={!!value}
      title="Urgent: bypass Do Not Disturb (requires a reason)"
      onClick={() => onChange(value ? undefined : { urgent:true, urgent_reason:'' })}>!</button>
    {value && <input aria-label="Urgent reason" placeholder="why this must interrupt now" value={value.urgent_reason}
      onChange={e => onChange({ urgent:true, urgent_reason:e.target.value })} />}
  </div>
}
