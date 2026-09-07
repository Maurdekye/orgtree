import { openLightboxIfEligibleImage } from './canvas/lightbox'
import { copyCodeFromEvent } from './canvas/shared'
import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { ReactNode, SyntheticEvent } from 'react'
import { createPortal } from 'react-dom'
import { isMobile } from './mobile'
import { initiatingDocument, keepWorking, noteActionDocument, openSurfaces, pendingRestart, registerWindow, reloadWindows, returnWindows, subscribeWindows, windowRevision } from './windowlife'

interface SurfaceContextValue {
  document: Document
  overlays: HTMLElement
  detached: boolean
  open: () => void
  redock: () => void
  error: string
}
const SurfaceContext = createContext<SurfaceContextValue | null>(null)
export const CurrentOrg = createContext<string | null>(null)
export const useCurrentOrg = () => useContext(CurrentOrg)
export const useSurface = () => useContext(SurfaceContext)
export const useSurfaceDocument = () => useSurface()?.document ?? document
export const useOverlayRoot = () => useSurface()?.overlays ?? document.body
const stop = (e: SyntheticEvent) => e.stopPropagation()
// Native document ownership and React propagation are DIFFERENT boundaries.
// This helper also belongs on an ancestor capture handler, before any action.
export function foreignSurfaceEvent(e: SyntheticEvent): boolean {
  return (e.target as Node | null)?.ownerDocument !== (e.currentTarget as Node).ownerDocument
}

export function RestartNotice() {
  useSyncExternalStore(subscribeWindows, windowRevision)
  const r = pendingRestart()
  if (!r) return null
  return <div className="popout-restart" role="status">
    <span>The backend restarted. Reloading can discard unsaved forms.</span>
    {!r.deferred && <button onClick={keepWorking}>Keep working</button>}
    <button onClick={reloadWindows}>Reload now</button>
  </div>
}

/** Shared notifications contain no form state; duplicating their presentation
 * lets a request's asynchronous error/undo reach the window it came from. */
export function WindowMirrors({ children }: { children: ReactNode }) {
  useSyncExternalStore(subscribeWindows, windowRevision)
  return <>{[...new Set(openSurfaces().map((s) => s.window.document))].map((doc, i) =>
    createPortal(<div onClick={stop} onPointerDown={stop}>{children}</div>, doc.body, String(i)))}</>
}

export function useOrgTransition(slug: string | null, commit: (slug: string | null) => void, base: string) {
  const current = useRef({ slug, commit, base }); current.current = { slug, commit, base }
  const [pending, setPending] = useState<{ target: string | null } | null>(null)
  const [request] = useState(() => (target: string | null) => {
    const c = current.current
    if (target === c.slug) return
    if (openSurfaces().some((s) => s.org === c.slug)) {
      // popstate has already changed the URL; keep URL and callbacks on the
      // current org until the user explicitly commits the transition.
      window.history.replaceState(null, '', c.base + (c.slug ? `/o/${c.slug}` : '/'))
      setPending({ target }); return
    }
    c.commit(target)
  })
  const prompt = pending && <div className="overlay popout-switch" role="dialog" aria-label="Switch organizations">
    <div className="settings" onClick={stop}>
      <h3>Return your windows before switching?</h3>
      <p>Continuing closes this organization's windows. Unsent messages are kept; unsaved forms can be lost.</p>
      <button onClick={() => { returnWindows(slug ?? undefined); setPending(null) }}>Return windows</button>
      <button onClick={() => setPending(null)}>Cancel</button>
      <button onClick={() => { returnWindows(slug ?? undefined); setPending(null); current.current.commit(pending.target) }}>Continue and switch</button>
    </div>
  </div>
  return { request, prompt: <>{prompt}<WindowMirrors>{prompt}</WindowMirrors></> }
}

export function PopoutButton() {
  const s = useSurface()
  if (!s || isMobile) return null
  return <button type="button" className="popout-button"
    title={s.detached ? 'Return to main window' : 'Open in new window'}
    aria-label={s.detached ? 'Return to main window' : 'Open in new window'}
    onPointerDown={stop} onClick={(e) => { e.stopPropagation(); s.detached ? s.redock() : s.open() }}>
    {s.detached ? '↙' : '↗'}
  </button>
}

/** Linked sheets load after adoption. An unstyled viewport can clamp a valid
 * saved scroll to zero; retry once its real styles and React layout are ready.
 * Any user input cancels the retry so a late sheet never undoes their action. */
