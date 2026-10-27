import { useLayoutEffect, useRef, useState } from 'react'
import type { ReactNode, RefObject } from 'react'
import { createPortal } from 'react-dom'
import { NODE_H, NODE_W } from './shared'
import type { Pt } from './shared'

/** The mini-card name sits above neighbouring cards, outside their stacking
 * contexts. Only pointer/focus leave animates out; a zoom change or the card's
 * own desk removes it immediately. Agents and projects use the same presentation
 * (user 2026-10-19). Desks open elsewhere, pinned or popped out, leave it alone:
 * without it the name fell back into the hovered card, which mini hover drops
 * below its neighbours, and a pinned desk sits in the pin layer above the whole
 * world anyway (USER 2026-10-27 "nodes render overtop the hover names"; this
 * replaces the 4.4.0 desk suppression of the plate, 0a47651). */
export function useFarZoomReveal(eligible: boolean, wanted: boolean) {
  wanted = wanted && eligible
  const [mounted, setMounted] = useState(false)
  const [on, setOn] = useState(false)
  const ref = useRef<HTMLSpanElement>(null)
  useLayoutEffect(() => {
    if (!eligible) {
      setMounted(false)
      setOn(false)
      return
    }
    if (wanted) {
      setMounted(true)
      void ref.current?.offsetWidth // lay out the resting look before the lift/fade
      setOn(true)
      return
    }
    setOn(false)
    const timer = setTimeout(() => setMounted(false), 260)
    return () => clearTimeout(timer)
  }, [wanted, eligible])
  return { visible: eligible && (wanted || mounted), on: on && wanted, ref }
}

export function FarZoomName({ reveal, cardRef, pos, name, icon }: {
  reveal: ReturnType<typeof useFarZoomReveal>
  cardRef: RefObject<HTMLDivElement | null>
  pos: Pt
  name: string
  icon: ReactNode
}) {
  const parent = cardRef.current?.parentElement
  return reveal.visible && parent ? createPortal(
    <span ref={reveal.ref} className={'sq-far-ghost' + (reveal.on ? ' on' : '')} aria-hidden="true"
      style={{ left: pos.x, top: pos.y, width: NODE_W, height: NODE_H }}>
      <span className="sq-far-tier"><span className="sq-far-scaler">
        {icon}<span className="sq-far-name">{name}</span>
      </span></span>
    </span>, parent) : null
}
