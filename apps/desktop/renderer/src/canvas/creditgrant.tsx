import { useEffect, useId, useRef, useState } from 'react'
import type { KeyboardEvent, PointerEvent } from 'react'
import type { TreePayload } from '../types'
import { fmtCredits, USER } from './shared'
import type { CanvasNode, OpFn } from './shared'

/** User reallocation headroom. Ancestor raises are whole credits (ensure_room),
 * so propagate capacity from the root down rather than simply adding free. */
export function grantLimits(node: CanvasNode, map: Map<string, CanvasNode>,
  tree: Pick<TreePayload, 'max_top_grant' | 'cascade_alloc'>) {
  const grant = node.grant ?? 0
  const min = Math.max(0, grant - (node.free ?? 0))
  const chain: CanvasNode[] = []
  const seen = new Set([node.id])
  let parent = node.parent
  while (parent && parent !== USER) {
    const n = map.get(parent)
    if (!n || seen.has(parent) || !Number.isFinite(n.free) || !Number.isFinite(n.grant))
      return { min, max: grant, unavailable: true }
    seen.add(parent); chain.push(n); parent = n.parent
  }
  if (!chain.length) return { min, max: Math.max(grant, tree.max_top_grant), unavailable: false }
  if (tree.cascade_alloc === false)
    return { min, max: grant + Math.max(0, chain[0].free!), unavailable: false }
  const root = chain[chain.length - 1]
  let extra = Math.max(0, tree.max_top_grant - root.grant!)
  for (const n of chain.reverse()) extra = Math.max(0, n.free! + Math.floor(extra + 1e-9))
  return { min, max: grant + extra, unavailable: false }
}

