import type { ReactNode } from 'react'
import { fmtCredits } from './shared'

export interface CreditPaintProps {
  seat: number; cur: number; committed: number; pxc: number
  segments: { seat: number; grant: number }[]; draftMode?: boolean
}
export function creditBarBackground(pxc: number) {
  const rung = (5 * pxc >= 4 ? 5 : 25) * pxc
  return `repeating-linear-gradient(to top, rgba(255,255,255,.07) 0, rgba(255,255,255,.07) 1px, transparent 1px, transparent ${rung}px), var(--input)`
}
// Both orientations render these exact layers; the settings bar rotates the
// canvas paint, including its gradients, corner shapes, ruler and borders.
export function CreditBarPaint({seat, cur, committed, pxc, segments, draftMode}: CreditPaintProps) {
  const seatLen = seat * pxc
  return (
<div className="cbar-clip">
        {/* corner rule (user ruling): square corners ONLY at the seat↔alloc
            junction — the fill's bottom is square iff a seat sits below it,
            and the seat's top is rounded iff no alloc sits above it */}
        <div className={'cbar-fill' + (seatLen > 0 ? '' : ' alone')} style={{
          bottom: seatLen,
          height: draftMode ? cur * pxc : committed * pxc,
        }} />
        {/* the fill is a stack of the children's holdings, one slab per hire —
            each child's SEAT is the darker band at its slab's foot (no divider
            inside a slab; the wash alone splits seat from grant). 1px grey
            hairlines part the own seat from the slabs, and slab from slab. */}
        {(() => {
          let cum = 0
          const out: ReactNode[] = []
          segments.forEach((s, i) => {
            out.push(<div key={'s' + i} className="cbar-subseat"
              style={{ bottom: seatLen + cum * pxc, height: s.seat * pxc }} />)
            cum += s.seat + s.grant
            if (i < segments.length - 1) out.push(<div key={'d' + i}
              className="cbar-div" style={{ bottom: seatLen + cum * pxc }} />)
          })
          return out
        })()}
        {seat > 0 &&
          <div className={'cbar-seat'
            + ((draftMode ? cur : committed) > 0 ? '' : ' crown')}
            style={{ height: seatLen }} />}
        {seat > 0 && cur > 0 && <div className="cbar-div" style={{ bottom: seatLen }} />}
      </div>
  )
}

export function CreditBarStats({seat, cur, grant = cur, committed, delta = 0, draftMode, baseline}: {
  seat: number; cur: number; grant?: number; committed: number; delta?: number; draftMode?: boolean; baseline?: number
}) {
  return (
<div className="cbar-tip">
        {draftMode && baseline != null ? (
          /* the counter-offer tip: what is offered, vs what the agent holds */
          <>
            <div>offer <b className="n-fill">{fmtCredits(grant)}</b>
              {grant !== baseline && <span className={grant < baseline ? 'n-down' : 'dim'}>
                {' '}({grant > baseline ? '+' : ''}{fmtCredits(grant - baseline)})</span>}
            </div>
            <div className="dim">now <b>{fmtCredits(baseline)}</b></div>
          </>
        ) : draftMode ? (
          <>
            <div>grant <b className="n-fill">{fmtCredits(grant)}</b></div>
            <div className="dim">seat <b className="n-seat">{fmtCredits(seat)}</b></div>
          </>
        ) : (
          <>
            <div>grant <b className="n-fill">{fmtCredits(cur)}</b>{delta !== 0 && <span className="dim"> ({delta > 0 ? '+' : ''}{fmtCredits(delta)})</span>}</div>
            <div>alloc <b className="n-fill">{fmtCredits(committed)}</b></div>
            <div>free <b className="n-free">{fmtCredits(cur - committed)}</b></div>
            <div className="dim">seat <b className="n-seat">{fmtCredits(seat)}</b></div>
          </>
        )}
      </div>
  )
}
