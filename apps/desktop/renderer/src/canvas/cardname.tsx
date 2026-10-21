import { useLayoutEffect, useRef, useState } from 'react'
import type { HTMLAttributes } from 'react'

/** Normal-zoom card names reveal only when hovered and actually clipped.
 * The copy shares the name's offset and ignores pointer input; far-zoom names
 * have their own floating presentation. Agent and project cards use this. */
export function CardName({ text, hovered, layoutKey, ...props }: {
  text: string
  hovered: boolean
  layoutKey?: string
} & HTMLAttributes<HTMLSpanElement>) {
  const ref = useRef<HTMLSpanElement>(null)
  const [at, setAt] = useState<{ left: number; top: number } | null>(null)
  useLayoutEffect(() => {
    const el = ref.current
    setAt(hovered && el && el.scrollWidth > el.clientWidth
      ? { left: el.offsetLeft, top: el.offsetTop } : null)
  }, [hovered, text, layoutKey])
  return <>
    <span {...props} ref={ref} className="name">{text}</span>
    {at && <span className="name-full" data-card-fit-overlay="true" aria-hidden="true" style={at}>{text}</span>}
  </>
}
