import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { NavigationMention } from '../shell/mentionnavigation'
import { RefMdBody } from './refmd'
import { md } from './shared'
import type { RefWorld, ResolvedRef } from './reflinks'

let current: { org: string; mention: NavigationMention; seq: number } | null = null
let seq = 0
const listeners = new Set<() => void>()
export function requestMentionLanding(org: string, mention: NavigationMention): void {
  current = { org, mention, seq: ++seq }
  for (const listener of listeners) listener()
}

/** Prefer the original prose. A retained excerpt also gives an edited ticket
 * a truthful destination when the original mention no longer exists in it. */
export function MentionLanding({ org, kind, id, refs }: {
  org: string; kind: 'mail' | 'work'; id: string
  refs?: { world: RefWorld; onOpen?: (ref: ResolvedRef) => void }
}) {
  const [, update] = useState(0)
  const anchor = useRef<HTMLDivElement>(null)
  const [found, setFound] = useState(false)
  useEffect(() => {
    const listener = () => update(n => n + 1)
    listeners.add(listener)
    listener()
    return () => { listeners.delete(listener) }
  }, [])
  const landing = current?.org === org && current.mention.target.kind === kind
    && (kind === 'mail' ? current.mention.target.id : current.mention.target.item) === id ? current : null
  useLayoutEffect(() => {
    setFound(false)
    if (!landing) return
    let target: HTMLElement | null = null
    const frame = requestAnimationFrame(() => {
      const root = anchor.current?.closest('.mailer-read')
      const excerpt = landing.mention.blurb.replace(/^…|…$/g, '').replace(/\s+/g, ' ').trim()
      target = [...root?.querySelectorAll<HTMLElement>('p, li, blockquote') ?? []]
        .filter(el => !anchor.current?.contains(el))
        .find(el => (el.textContent ?? '').replace(/\s+/g, ' ').includes(excerpt)) ?? null
      if (target) { target.classList.add('mention-navigation-highlight'); setFound(true) }
      const destination = target ?? anchor.current
      destination?.scrollIntoView({ block: 'center' })
    })
    return () => { cancelAnimationFrame(frame); target?.classList.remove('mention-navigation-highlight') }
  }, [landing?.seq, org, kind, id])
  return <div ref={anchor} hidden={!landing || found} className="mention-navigation-highlight mention-landing">
    {landing && <><div className="dim">Recorded @user mention · {new Date(landing.mention.at).toLocaleString()}</div>
      <RefMdBody className="md" html={md(landing.mention.blurb)} world={refs?.world} onOpen={refs?.onOpen} /></>}
  </div>
}