export function CreditGrant({ node, map, tree, op }: {
  node: CanvasNode; map: Map<string, CanvasNode>; tree: TreePayload; op: OpFn
}) {
  const label = useId()
  const track = useRef<HTMLDivElement>(null)
  const gesture = useRef<{ from: number; value: number; pointer?: number } | null>(null)
  const saving = useRef(false)
  const [draft, setDraft] = useState<number | null>(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const [accepted, setAccepted] = useState<{ from: number; value: number } | null>(null)
  const server = node.grant ?? 0
  useEffect(() => {
    if (accepted && accepted.from !== server) setAccepted(null)
  }, [server, accepted])
  const grant = accepted?.from === server ? accepted.value : server
  const limits = grantLimits(node, map, tree)
  const min = Math.ceil(limits.min - 1e-9)
  const max = Math.floor(limits.max + 1e-9)
  const disabled = pending || limits.unavailable || min > max || (min === max && grant === min)
  const seat = node.seat ?? 0
  const value = draft ?? grant
  const total = Math.max(1, seat + limits.max, seat + value)
  const pct = (n: number) => `${100 * n / total}%`
  const clamp = (n: number) => Math.max(min, Math.min(max, Math.round(n)))
  const cancel = () => { gesture.current = null; setDraft(null) }
  const commit = async () => {
    const g = gesture.current
    gesture.current = null
    if (!g || saving.current) return
    if (g.value === g.from) { setDraft(null); return }
    if (g.from !== grant) {
      setDraft(null); setError('Credits changed while editing. Try again.'); return
    }
    const next = clamp(g.value)
    if (next === grant || min > max || limits.unavailable) { setDraft(null); return }
    saving.current = true; setPending(true); setDraft(next); setError('')
    try {
      const result = await op({ op: 'reallocate', node: node.id, delta: next - grant }, { quiet: true })
      setAccepted({ from: server, value: typeof result.grant === 'number' ? result.grant : next })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      saving.current = false; setPending(false); setDraft(null)
    }
  }
  const move = (e: PointerEvent<HTMLDivElement>) => {
    if (!gesture.current || gesture.current.pointer !== e.pointerId) return
    const rect = track.current!.getBoundingClientRect()
    const next = clamp((e.clientX - rect.left) / rect.width * total - seat)
    gesture.current.value = next; setDraft(next)
  }
  const key = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancel(); return }
    if (disabled || !['ArrowLeft', 'ArrowDown', 'ArrowRight', 'ArrowUp', 'Home', 'End'].includes(e.key)) return
    e.preventDefault(); e.stopPropagation(); setError('')
    const g = gesture.current ?? { from: grant, value: grant }
    g.value = clamp(e.key === 'Home' ? min : e.key === 'End' ? max
      : g.value + (e.key === 'ArrowRight' || e.key === 'ArrowUp' ? 1 : -1))
    gesture.current = g; setDraft(g.value)
  }
  let offset = seat
  return <section className="credit-grant" aria-labelledby={label}>
    <div className="credit-grant-heading"><span id={label}>Credit grant</span>
      <output>{fmtCredits(value)}{pending ? ' · saving…' : ''}</output></div>
    <div className="credit-grant-track" ref={track}>
      <div className="credit-grant-bar" style={{ width: pct(seat + value) }}>
        <div className="credit-grant-committed" style={{ left: `${100 * seat / Math.max(1e-9, seat + value)}%`, width: `${100 * limits.min / Math.max(1e-9, seat + value)}%` }} />
        {/* Use the same child seat/slab order and colours as the canvas bar. */}
      </div>
      <div className="credit-grant-layers" style={{ width: pct(seat + value) }}>
        <div className="credit-grant-seat" style={{ width: `${100 * seat / Math.max(1e-9, seat + value)}%` }} />
        {node.children.filter(c => c.state !== 'archived').map(c => {
          const start = offset; offset += (c.seat ?? 0) + (c.grant ?? 0)
          return <div key={c.id} className="credit-grant-child" style={{
            left: `${100 * start / Math.max(1e-9, seat + value)}%`,
            width: `${100 * ((c.seat ?? 0) + (c.grant ?? 0)) / Math.max(1e-9, seat + value)}%`,
          }}><div className="credit-grant-subseat" style={{
            width: `${100 * (c.seat ?? 0) / Math.max(1e-9, (c.seat ?? 0) + (c.grant ?? 0))}%`,
          }} /></div>
        })}
      </div>
      <span className="credit-grant-floor" style={{ left: pct(seat + limits.min) }} title={`Minimum grant: ${fmtCredits(limits.min)}`} />
      <div role="slider" aria-label="Credit grant" aria-valuemin={min} aria-valuemax={Math.max(min, max)}
        aria-valuenow={value} aria-valuetext={`${fmtCredits(value)} credits`} aria-disabled={disabled}
        aria-describedby={`${label}-hint`} tabIndex={0} className="credit-grant-handle"
        style={{ left: pct(seat + value) }}
        onPointerDown={e => {
          if (disabled || saving.current || e.button !== 0) return
          e.preventDefault(); e.stopPropagation(); e.currentTarget.focus(); setError('')
          gesture.current = { from: grant, value: grant, pointer: e.pointerId }
          e.currentTarget.setPointerCapture(e.pointerId)
        }} onPointerMove={move} onPointerUp={() => void commit()}
        onPointerCancel={cancel} onLostPointerCapture={() => { if (!saving.current) cancel() }}
        onKeyDown={key} onKeyUp={e => {
          if (['ArrowLeft', 'ArrowDown', 'ArrowRight', 'ArrowUp', 'Home', 'End'].includes(e.key)) void commit()
        }} onBlur={() => { if (gesture.current?.pointer === undefined) void commit() }} />
    </div>
    <div className="credit-grant-limits"><span>Minimum {fmtCredits(min)}</span><span>Maximum {fmtCredits(max)}</span></div>
    <div className="dim hub-hint" id={`${label}-hint`}>Seat {fmtCredits(seat)} · committed {fmtCredits(limits.min)} · free {fmtCredits(Math.max(0, value - limits.min))}.
      {' '}Drag the end or use arrow keys. Saves on release without restarting the agent.
      {limits.unavailable && ' Waiting for the superior’s credit details.'}</div>
    {error && <div className="ask-warn" role="alert">{error}</div>}
  </section>
}
