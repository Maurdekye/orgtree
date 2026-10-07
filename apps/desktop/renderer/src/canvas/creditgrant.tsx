import { CreditBarPaint, CreditBarStats, creditBarBackground } from './creditbarpaint'
import { SetBlock } from './settingskit'
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

type Gesture = { from: number; value: number; raw: number; scale: number; pointer?: number; x?: number; moved?: boolean }

export function CreditGrant({ node, map, tree, op }: {
  node: CanvasNode; map: Map<string, CanvasNode>; tree: TreePayload; op: OpFn
}) {
  const label = useId()
  const track = useRef<HTMLDivElement>(null)
  const gesture = useRef<Gesture | null>(null)
  const frame = useRef<number | null>(null)
  const saving = useRef(false)
  const [draft, setDraft] = useState<{value: number; scale: number} | null>(null)
  const [width, setWidth] = useState(400)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const [accepted, setAccepted] = useState<{ from: number; value: number } | null>(null)
  const server = node.grant ?? 0
  useEffect(() => { if (accepted && accepted.from !== server) setAccepted(null) }, [server, accepted])
  useEffect(() => {
    const el = track.current!
    const observer = new ResizeObserver(() => setWidth(el.clientWidth))
    observer.observe(el); setWidth(el.clientWidth)
    return () => observer.disconnect()
  }, [])
  const grant = accepted?.from === server ? accepted.value : server
  const limits = grantLimits(node, map, tree)
  const min = Math.ceil(limits.min - 1e-9), max = Math.floor(limits.max + 1e-9)
  const disabled = pending || limits.unavailable || min > max || (min === max && grant === min)
  const seat = node.seat ?? 0
  const baseScale = Math.min(Math.max(grant, max), Math.max(4, grant * 2))
  const value = draft?.value ?? grant
  const scale = Math.max(value, draft?.scale ?? baseScale)
  const pxc = width / Math.max(1, seat + scale)
  const length = Math.max(6, (seat + value) * pxc)
  const clamp = (n: number) => Math.max(min, Math.min(max, Math.round(n)))
  const latest = useRef({ min, max, seat, baseScale, grant, unavailable: limits.unavailable })
  latest.current = { min, max, seat, baseScale, grant, unavailable: limits.unavailable }
  const stop = () => {
    if (frame.current !== null) track.current?.ownerDocument.defaultView?.cancelAnimationFrame(frame.current)
    frame.current = null
  }
  useEffect(() => () => { stop(); gesture.current = null }, [])
  const cancel = () => { stop(); gesture.current = null; setDraft(null) }
  const publish = (g: Gesture) => {
    const l = latest.current
    g.raw = Math.max(l.min, Math.min(l.max, g.raw))
    g.value = Math.max(l.min, Math.min(l.max, Math.round(g.raw)))
    setDraft({value: g.value, scale: g.scale})
  }
  // The pointer can stay at the edge: time, not event frequency, grows the range.
  const expand = () => {
    const view = track.current!.ownerDocument.defaultView!
    let previous = view.performance.now()
    const tick = (now: number) => {
      frame.current = null
      const g = gesture.current, l = latest.current
      if (!g || g.pointer === undefined) return
      if (g.from !== l.grant || l.unavailable) { cancel(); setError('Credits changed while editing. Try again.'); return }
      const rect = track.current!.getBoundingClientRect()
      const edge = ((g.x ?? rect.left) - rect.left) / rect.width
      const dt = Math.min(0.05, (now - previous) / 1000); previous = now
      if (g.moved && edge > 0.9 && g.value < l.max) {
        const growth = Math.max(4, g.scale) * dt * Math.min(1, (edge - 0.9) / 0.1)
        g.scale = Math.min(l.max, g.scale + growth)
        g.raw += growth; publish(g)
      }
      frame.current = view.requestAnimationFrame(tick)
    }
    frame.current = view.requestAnimationFrame(tick)
  }
  const commit = async () => {
    stop()
    const g = gesture.current; gesture.current = null
    if (!g || saving.current) return
    if (g.value === g.from) { setDraft(null); return }
    if (g.from !== grant) { setDraft(null); setError('Credits changed while editing. Try again.'); return }
    const next = clamp(g.value)
    if (next === grant || min > max || limits.unavailable) { setDraft(null); return }
    saving.current = true; setPending(true); setError('')
    try {
      const result = await op({ op: 'reallocate', node: node.id, delta: next - grant }, { quiet: true })
      setAccepted({ from: server, value: typeof result.grant === 'number' ? result.grant : next })
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { saving.current = false; setPending(false); setDraft(null) }
  }
  const move = (e: PointerEvent<HTMLDivElement>) => {
    const g = gesture.current
    if (!g || g.pointer !== e.pointerId) return
    const dx = e.clientX - (g.x ?? e.clientX)
    if (!g.moved && Math.abs(dx) < 6) return
    g.moved = true; g.x = e.clientX
    g.raw += dx / track.current!.clientWidth * (seat + g.scale)
    if (dx < 0) g.scale = Math.max(baseScale, Math.min(g.scale, Math.max(min, g.raw) * 1.2))
    g.scale = Math.min(max, Math.max(g.scale, g.raw))
    publish(g)
  }
  const key = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancel(); return }
    if (disabled || !['ArrowLeft', 'ArrowDown', 'ArrowRight', 'ArrowUp', 'Home', 'End'].includes(e.key)) return
    e.preventDefault(); e.stopPropagation(); setError('')
    const g = gesture.current ?? { from: grant, value: grant, raw: grant, scale: baseScale }
    g.raw = clamp(e.key === 'Home' ? min : e.key === 'End' ? max
      : g.value + (e.key === 'ArrowRight' || e.key === 'ArrowUp' ? 1 : -1))
    g.scale = Math.min(max, Math.max(baseScale, g.raw * 1.2))
    gesture.current = g; publish(g)
  }
  return <SetBlock label={<span id={label}>Credit grant</span>}><section className="credit-grant" aria-labelledby={label}>
    <CreditBarStats seat={seat} cur={value} committed={limits.min} delta={draft ? value - grant : 0} />
    <div className="credit-grant-track" ref={track}>
      <div role="slider" aria-label="Credit grant" aria-valuemin={min} aria-valuemax={Math.max(min, max)}
        aria-valuenow={value} aria-valuetext={`${fmtCredits(value)} credits`} aria-disabled={disabled}
        aria-describedby={`${label}-hint`} tabIndex={0} className="credit-grant-drag"
        style={{ width: length }}
        onPointerDown={e => {
          if (disabled || saving.current || e.button !== 0) return
          e.preventDefault(); e.stopPropagation(); e.currentTarget.focus(); setError('')
          gesture.current = { from: grant, value: grant, raw: grant, scale: baseScale, x: e.clientX, pointer: e.pointerId }
          e.currentTarget.setPointerCapture(e.pointerId); expand()
        }} onPointerMove={move} onPointerUp={() => void commit()}
        onPointerCancel={cancel} onLostPointerCapture={() => { if (!saving.current) cancel() }}
        onKeyDown={key} onKeyUp={e => {
          if (['ArrowLeft', 'ArrowDown', 'ArrowRight', 'ArrowUp', 'Home', 'End'].includes(e.key)) void commit()
        }} onBlur={() => { if (gesture.current?.pointer === undefined) void commit() }}>
        <div className="cbar" style={{height: length, transform: `translateX(${length}px) rotate(90deg)`, background: creditBarBackground(pxc)}}>
          <CreditBarPaint seat={seat} cur={value} committed={limits.min} pxc={pxc}
            segments={node.children.filter(c => c.state !== 'archived').map(c => ({seat: c.seat ?? 0, grant: c.grant ?? 0}))} />
        </div>
      </div>
    </div>
    <div className="credit-grant-limits"><span>Minimum {fmtCredits(min)}</span><span>Scale {fmtCredits(scale)} · limit {fmtCredits(max)}</span></div>
    <div className="set-hint" id={`${label}-hint`}>{pending ? 'Saving…' : 'Drag the bar or use arrow keys; hold near the right edge to add more.'}</div>
    {limits.unavailable && <div className="set-hint">Waiting for the superior’s credit details.</div>}
    {error && <div className="ask-warn" role="alert">{error}</div>}
  </section></SetBlock>
}
