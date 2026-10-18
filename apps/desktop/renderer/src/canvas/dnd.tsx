import { useEffect } from 'react'

export interface UrgentAgentMail { urgent: true; urgent_reason: string }

/** Used by both the card and desk's shared workstate. */
export function DndBadge({ active }: { active?: boolean }) {
  return active ? <span className="dnd-badge" title="Do Not Disturb: non-urgent mail waits until this turn ends">DND</span> : null
}

/** Urgency is a live DND bypass, never a persistent preference for agent mail. */
export function UrgentAgentOptions({ active, value, onChange }: {
  active?: boolean; value?: UrgentAgentMail; onChange: (value?: UrgentAgentMail) => void
}) {
  useEffect(() => { if (!active && value) onChange(undefined) }, [active, value, onChange])
  if (!active) return null
  return <div className="dnd-urgent-options">
    <label><input type="checkbox" aria-label="Urgent: bypass Do Not Disturb" checked={!!value}
      onChange={e => onChange(e.target.checked ? { urgent:true, urgent_reason:'' } : undefined)} /> urgent</label>
    {value && <input aria-label="Urgent reason" placeholder="why this must interrupt now" value={value.urgent_reason}
      onChange={e => onChange({ urgent:true, urgent_reason:e.target.value })} />}
  </div>
}
