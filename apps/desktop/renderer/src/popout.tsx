import type { WindowRestore } from './windowlayout'
import { captureWindow, closeSavedWindow, popupFeatures, restoredWindows, useRestoreWindows, windowLayoutKey } from './windowlayout'
import { openLightboxIfEligibleImage } from './canvas/lightbox'
import { copyCodeFromEvent } from './canvas/shared'
import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { MouseEvent as ReactMouseEvent, ReactNode, SyntheticEvent } from 'react'
import { desktop } from './desktop'
import { CloseIcon, MaximizeIcon, MinimizeIcon, RestoreIcon } from './icons'
import type { PopoutWindowState } from '../../../../packages/contracts'
import { createPortal } from 'react-dom'
import { isMobile } from './mobile'
import { initiatingDocument, keepWorking, noteActionDocument, openSurfaces, pendingRestart, registerWindow, reloadWindows, returnWindows, subscribeWindows, windowRevision } from './windowlife'

interface SurfaceContextValue {
  document: Document
  overlays: HTMLElement
  detached: boolean
  /** The frame name this surface's window was opened under: the only handle on
   *  that native window. See popoutRegistry in main/windows.ts. */
  name: string
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

/** Unique per surface INSTANCE, not per surface identity: window.open reuses an
 *  existing window with the same name, and two surfaces must never collide onto
 *  one window. */
let popoutSeq = 0

/** The window controls for a popped-out desk or modal, placed in that surface's
 *  OWN header because the popout window is frameless and has no title bar to
 *  put them in. Renders nothing anywhere else - in the canvas or pinned to the
 *  main window there is no native window of its own to command. The name is
 *  what says WHICH window; see popoutRegistry in main/windows.ts. */
export function PopoutWindowControls() {
  const s = useSurface()
  const detached = !!s?.detached
  const name = s?.name ?? ''
  const [maximized, setMaximized] = useState(false)
  useEffect(() => {
    const bridge = desktop()
    if (!detached || !bridge?.getPopoutState) return
    let alive = true
    void bridge.getPopoutState(name).then(state => { if (alive && state) setMaximized(state.maximized) }).catch(() => {})
    const unsubscribe = bridge.onEvent(event => {
      if (!alive || event.type !== 'popout-state') return
      const state = event.data as PopoutWindowState
      if (state?.name === name) setMaximized(state.maximized)
    })
    return () => { alive = false; unsubscribe() }
  }, [detached, name])
  const bridge = desktop()
  if (!detached || !bridge?.minimizePopout || !bridge.toggleMaximizePopout || !bridge.closePopout) return null
  const act = (run: (name: string) => Promise<void>) => (e: ReactMouseEvent) => {
    e.stopPropagation()
    void run.call(bridge, name).catch(() => {})
  }
  return <span className="window-controls popout-window-controls" role="group" aria-label="Window controls"
    onPointerDown={stop}>
    <button type="button" className="window-control" aria-label="Minimize window" title="Minimize window"
      onClick={act(bridge.minimizePopout)}><MinimizeIcon fontSize="inherit" /></button>
    <button type="button" className="window-control" aria-label={maximized ? 'Restore window' : 'Maximize window'}
      title={maximized ? 'Restore window' : 'Maximize window'}
      onClick={act(bridge.toggleMaximizePopout)}>
      {maximized ? <RestoreIcon fontSize="inherit" /> : <MaximizeIcon fontSize="inherit" />}
    </button>
    <button type="button" className="window-control close" aria-label="Close window" title="Close window"
      onClick={act(bridge.closePopout)}><CloseIcon fontSize="inherit" /></button>
  </span>
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
  anchor, onDetached, flush, restore }: {
  kind: string; title: ReactNode; org?: string | null; editable?: boolean
  children: ReactNode; anchor?: HTMLElement | null; restore?: WindowRestore
  onDetached?: (detached: boolean) => void; flush?: () => void
}) {
  const parent = useSurface()
  const layoutKey = windowLayoutKey(kind, org)
  const restoreAllowed = useRestoreWindows()
  const restored = useRef(false)
  const placeholder = useRef<HTMLDivElement>(null)
  const [parts] = useState(() => {
    const container = document.createElement('div'); container.className = 'movable-surface'
    const content = document.createElement('div'); content.className = 'movable-content'
    const overlays = document.createElement('div'); overlays.className = 'movable-overlays'
    container.append(content)
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
  const latest = useRef({ anchor, parent, onDetached, flush, org, title, restore })
  latest.current = { anchor, parent, onDetached, flush, org, title, restore }
  const fallback = useRef<HTMLElement | null>(null)
  const initialOwner = useRef(owner)
  const popoutName = useRef('')
  if (!popoutName.current) popoutName.current = `orgtree-popout-${++popoutSeq}`

  // The emergency box is a LAST RESORT, held only while nothing else can
  // host the surface. The moment any real destination is found — here or in
  // the reattach effect below — the stale box must go with it: left in
  // place, its `fixed; inset: 40px` covers nearly the whole window and traps
  // every click until this component fully unmounts (an org switch), even
  // though the surface itself already moved out of it.
  const discardFallback = () => { fallback.current?.remove(); fallback.current = null }
  // NOT a pure query (redteam-opus): finding a real destination discards the
  // stale fallback as a side effect, so this must only be called where the
  // result is about to be placed into, never to just ask where the surface
  // would go — that would silently destroy a live box.
  const claimDestination = () => {
    const a = latest.current.anchor === undefined ? placeholder.current : latest.current.anchor
    if (a?.isConnected) { discardFallback(); return a }
    const overlay = latest.current.parent?.overlays
    if (overlay?.isConnected) { discardFallback(); return overlay }
    if (!fallback.current) {
      fallback.current = document.createElement('div')
      fallback.current.className = 'popout-recovery'
      document.body.appendChild(fallback.current)
    }
    return fallback.current
  }
  const place = (target: HTMLElement) => {
    if (fallback.current && fallback.current !== target) discardFallback()
    target.appendChild(parts.container)
    // Dialogs follow the document, outside any pin stacking context.
    target.ownerDocument.body.appendChild(parts.overlays)
  }
  const redock = () => {
    const restore = pendingRestore.current ?? preservePosition(parts.container)
    pendingRestore.current = null
    epoch.current++
    const w = child.current; child.current = null
    if (w && !w.closed) captureWindow(layoutKey, kind, org, w, true, latest.current.restore)
    closeSavedWindow(layoutKey)
    for (const fn of cleanups.current.splice(0).reverse()) { try { fn() } catch { /* cleanup is idempotent */ } }
    place(claimDestination())
    initialOwner.current = document
    parts.container.classList.remove('detached')
    setOwner(parts.container.ownerDocument); setDetached(false)
    latest.current.onDetached?.(false)
    restore()
    try { if (w && !w.closed) w.close() } catch { /* user navigated */ }
  }

  /** Bring an already-open popout back into view.
   *
   *  `child.focus()` is the browser's own answer and is kept for a plain
   *  browser, but in the packaged app it is NOT enough: a renderer cannot
   *  restore or raise the native window it opened, so a minimized popout
   *  stayed minimized and the placeholder's "Show desk" looked dead (user
   *  report 2026-09-11; measured in tests/placeholder-actions.probe.ts).
   *  The frame name is the only handle on that window — see popoutRegistry
   *  in main/windows.ts. */
  const reveal = () => {
    child.current?.focus()
    try { void desktop()?.focusPopout?.(popoutName.current)?.catch(() => {}) } catch { /* no native host */ }
  }

  const open = () => {
    if (child.current && !child.current.closed) { reveal(); return }
    const transaction = ++epoch.current
    const restore = preservePosition(parts.container)
    let w: Window | null = null
    try {
      // Opening MUST be inside the initiating click, before any await.
      // NAMED, not '_blank': the main process pairs this name to the native
      // window in did-create-window, and it is the only thing that lets this
      // surface's own header command its own window.
      w = owner.defaultView!.open('', popoutName.current, popupFeatures(layoutKey))
      if (!w) throw new Error('The browser blocked this window. Allow pop-ups for this site and try again.')
      child.current = w
      const d = w.document
      // A newly opened about:blank document starts in quirks mode. Parse a
      // static standards-mode shell before adopting any app DOM or listeners.
      d.open()
      d.write('<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>')
      d.close()
      const onGone = () => { if (epoch.current === transaction) redock() }
      w.addEventListener('pagehide', onGone)
      cleanups.current.push(() => w?.removeEventListener('pagehide', onGone))
      const poll = window.setInterval(() => { if (w?.closed) onGone(); else if (w) captureWindow(layoutKey, kind, org, w, true, latest.current.restore) }, 250)
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
          if (original.tagName === 'LINK') {
            // A history route changes the resolution of a relative href even
            // though the already-loaded stylesheet keeps its original URL.
            // Clone that loaded URL, so /assets never becomes /o/assets.
            const link = original as HTMLLinkElement
            ;(copy as HTMLLinkElement).href = link.sheet?.href || link.href
          }
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
      discardFallback()
      mount.appendChild(parts.container)
      d.body.appendChild(parts.overlays)
      if (w.closed || parts.container.ownerDocument !== d || !mount.contains(parts.container)) throw new Error('The surface could not enter the new window.')
      parts.container.classList.add('detached')
      cleanups.current.push(registerWindow({ id: `${kind}:${transaction}:${Math.random()}`, kind, org,
        editable, window: w, redock, flush: () => { captureWindow(layoutKey, kind, org, w!, true, latest.current.restore); latest.current.flush?.() } }))
      captureWindow(layoutKey, kind, org, w, true, latest.current.restore)
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
      const a = (anchor === undefined ? placeholder.current : anchor) ?? claimDestination()
      if (a) {
        // Modal requests originating in a child open there, even if their
        // React state is owned at App/OrgCanvas level.
        const target = anchor === undefined && initialOwner.current !== document && !parent
          && !initialOwner.current.defaultView?.closed ? initialOwner.current.body : a
        if (parts.container.parentElement !== target) place(target)
        else if (fallback.current && fallback.current !== target) discardFallback()
        setOwner(parts.container.ownerDocument)
        // Descendant layout effects (notably the composer auto-height) must
        // first run in a connected document, not in a detached zero-size box.
        setReady(true)
      }
    }
  }, [anchor, parent?.document, parts])
  useEffect(() => {
    if (!ready || !restoreAllowed || restored.current) return
    restored.current = true
    if (restoredWindows(org).some(r => r.key === layoutKey)) open()
  }, [ready, restoreAllowed, layoutKey, org])
  useEffect(() => () => {
    if (child.current && !child.current.closed) captureWindow(layoutKey, kind, org, child.current, true, latest.current.restore)
    closeSavedWindow(layoutKey)
    epoch.current++
    for (const fn of cleanups.current.splice(0).reverse()) { try { fn() } catch { /* disposed */ } }
    try { child.current?.close() } catch { /* disposed */ }
    child.current = null; parts.container.remove(); parts.overlays.remove(); fallback.current?.remove()
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
        <button onClick={reveal}>Show window</button>
        <button onClick={redock}>Return here</button>
      </DetachedNotice>}
    </div>
    {ready && createPortal(<SurfaceContext.Provider value={{ document: owner, overlays: parts.overlays, detached, name: popoutName.current, open, redock, error }}>
      <div className="movable-events" onPointerDown={detached ? stop : undefined}
        onPointerMove={detached ? stop : undefined} onPointerUp={detached ? stop : undefined}
        onPointerCancel={detached ? stop : undefined} onClick={detached ? stop : undefined}
        onDoubleClick={detached ? stop : undefined} onWheel={detached ? stop : undefined}
        onKeyDown={detached ? stop : undefined} onKeyUp={detached ? stop : undefined}
        onDragStart={detached ? stop : undefined} onDragOver={detached ? stop : undefined}
        onDrop={detached ? stop : undefined} onContextMenu={detached ? stop : undefined}>
        {/* No shell bar of its own: the surface's header is the whole window
            treatment, and it already carries the return-to-main button. */}
        {detached && <RestartNotice />}
        {error && <div role="alert" className="popout-error">{error}</div>}
        {children}
      </div>
    </SurfaceContext.Provider>, parts.content)}
  </>
}