function restoreWhenStyled(frame: Window, current: () => boolean, restore: () => void, settled: () => void, failed: () => void) {
  const doc = frame.document
  let ended = false, untouched = true, raf: number | undefined
  const input = () => { untouched = false; settled() }
  const cleanup = () => {
    ended = true
    if (raf !== undefined) frame.cancelAnimationFrame(raf)
    doc.removeEventListener('load', ready, true); doc.removeEventListener('error', error, true)
    for (const event of ['pointerdown', 'keydown', 'wheel', 'beforeinput']) doc.removeEventListener(event, input, true)
  }
  const ready = () => {
    if (ended || !current()) return
    const links = [...doc.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')]
    if (links.some(link => !link.disabled && !link.sheet)) return
    if (raf !== undefined) frame.cancelAnimationFrame(raf)
    raf = frame.requestAnimationFrame(() => {
      if (ended || !current()) return
      try { if (untouched) restore(); settled() } catch { cleanup(); failed(); return }
      cleanup()
    })
  }
  const error = (event: Event) => {
    if (!ended && current() && (event.target as Element | null)?.matches?.('link[rel="stylesheet"]')) {
      cleanup(); failed()
    }
  }
  doc.addEventListener('load', ready, true); doc.addEventListener('error', error, true)
  // Capture is required: the surface's React boundary stops bubbling input.
  for (const event of ['pointerdown', 'keydown', 'wheel', 'beforeinput']) doc.addEventListener(event, input, true)
  ready()
  return cleanup
}

function preservePosition(root: HTMLElement) {
  const scrolling = [root, ...root.querySelectorAll<HTMLElement>('*')]
    .filter((e) => e.scrollTop || e.scrollLeft).map((e) => [e, e.scrollLeft, e.scrollTop] as const)
  const active = root.ownerDocument.activeElement as HTMLInputElement | null
  const focused = active && root.contains(active) ? active : null
  let selection: [number | null, number | null, 'forward' | 'backward' | 'none' | null] | null = null
  try { if (focused) selection = [focused.selectionStart, focused.selectionEnd, focused.selectionDirection] } catch { /* not text input */ }
  return () => {
    if (focused?.isConnected) {
      focused.focus({ preventScroll: true })
      if (selection && selection[0] !== null && selection[1] !== null) {
        try { focused.setSelectionRange(selection[0], selection[1], selection[2] ?? undefined) } catch { /* not text */ }
      }
    }
    for (const [el, left, top] of scrolling) { el.scrollLeft = left; el.scrollTop = top }
  }
}

// One compact notice stack per owning document; notices never occupy the
// departed surface's place in the application's layout.
const noticeHosts = new WeakMap<Document, HTMLElement>()
function DetachedNotice({ home, children }: { home: Document; children: ReactNode }) {
  let host = noticeHosts.get(home)
  if (!host) {
    host = home.createElement('div'); host.className = 'popout-notices'
    noticeHosts.set(home, host)
  }
  const target = host
  useLayoutEffect(() => {
    if (!target.isConnected) home.body.appendChild(target)
    return () => {
      // React removes this portal's children during the same commit.
      queueMicrotask(() => { if (!target.childElementCount) target.remove() })
    }
  }, [home, target])
  return createPortal(<div className="popout-placeholder" onPointerDown={stop} onClick={stop}>{children}</div>, target)
}

/** Stable portal target, physically adopted between documents. React never
 * receives a different target and never owns/removes the hand-built shell. */
export function MovableSurface({ kind, title, org = null, editable = true, children,
  anchor, onDetached, flush }: {
  kind: string; title: ReactNode; org?: string | null; editable?: boolean
  children: ReactNode; anchor?: HTMLElement | null
  onDetached?: (detached: boolean) => void; flush?: () => void
}) {
  const parent = useSurface()
  const placeholder = useRef<HTMLDivElement>(null)
  const [parts] = useState(() => {
    const container = document.createElement('div'); container.className = 'movable-surface'
    const content = document.createElement('div'); content.className = 'movable-content'
    const overlays = document.createElement('div'); overlays.className = 'movable-overlays'
    container.append(content, overlays)
    return { container, content, overlays }
  })
  const [owner, setOwner] = useState<Document>(() => parent?.document ?? initiatingDocument())
  const [detached, setDetached] = useState(false)
  const [ready, setReady] = useState(false)
  const [error, setError] = useState('')
  const child = useRef<Window | null>(null)
  const pendingRestore = useRef<(() => void) | null>(null)
  const cleanups = useRef<(() => void)[]>([])
  const epoch = useRef(0)
  const latest = useRef({ anchor, parent, onDetached, flush, org, title })
  latest.current = { anchor, parent, onDetached, flush, org, title }
  const fallback = useRef<HTMLElement | null>(null)
  const initialOwner = useRef(owner)

  const destination = () => {
    const a = latest.current.anchor === undefined ? placeholder.current : latest.current.anchor
    if (a?.isConnected) return a
    const overlay = latest.current.parent?.overlays
    if (overlay?.isConnected) return overlay
    if (!fallback.current) {
      fallback.current = document.createElement('div')
      fallback.current.className = 'popout-recovery'
      document.body.appendChild(fallback.current)
    }
    return fallback.current
  }
  const redock = () => {
    const restore = pendingRestore.current ?? preservePosition(parts.container)
    pendingRestore.current = null
    epoch.current++
    const w = child.current; child.current = null
    for (const fn of cleanups.current.splice(0).reverse()) { try { fn() } catch { /* cleanup is idempotent */ } }
    destination().appendChild(parts.container)
    initialOwner.current = document
    parts.container.classList.remove('detached')
    setOwner(parts.container.ownerDocument); setDetached(false)
    latest.current.onDetached?.(false)
    restore()
    try { if (w && !w.closed) w.close() } catch { /* user navigated */ }
  }

  const open = () => {
    if (child.current && !child.current.closed) { child.current.focus(); return }
    const transaction = ++epoch.current
    const restore = preservePosition(parts.container)
    let w: Window | null = null
    try {
      // Opening MUST be inside the initiating click, before any await.
      w = owner.defaultView!.open('', '_blank', 'popup,width=900,height=760')
      if (!w) throw new Error('The browser blocked this window. Allow pop-ups for this site and try again.')
      child.current = w
      const d = w.document
      const onGone = () => { if (epoch.current === transaction) redock() }
      w.addEventListener('pagehide', onGone)
      cleanups.current.push(() => w?.removeEventListener('pagehide', onGone))
      const poll = window.setInterval(() => { if (w?.closed) onGone() }, 250)
      cleanups.current.push(() => window.clearInterval(poll))
      d.title = typeof title === 'string' ? `${title} · Orgtree` : 'Orgtree'
      const base = d.createElement('base'); base.href = document.baseURI; d.head.appendChild(base)
      const clones = new Map<Element, Element>()
      const syncStyles = () => {
        d.documentElement.className = document.documentElement.className
        d.documentElement.style.cssText = document.documentElement.style.cssText
        for (const original of document.head.querySelectorAll('style, link[rel="stylesheet"]')) {
          const previous = clones.get(original)
          const copy = original.cloneNode(true) as Element
          if (original.tagName === 'STYLE') {
            // Emotion and other CSS-in-JS writers use insertRule, which does
            // not change textContent and does not notify MutationObserver.
            try {
              const rules = (original as HTMLStyleElement).sheet?.cssRules
              if (rules?.length) copy.textContent = [...rules].map((rule) => rule.cssText).join('\n')
            } catch { /* inaccessible styles retain the ordinary clone */ }
          }
          if (!previous || !previous.isEqualNode(copy)) {
            if (previous) previous.replaceWith(copy)
            else d.head.appendChild(copy)
            clones.set(original, copy)
          }
        }
        for (const [original, copy] of clones) if (!document.head.contains(original) || !original.matches('style, link[rel="stylesheet"]')) { copy.remove(); clones.delete(original) }
        // Match the complete source order too: new sheets may be inserted
        // before existing ones, or existing sheets may be moved in the head.
        const sourceOrder = [...document.head.querySelectorAll('style, link[rel="stylesheet"]')]
        let next: Element | null = null
        for (let i = sourceOrder.length - 1; i >= 0; i--) {
          const copy = clones.get(sourceOrder[i]!)!
          if (copy.nextElementSibling !== next) d.head.insertBefore(copy, next)
          next = copy
        }
      }
      syncStyles()
      const observer = new MutationObserver(() => {
        if (transaction !== epoch.current) return
        try { syncStyles() } catch { setError('Window styling failed. Your surface was returned.'); redock() }
      })
      observer.observe(document.head, { childList: true, subtree: true, characterData: true, attributes: true })
      observer.observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'class'] })
      cleanups.current.push(() => observer.disconnect())
      const cssom = window.setInterval(() => {
        if (transaction !== epoch.current) return
        try { syncStyles() } catch { setError('Window styling failed. Your surface was returned.'); redock() }
      }, 500)
      cleanups.current.push(() => window.clearInterval(cssom))
      d.body.className = 'popout-document'
      const mount = d.createElement('div'); mount.className = 'popout-mount'; d.body.appendChild(mount)
      const note = () => noteActionDocument(d)
      const documentClick = (e: MouseEvent) => {
        copyCodeFromEvent(e); openLightboxIfEligibleImage(e)
      }
      d.addEventListener('pointerdown', note, true); d.addEventListener('keydown', note, true)
      d.addEventListener('click', documentClick, true)
      cleanups.current.push(() => { d.removeEventListener('pointerdown', note, true); d.removeEventListener('keydown', note, true); d.removeEventListener('click', documentClick, true) })
      if (w.closed || transaction !== epoch.current) throw new Error('The new window closed before it was ready.')
      // COMMIT POINT. Even a partially successful append that THEN throws is
      // rolled back below, by adopting the SAME container into its anchor.
      mount.appendChild(parts.container)
      if (w.closed || parts.container.ownerDocument !== d || !mount.contains(parts.container)) throw new Error('The surface could not enter the new window.')
      parts.container.classList.add('detached')
      cleanups.current.push(registerWindow({ id: `${kind}:${transaction}:${Math.random()}`, kind, org,
        editable, window: w, redock, flush: () => latest.current.flush?.() }))
      setOwner(d); setDetached(true); setError(''); latest.current.onDetached?.(true)
      restore(); w.focus()
      pendingRestore.current = restore
      cleanups.current.push(restoreWhenStyled(w, () => epoch.current === transaction && !w!.closed, restore, () => { pendingRestore.current = null },
        () => { setError('Window styling failed. Your surface was returned.'); redock() }))
    } catch (e) {
      redock()
      try { w?.close() } catch { /* inaccessible */ }
      setError(e instanceof Error ? e.message : 'Could not open a window. Your surface was returned.')
    }
  }

  useLayoutEffect(() => {
    if (!child.current) {
      const a = (anchor === undefined ? placeholder.current : anchor) ?? destination()
      if (a) {
        // Modal requests originating in a child open there, even if their
        // React state is owned at App/OrgCanvas level.
        const target = anchor === undefined && initialOwner.current !== document && !parent
          && !initialOwner.current.defaultView?.closed ? initialOwner.current.body : a
        if (parts.container.parentElement !== target) target.appendChild(parts.container)
        setOwner(parts.container.ownerDocument)
        // Descendant layout effects (notably the composer auto-height) must
        // first run in a connected document, not in a detached zero-size box.
        setReady(true)
      }
    }
  }, [anchor, parent?.document, parts])
  useEffect(() => () => {
    epoch.current++
    for (const fn of cleanups.current.splice(0).reverse()) { try { fn() } catch { /* disposed */ } }
    try { child.current?.close() } catch { /* disposed */ }
    child.current = null; parts.container.remove(); fallback.current?.remove()
  }, [parts])
  useEffect(() => {
    // App-owned dialogs can be displayed in a child's document without
    // owning that browser window. Return them before their parent unloads.
    if (owner === document || detached || parent) return
    const w = owner.defaultView
    if (!w) return
    const onGone = () => redock()
    w.addEventListener('pagehide', onGone)
    const unregister = registerWindow({ id: `hosted:${kind}:${Math.random()}`, kind, org,
      editable, window: w, redock, flush: () => latest.current.flush?.() })
    return () => { w.removeEventListener('pagehide', onGone); unregister() }
  }, [owner, detached, parent, kind, org, editable])
  return <>
    <div ref={placeholder} className="movable-anchor">
      {detached && !anchor && <DetachedNotice home={placeholder.current?.ownerDocument ?? initialOwner.current}>
        <span>{title} is in another window.</span>
        <button onClick={() => child.current?.focus()}>Show window</button>
        <button onClick={redock}>Return here</button>
      </DetachedNotice>}
    </div>
    {ready && createPortal(<SurfaceContext.Provider value={{ document: owner, overlays: parts.overlays, detached, open, redock, error }}>
      <div className="movable-events" onPointerDown={detached ? stop : undefined}
        onPointerMove={detached ? stop : undefined} onPointerUp={detached ? stop : undefined}
        onPointerCancel={detached ? stop : undefined} onClick={detached ? stop : undefined}
        onDoubleClick={detached ? stop : undefined} onWheel={detached ? stop : undefined}
        onKeyDown={detached ? stop : undefined} onKeyUp={detached ? stop : undefined}
        onDragStart={detached ? stop : undefined} onDragOver={detached ? stop : undefined}
        onDrop={detached ? stop : undefined} onContextMenu={detached ? stop : undefined}>
        {detached && <><div className="popout-dependency">This window uses the main Orgtree tab. <button onClick={redock}>Return to main window</button></div><RestartNotice /></>}
        {error && <div role="alert" className="popout-error">{error}</div>}
        {children}
      </div>
    </SurfaceContext.Provider>, parts.content)}
  </>
}
