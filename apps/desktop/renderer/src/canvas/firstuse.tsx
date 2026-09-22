import { useEffect, useId, useMemo, useState, useSyncExternalStore } from 'react'
import type { RefObject } from 'react'
import { createPortal } from 'react-dom'
import './firstuse.css'

// Creation is the opt-in boundary. An empty or merely first-seen old org is
// NOT evidence that it was just created. This is UI progress, not org policy.
const prefix = 'orgtree-first-use:'
type Progress = { step: 'token' | 'name' | 'hire' | 'message' | 'done'; agent?: string }
const listeners = new Set<() => void>()
const fallback = new Map<string, string>()
function raw(slug: string): string {
  try { return fallback.get(slug) ?? localStorage.getItem(prefix + slug) ?? '' }
  catch { return fallback.get(slug) ?? '' }
}
export function firstUseProgress(slug: string): Progress | null {
  try {
    const p = JSON.parse(raw(slug)) as Progress
    if (!['token', 'name', 'hire', 'message', 'done'].includes(p?.step)) return null
    if (p.step === 'message' && (typeof p.agent !== 'string' || !p.agent)) return null
    return p
  } catch { return null }
}
function save(slug: string, progress: Progress) {
  const value = JSON.stringify(progress)
  if (value === raw(slug)) return
  try { localStorage.setItem(prefix + slug, value); fallback.delete(slug) }
  catch { fallback.set(slug, value) /* usable this session */ }
  for (const listener of listeners) listener()
}
function subscribe(listener: () => void) {
  listeners.add(listener)
  const changed = (e: StorageEvent) => { if (!e.key || e.key.startsWith(prefix)) listener() }
  window.addEventListener('storage', changed)
  return () => { listeners.delete(listener); window.removeEventListener('storage', changed) }
}
export function useFirstUse(slug: string) {
  const value = useSyncExternalStore(subscribe, () => raw(slug), () => '')
  return useMemo(() => firstUseProgress(slug), [slug, value])
}
export function beginFirstUse(slug: string) { if (slug) save(slug, { step: 'token' }) }
export function firstUseToken(slug: string) {
  if (firstUseProgress(slug)?.step === 'token') save(slug, { step: 'name' })
}
export function firstUseName(slug: string, name: string) {
  const step = firstUseProgress(slug)?.step
  if (step === 'name' || step === 'hire') save(slug, { step: name.trim() ? 'hire' : 'name' })
}
export function firstUseCancel(slug: string) {
  const step = firstUseProgress(slug)?.step
  if (step === 'name' || step === 'hire') save(slug, { step: 'token' })
}
export function firstUseHired(slug: string, agent: string) {
  if (agent && firstUseProgress(slug)?.step === 'hire') save(slug, { step: 'message', agent })
}
export function firstUseSent(slug: string, agent: string) {
  const p = firstUseProgress(slug)
  if (p?.step === 'message' && p.agent === agent) save(slug, { step: 'done' })
}

/** The ring and connector follow the REAL control through canvas transforms.
 * No intercepted clicks, synthetic actions, focus changes, or Next buttons.
 * Only the ordinary handlers above advance progress. */
