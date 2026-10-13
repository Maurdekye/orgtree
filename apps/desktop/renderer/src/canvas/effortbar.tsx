// canvas/effortbar.tsx — the effort selector: ONE bar, like Claude Code's.
// The whole bar is the target: a press anywhere along it picks the level
// nearest the pointer, dragging moves the pick live and release commits, and
// the arrow keys step it. (It used to be five tiny buttons that only took a
// press exactly on a dot — user 2026-10-10.)
//
// Semantics kept from the dot row: `value` is the agent's OWN level ('' =
// inheriting) and `level` is what will actually run; pressing and releasing
// on the level that is already pinned clears it back to inherit.
import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent, PointerEvent } from 'react'
import { DEFAULT_EFFORT_LEVELS, EFFORT_LEVELS } from './effortlevels'

/** the level nearest `frac` (0 = left end of the bar, 1 = right end) */
export function nearestLevel(frac: number, count = DEFAULT_EFFORT_LEVELS.length): number {
  if (!(count > 1)) return 0
  const f = Number.isFinite(frac) ? Math.min(1, Math.max(0, frac)) : 0
  return Math.round(f * (count - 1))
}

export function EffortBar({ value, level, label, title, onSet, disabled: disabledProp, compact, inheritLabel, levels: levelsProp }: {
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
  /** the levels the model supports, in its own harness's names (an ordered subset of EFFORT_LEVELS); [] = no effort
   *  setting, the bar is disabled; undefined = not known yet, Claude Code's five. A stored level the model does not
   *  name shows clamped (the highest offered at or below it, else the lowest), as the engine sends it. */
  levels?: readonly string[]
}) {
  const LV = levelsProp ? EFFORT_LEVELS.filter((l) => levelsProp.includes(l)) : DEFAULT_EFFORT_LEVELS
  const none = LV.length === 0
  const disabled = disabledProp || none
  const clamp = (v: string): number => {
    const i = LV.indexOf(v)
    if (i >= 0) return i
    const rank = EFFORT_LEVELS.indexOf(v)
    if (rank < 0 || none) return -1
    let best = 0
    LV.forEach((l, j) => { if (EFFORT_LEVELS.indexOf(l) <= rank) best = j })
    return best
  }
  const track = useRef<HTMLDivElement | null>(null)
  const pinned = clamp(value)
  const idx = pinned >= 0 ? pinned : clamp(level)
  const [hover, setHover] = useState<number | null>(null)
  const [drag, setDrag] = useState<number | null>(null)
  const moved = useRef(false)
  // true once a press has actually travelled to another level: only then does the pip follow the pointer with no
  // glide (a plain click glides to its level), and `held` keeps a released pick on screen until the saved value lands
  const [travelled, setTravelled] = useState(false)
  const [held, setHeld] = useState<number | null>(null)
  useEffect(() => { setHeld(null) }, [value, level])
  useEffect(() => {
    if (held === null) return
    const t = setTimeout(() => setHeld(null), 600)
    return () => clearTimeout(t)
  }, [held])
  const at = (e: PointerEvent): number => {
    const r = track.current?.getBoundingClientRect()
    if (!r || r.width <= 20) return Math.max(idx, 0)
    return nearestLevel((e.clientX - r.left - 10) / (r.width - 20), LV.length)
  }
  const preview = drag ?? hover
  const shown = drag ?? held ?? idx
  const name = LV[shown] ?? ''
  const text = none ? 'No effort setting' : preview !== null && LV[preview]
    ? `Effort (${LV[preview]})`
    : label ?? (pinned < 0 && inheritLabel ? `${inheritLabel}${name ? ` (${name})` : ''}` : `Effort${name ? ` (${name})` : ''}`)
  const key = (e: KeyboardEvent) => {
    if (disabled) return
    const from = idx >= 0 ? idx : 0
    let next: number | null = null
    if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') next = Math.max(0, from - 1)
    else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') next = Math.min(LV.length - 1, from + 1)
    else if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = LV.length - 1
    else if (e.key === 'Backspace' || e.key === 'Delete') { e.preventDefault(); if (pinned >= 0) onSet(''); return }
    if (next === null) return
    e.preventDefault()
    if (next !== pinned) onSet(LV[next]!)
  }
  const pct = (i: number) => `calc(10px + (100% - 20px) * ${LV.length > 1 ? i / (LV.length - 1) : 0})`
  return (
    <div className={'effort-bar' + (none ? ' none' : '') + (compact ? ' compact' : '') + (disabled ? ' disabled' : '') + (drag !== null && travelled ? ' dragging' : '')
      + (pinned < 0 ? ' inherited' : '')} title={none ? 'This model has no effort setting' : compact && preview !== null ? text : title}>
      {!compact && <div className="effort-bar-label">{text}</div>}
      <div className="effort-bar-track" ref={track} role="slider" tabIndex={disabled ? -1 : 0}
        aria-label="Thinking effort" aria-valuemin={0} aria-valuemax={LV.length - 1}
        aria-valuenow={Math.max(idx, 0)} aria-valuetext={name || 'not set'}
        aria-disabled={disabled || undefined} data-effort-pinned={pinned >= 0 ? LV[pinned] : ''}
        onKeyDown={key}
        onPointerDown={(e) => {
          if (disabled || e.button !== 0) return
          e.currentTarget.setPointerCapture?.(e.pointerId)
          moved.current = false
          setTravelled(false)
          setHeld(null)
          setDrag(at(e))
          e.preventDefault()
          e.currentTarget.focus()
        }}
        onPointerMove={(e) => {
          if (disabled) return
          const i = at(e)
          if (drag !== null) { if (i !== drag) { moved.current = true; setTravelled(true); setDrag(i) } } else setHover(i)
        }}
        onPointerLeave={() => setHover(null)}
        onPointerUp={(e) => {
          if (drag === null) return
          const i = at(e)
          e.currentTarget.releasePointerCapture?.(e.pointerId)
          setDrag(null)
          setTravelled(false)
          setHeld(i)
          if (i === pinned && !moved.current) onSet('')
          else if (i !== pinned) onSet(LV[i]!)
        }}
        onPointerCancel={() => setDrag(null)}>
        <span className="effort-bar-rail" />
        {shown >= 0 && <span className="effort-bar-fill" style={{ width: `calc(20px + (100% - 20px) * ${(LV.length > 1 ? shown / (LV.length - 1) : 0)})` }} />}
        {LV.map((l, i) => (
          <span key={l} className={'effort-bar-dot' + (i < shown ? ' below' : '')} style={{ left: pct(i) }} data-level={l} />
        ))}
        {shown >= 0 && <span className="effort-bar-pip" style={{ left: pct(shown) }} data-level={LV[shown]} />}
      </div>
    </div>
  )
}
