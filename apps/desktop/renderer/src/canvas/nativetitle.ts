import { useState } from 'react'
import type { FocusEvent, HTMLAttributes, PointerEvent } from 'react'

/** A native title mutation closes the OS tooltip. Snapshot live facts for the
 * whole hover/focus session; the visible label can continue updating. */
export function useNativeTitle(title: string | undefined, identity = ''):
  Pick<HTMLAttributes<HTMLElement>, 'title' | 'onPointerEnter' | 'onPointerLeave' | 'onFocus' | 'onBlur'> {
  type Session = { identity: string; title: string | undefined; pointer: boolean; focus: boolean }
  const [session, setSession] = useState<Session | null>(null)
  const enter = (kind: 'pointer' | 'focus') => () => setSession(previous => {
    const active = previous?.identity === identity ? previous : null
    return { identity, title: active ? active.title : title,
      pointer: active?.pointer ?? false, focus: active?.focus ?? false, [kind]: true }
  })
  const leave = (kind: 'pointer' | 'focus') => (event: PointerEvent<HTMLElement> | FocusEvent<HTMLElement>) => {
    const related = event.relatedTarget
    if (related && typeof related === 'object' && 'nodeType' in related
        && event.currentTarget.contains(related as Node)) return
    setSession(previous => {
      if (!previous || previous.identity !== identity) return previous
      const next = { ...previous, [kind]: false }
      return next.pointer || next.focus ? next : null
    })
  }
  return { title: session?.identity === identity ? session.title : title,
    onPointerEnter: enter('pointer'), onPointerLeave: leave('pointer'),
    onFocus: enter('focus'), onBlur: leave('focus') }
}
