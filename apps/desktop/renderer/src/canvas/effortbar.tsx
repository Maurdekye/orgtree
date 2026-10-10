// canvas/effortbar.tsx — the effort selector: ONE bar, like Claude Code's.
// The whole bar is the target: a press anywhere along it picks the level
// nearest the pointer, dragging moves the pick live and release commits, and
// the arrow keys step it. (It used to be five tiny buttons that only took a
// press exactly on a dot — user 2026-10-10.)
//
// Semantics kept from the dot row: `value` is the agent's OWN level ('' =
// inheriting) and `level` is what will actually run; pressing and releasing
// on the level that is already pinned clears it back to inherit.
import { useRef, useState } from 'react'
import type { KeyboardEvent, PointerEvent } from 'react'
import { EFFORT_LEVELS } from './effortlevels'

/** the level nearest `frac` (0 = left end of the bar, 1 = right end) */
export function nearestLevel(frac: number, count = EFFORT_LEVELS.length): number {
  if (!(count > 1)) return 0
  const f = Number.isFinite(frac) ? Math.min(1, Math.max(0, frac)) : 0
  return Math.round(f * (count - 1))
}

export function EffortBar({ value, level, label, title, onSet, disabled, compact, inheritLabel }: {
  /** the level set on this agent/form itself; '' = inheriting */
  value: string
  /** the level that will actually be used (value, else the inherited one) */
  level: string
  /** text above the bar when nothing is hovered or dragged: "Effort (medium)" */
  label?: string
  title?: string
  /** commit a level; '' = clear back to inherit */
  onSet: (lvl: string) => void
  disabled?: boolean
  /** what nothing-selected means here ("inherit", "org default", "CLI default"): shown in the label while no level
   *  is set on this bar, with the inherited `level` if there is one */
  inheritLabel?: string
  /** one row, no label above (Quick chat's header): the level is in the tooltip and aria-valuetext */
  compact?: boolean
}) {
  const track = useRef<HTMLDivElement | null>(null)
  const pinned = EFFORT_LEVELS.indexOf(value)
  const idx = pinned >= 0 ? pinned : EFFORT_LEVELS.indexOf(level)
  const [hover, setHover] = useState<number | null>(null)
  const [drag, setDrag] = useState<number | null>(null)
  const moved = useRef(false)
  const at = (e: PointerEvent): number => {
    const r = track.current?.getBoundingClientRect()
    if (!r || r.width <= 20) return Math.max(idx, 0)
    return nearestLevel((e.clientX - r.left - 10) / (r.width - 20))
  }
  const preview = drag ?? hover
  const shown = drag ?? idx
  const name = EFFORT_LEVELS[shown] ?? ''
  const text = preview !== null && EFFORT_LEVELS[preview]
    ? `Effort (${EFFORT_LEVELS[preview]})`
    : label ?? (pinned < 0 && inheritLabel ? `${inheritLabel}${name ? ` (${name})` : ''}` : `Effort${name ? ` (${name})` : ''}`)
  const key = (e: KeyboardEvent) => {
    if (disabled) return
    const from = idx >= 0 ? idx : 0
    let next: number | null = null
    if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') next = Math.max(0, from - 1)
    else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') next = Math.min(EFFORT_LEVELS.length - 1, from + 1)
    else if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = EFFORT_LEVELS.length - 1
    else if (e.key === 'Backspace' || e.key === 'Delete') { e.preventDefault(); if (pinned >= 0) onSet(''); return }
    if (next === null) return
    e.preventDefault()
    if (next !== pinned) onSet(EFFORT_LEVELS[next]!)
  }
  const pct = (i: number) => `calc(10px + (100% - 20px) * ${i / (EFFORT_LEVELS.length - 1)})`
  return (
    <div className={'effort-bar' + (compact ? ' compact' : '') + (disabled ? ' disabled' : '') + (drag !== null ? ' dragging' : '')
      + (pinned < 0 ? ' inherited' : '')} title={compact && preview !== null ? text : title}>
      {!compact && <div className="effort-bar-label">{text}</div>}
      <div className="effort-bar-track" ref={track} role="slider" tabIndex={disabled ? -1 : 0}
        aria-label="Thinking effort" aria-valuemin={0} aria-valuemax={EFFORT_LEVELS.length - 1}
        aria-valuenow={Math.max(idx, 0)} aria-valuetext={name || 'not set'}
        aria-disabled={disabled || undefined} data-effort-pinned={pinned >= 0 ? EFFORT_LEVELS[pinned] : ''}
        onKeyDown={key}
        onPointerDown={(e) => {
          if (disabled || e.button !== 0) return
          e.currentTarget.setPointerCapture?.(e.pointerId)
          moved.current = false
          setDrag(at(e))
          e.preventDefault()
          e.currentTarget.focus()
        }}
        onPointerMove={(e) => {
          if (disabled) return
          const i = at(e)
          if (drag !== null) { if (i !== drag) { moved.current = true; setDrag(i) } } else setHover(i)
        }}
        onPointerLeave={() => setHover(null)}
        onPointerUp={(e) => {
          if (drag === null) return
          const i = at(e)
          e.currentTarget.releasePointerCapture?.(e.pointerId)
          setDrag(null)
          if (i === pinned && !moved.current) onSet('')
          else if (i !== pinned) onSet(EFFORT_LEVELS[i]!)
        }}
        onPointerCancel={() => setDrag(null)}>
        <span className="effort-bar-rail" />
        {shown >= 0 && <span className="effort-bar-fill" style={{ width: `calc(10px + (100% - 20px) * ${shown / (EFFORT_LEVELS.length - 1)})` }} />}
        {EFFORT_LEVELS.map((l, i) => (
          <span key={l} className={'effort-bar-dot' + (i < shown ? ' below' : '')} style={{ left: pct(i) }} data-level={l} />
        ))}
        {shown >= 0 && <span className="effort-bar-pip" style={{ left: pct(shown) }} data-level={EFFORT_LEVELS[shown]} />}
      </div>
    </div>
  )
}
