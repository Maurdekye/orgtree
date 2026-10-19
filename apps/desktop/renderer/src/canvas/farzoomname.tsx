import { useLayoutEffect, useRef, useState } from 'react'
import type { ReactNode, RefObject } from 'react'
import { createPortal } from 'react-dom'
import { NODE_H, NODE_W } from './shared'
import type { Pt } from './shared'

/** The mini-card name sits above neighbouring cards, outside their stacking
 * contexts. Only pointer/focus leave animates out; zoom/desk changes remove it
 * immediately. Agents and projects use the same presentation (user 2026-10-19). */
export function useFarZoomReveal(eligible: boolean, wanted: boolean) {
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