export function FirstUseGuide({ slug, root, hidden = false }: {
  slug: string; root: RefObject<HTMLElement | null>; hidden?: boolean
}) {
  const progress = useFirstUse(slug)
  const id = useId()
  const [anchor, setAnchor] = useState<{ left: number; top: number; width: number; height: number; chat: boolean } | null>(null)
  useEffect(() => {
    if (!progress || progress.step === 'done' || hidden) { setAnchor(null); return }
    let frame = 0, target: HTMLElement | null = null
    const unlabel = () => {
      if (!target) return
      const ids = (target.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(x => x && x !== id)
      if (ids.length) target.setAttribute('aria-describedby', ids.join(' '))
      else target.removeAttribute('aria-describedby')
    }
    const measure = () => {
      const host = root.current
      let nodes: HTMLElement[] = []
      if (host) {
        const step = progress.step
        const selector = step === 'token' ? '[data-first-use="token"]:not(:disabled)'
          : step === 'name' ? '.sq.draft .df-name'
          : step === 'hire' ? '.sq.draft .df-foot .primary'
          : '[data-first-use-chat], [data-first-use-agent]'
        nodes = Array.from(host.querySelectorAll<HTMLElement>(selector))
        if (step === 'message') nodes = nodes.filter(el =>
          (el.dataset.firstUseChat ?? el.dataset.firstUseAgent) === progress.agent)
        // Prefer the actual composer when the hire's normal desk transition
        // has finished; otherwise point at the real agent card to open it.
        if (step === 'message') nodes.sort((a, b) => Number(!!b.dataset.firstUseChat) - Number(!!a.dataset.firstUseChat))
      }
      const next = nodes.find(el => {
        const r = el.getBoundingClientRect(), style = getComputedStyle(el)
        const onscreen = r.width > 0 && r.height > 0 && r.right > 0 && r.bottom > 0
          && r.left < window.innerWidth && r.top < window.innerHeight
          && style.visibility !== 'hidden' && style.display !== 'none'
        if (!onscreen) return false
        // Desk content mounts before the canvas finishes its camera glide.
        // A mounted but fading/inert composer is not yet a usable target.
        for (let parent: HTMLElement | null = el; parent; parent = parent.parentElement) {
          if (parent.inert || Number(getComputedStyle(parent).opacity) < .9) return false
        }
        const x = Math.max(0, Math.min(window.innerWidth - 1, r.left + r.width / 2))
        const y = Math.max(0, Math.min(window.innerHeight - 1, r.top + r.height / 2))
        const hit = document.elementFromPoint(x, y)
        return hit === el || !!(hit && el.contains(hit))
      }) ?? null
      if (next !== target) {
        unlabel(); target = next
        if (target) target.setAttribute('aria-describedby', [target.getAttribute('aria-describedby'), id].filter(Boolean).join(' '))
      }
      const r = target?.getBoundingClientRect()
      const value = r ? { left: r.left, top: r.top, width: r.width, height: r.height, chat: !!target?.dataset.firstUseChat } : null
      setAnchor(old => JSON.stringify(old) === JSON.stringify(value) ? old : value)
      frame = requestAnimationFrame(measure)
    }
    measure()
    return () => { cancelAnimationFrame(frame); unlabel() }
  }, [slug, progress, root, hidden, id])
  if (!progress || progress.step === 'done' || hidden || !anchor) return null
  const step = progress.step
  const number = step === 'token' ? 1 : step === 'name' ? 2 : step === 'hire' ? 3 : 4
  const text = step === 'token' ? 'Click a hire token to choose your first agent.'
    : step === 'name' ? 'Enter a name for your agent.'
    : step === 'hire' ? 'Click Hire to create your agent.'
    : anchor.chat ? `Send ${progress.agent} a message here to begin working together.`
      : `Click ${progress.agent} to open its chat and send your first message.`
  const width = Math.min(280, window.innerWidth - 24)
  const left = Math.max(12, Math.min(window.innerWidth - width - 12, anchor.left))
  const below = anchor.top + anchor.height + 18
  const top = below + 100 < window.innerHeight ? below : Math.max(12, anchor.top - 112)
  return createPortal(<div className="first-use-guide" data-tutorial-step={step}>
    <svg aria-hidden="true"><path d={`M ${left + width / 2} ${top < anchor.top ? top + 90 : top} L ${anchor.left + anchor.width / 2} ${top < anchor.top ? anchor.top : anchor.top + anchor.height}`} /></svg>
    <div className="first-use-ring" aria-hidden="true" style={{ left: anchor.left - 4, top: anchor.top - 4, width: anchor.width + 8, height: anchor.height + 8 }} />
    <div className="first-use-card" style={{ left, top, width }} id={id} role="status" aria-live="polite" aria-atomic="true">
      <span>Getting started · {number} of 4</span><p>{text}</p>
    </div>
  </div>, document.body)
}
