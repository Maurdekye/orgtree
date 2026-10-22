import { useEffect, useState } from 'react'
import { setNodeDnd, type DndState } from '../api'

export interface UrgentAgentMail { urgent: true; urgent_reason?: string }

/** Shared token on the card and desk header, beside effort. */
export function DndBadge({ active, nextTurn }: { active?: boolean; nextTurn?: boolean }) {
  return active || nextTurn ? <span className="badge dnd-badge" title={nextTurn && !active
    ? 'Do Not Disturb is armed for the next turn; its opening mail is admitted normally'
    : 'Do Not Disturb: non-urgent mail waits until cleared or this turn ends'}>{active ? 'DND' : 'DND next turn'}</span> : null
}

/** User action is separate from the inert state badge. */
export function DndControl({ slug, nid, active, nextTurn, toast }: {
  slug: string; nid: string; active?: boolean; nextTurn?: boolean; toast: (lines: string[]) => void
}) {
  const [saving,setSaving]=useState(false)
  const [applied,setApplied]=useState<DndState | null>(null)
  useEffect(()=>setApplied(null),[slug,nid,active,nextTurn])
  const on=applied ? applied.dnd || applied.dnd_next_turn : !!(active || nextTurn)
  const armed=applied ? applied.dnd_next_turn : nextTurn
  const title=on ? 'Turn off Do Not Disturb and release held mail now at the next supported delivery boundary'
    : 'Turn on Do Not Disturb for this turn, or arm the next turn if idle'
  return <button type="button" className="dnd-control" aria-label="Do Not Disturb" aria-pressed={on}
    title={title} disabled={saving} onClick={async()=>{
      setSaving(true)
      try { setApplied(await setNodeDnd(slug,nid,!on)) }
      catch (error) { toast([`error: ${(error as Error).message}`]) }
      finally { setSaving(false) }
    }}>{on && armed ? 'DND next turn' : 'DND'}</button>
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
      title="Urgent: bypass Do Not Disturb"
      onClick={() => onChange(value ? undefined : { urgent:true })}>!</button>
  </div>
}
